import { describe, expect, test } from "bun:test";
import {
  COUNTDOWN_TICKS,
  INPUT_LEASE_TICKS,
  MAX_RACERS,
  MAX_RACE_DURATION_TICKS,
  POST_FINISH_TIMEOUT_TICKS,
  SNAPSHOT_INTERVAL_TICKS,
} from "../src/multiplayer-config";
import type { CarProfile, Track } from "../src/race";
import { Room } from "../src/room";

const fastTrack: Track = {
  id: "room-test",
  length: 10,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  startFinish: 0,
  checkpoints: [
    { id: "one", progress: 2 },
    { id: "two", progress: 4 },
    { id: "three", progress: 6 },
  ],
};

const fastProfile: CarProfile = {
  accelerationPerSecondSquared: 3_000,
  topSpeedPerSecond: 3_000,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 3,
};

function createTestRoom(ids: readonly string[] = ["race-1", "race-2"]): Room {
  let index = 0;
  return new Room({
    code: "AB12",
    hostId: "host",
    hostName: "Host",
    track: fastTrack,
    carProfile: fastProfile,
    configuration: { laps: 1 },
    createRaceId: () => ids[index++]!,
  });
}

function advance(room: Room, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) room.advance();
}

function beginRacing(room: Room): string {
  if (room.snapshot().players.length === 1) room.join("zguest", "Guest");
  const raceId = room.startRace("host")!;
  advance(room, COUNTDOWN_TICKS);
  expect(room.phase).toBe("racing");
  return raceId;
}

function finishTwoRacerRace(room: Room, _raceId: string): void {
  advance(room, 2);
  expect(room.phase).toBe("results");
}

describe("Room membership and countdown", () => {
  test("allows two to four Racers while Open and admits a fifth as a Spectator", () => {
    const room = createTestRoom();
    expect(room.join("guest", "Guest").role).toBe("racer");
    room.join("third", "Third");
    room.join("fourth", "Fourth");
    expect(room.join("fifth", "Fifth").role).toBe("spectator");
    expect(room.snapshot().players.filter((player) => player.role === "racer")).toHaveLength(MAX_RACERS);
  });

  test("assigns deterministic unique starting Lanes to four frozen participants", () => {
    const room = createTestRoom();
    room.join("zulu", "Zulu");
    room.join("alpha", "Alpha");
    room.join("mike", "Mike");
    room.startRace("host");

    expect(room.race!.cars.map((value) => [value.id, value.lane])).toEqual([
      ["alpha", 0], ["host", 1], ["mike", 2], ["zulu", 3],
    ]);
    expect(room.join("late", "Late").role).toBe("spectator");
    expect(room.race!.cars).toHaveLength(4);
  });

  test("enforces Host start, makes start idempotent, and freezes participants/configuration", () => {
    const room = createTestRoom();
    room.join("guest", "Guest");
    expect(room.startRace("guest")).toBeNull();
    expect(room.configureRace("host", { laps: 2 })).toBe(true);

    const raceId = room.startRace("host");
    expect(raceId).toBe("race-1");
    expect(room.startRace("host")).toBe(raceId);
    expect(room.phase).toBe("countdown");
    expect(room.snapshot().countdownTicksRemaining).toBe(COUNTDOWN_TICKS);
    expect(room.configureRace("host", { laps: 3 })).toBe(false);
    expect(room.join("late", "Late").role).toBe("spectator");
    expect(room.race!.configuration).toEqual({ laps: 2 });
    expect(room.race!.cars.map((car) => car.id)).toEqual(["guest", "host"]);

    advance(room, COUNTDOWN_TICKS - 1);
    expect(room.phase).toBe("countdown");
    room.advance();
    expect(room.phase).toBe("racing");
    expect(room.race!.tick).toBe(0);
  });
});

describe("Room authoritative input and ticks", () => {
  test("accepts one queued Lane edge and rejects stale or extra edges", () => {
    const room = createTestRoom();
    room.configureRace("host", { laps: 2 });
    const raceId = beginRacing(room);

    expect(room.acceptInput("host", { raceId, seq: 2, laneChange: 1 })).toBe(true);
    expect(room.acceptInput("host", { raceId, seq: 1, laneChange: -1 })).toBe(false);
    expect(room.acceptInput("host", { raceId, seq: 3, laneChange: -1 })).toBe(false);

    room.advance();
    const first = room.race!.cars.find((car) => car.id === "host")!;
    expect(first.speed).toBeGreaterThan(0);
    expect(first.laneTransition).toMatchObject({ from: 0, to: 1 });
    expect(room.snapshot("host").lastProcessedInputSequence).toBe(2);

    room.advance();
    const second = room.race!.cars.find((car) => car.id === "host")!;
    expect(second.speed).toBeGreaterThan(first.speed);
    expect(second.lane).toBe(0);
    expect(second.laneTransition).toBeNull();
  });

  test("rejects Lane intent during Crash recovery while accepting heartbeat liveness", () => {
    const room = new Room({
      code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 99 },
      track: {
        ...fastTrack,
        length: 120,
        checkpoints: [{ id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 }],
        fixedObstacles: [{ id: "block-host", progress: 1, lane: 0 }],
      },
      carProfile: { ...fastProfile, accelerationPerSecondSquared: 1_800, topSpeedPerSecond: 60 },
      createRaceId: () => "race-1",
    });
    const raceId = beginRacing(room);
    room.advance();

    expect(room.race!.cars.find((car) => car.id === "host")!.crashRecoveryTicksRemaining).toBeGreaterThan(0);
    expect(room.acceptInput("host", { raceId, seq: 1, laneChange: 1 })).toBe(false);
    expect(room.acceptInput("host", { raceId, seq: 1 })).toBe(true);
  });

  test("advances serially and marks snapshots due at 15 Hz on the 30 Hz tick", () => {
    const room = createTestRoom();
    room.configureRace("host", { laps: 99 });
    beginRacing(room);
    const before = room.race!.tick;

    const cadence = Array.from({ length: SNAPSHOT_INTERVAL_TICKS * 2 }, () => room.advance().snapshotDue);
    expect(room.race!.tick).toBe(before + cadence.length);
    expect(cadence.filter(Boolean)).toHaveLength(2);
  });

  test("does not enter Results while a participating Car is still racing", () => {
    const room = new Room({
      code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 1 },
      track: { ...fastTrack, fixedObstacles: [{ id: "block-guest", progress: 1, lane: 0 }] },
      carProfile: fastProfile,
      createRaceId: () => "race-1",
    });
    room.join("guest", "Guest");
    const raceId = beginRacing(room);

    advance(room, 2);
    expect(room.race!.cars.find((car) => car.id === "host")!.result).toBe("finished");
    expect(room.race!.cars.find((car) => car.id === "guest")!.result).toBe("racing");
    expect(room.phase).toBe("racing");
    expect(room.acceptInput("host", { raceId, seq: 1, laneChange: 1 })).toBe(false);
    expect(room.acceptInput("host", { raceId, seq: 1 })).toBe(true);
  });
});

describe("Room disconnect and bounded Results policy", () => {
  test("known disconnect immediately clears control and rejects further human input", () => {
    const room = new Room({ code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 99 }, createRaceId: () => "race-1" });
    room.join("guest", "Guest");
    const raceId = beginRacing(room);
    room.acceptInput("host", { raceId, seq: 1, laneChange: 1 });
    room.disconnect("host");

    expect(room.acceptInput("host", { raceId, seq: 2 })).toBe(false);
    room.advance();
    const host = room.snapshot().players.find((value) => value.id === "host")!;
    expect(host.connected).toBe(false);
    expect(host.controller).toBe("bot");
    expect(host.raceSeatId).toBe("host");
  });

  test("input lease transfers a silent half-open Racer to a Bot", () => {
    const room = new Room({ code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 99 }, createRaceId: () => "race-1" });
    room.join("guest", "Guest");
    const raceId = beginRacing(room);
    room.acceptInput("host", { raceId, seq: 1 });
    advance(room, INPUT_LEASE_TICKS + 60);

    expect(room.snapshot().players.find((value) => value.id === "host")!.controller).toBe("bot");
  });

  test("input heartbeats keep an idle connected human Racer in control", () => {
    const room = new Room({ code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 99 }, createRaceId: () => "race-1" });
    room.join("guest", "Guest");
    const raceId = beginRacing(room);

    for (let sequence = 1; sequence <= 4; sequence += 1) {
      advance(room, INPUT_LEASE_TICKS / 2);
      expect(room.snapshot().players.find((value) => value.id === "host")!.controller).toBe("human");
      expect(room.acceptInput("host", { raceId, seq: sequence })).toBe(true);
    }
  });

  test("first finisher starts a timeout that marks an obstructed Bot Car DNF", () => {
    const room = new Room({
      code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 1 },
      track: {
        ...fastTrack,
        length: 100,
        checkpoints: [{ id: "one", progress: 20 }, { id: "two", progress: 40 }, { id: "three", progress: 60 }],
        fixedObstacles: [
          { id: "block-guest", progress: 10, lane: 0 },
          { id: "block-escape", progress: 10, lane: 1 },
        ],
      },
      carProfile: { ...fastProfile, accelerationPerSecondSquared: 9, topSpeedPerSecond: 0.3 },
      createRaceId: () => "race-1",
    });
    room.join("guest", "Guest");
    const raceId = beginRacing(room);
    room.acceptInput("host", { raceId, seq: 1, laneChange: 1 });
    while (room.race!.cars.find((value) => value.id === "host")!.result === "racing") room.advance();
    expect(room.race!.cars.find((value) => value.id === "host")!.result).toBe("finished");

    advance(room, POST_FINISH_TIMEOUT_TICKS);
    expect(room.phase).toBe("results");
    expect(room.race!.cars.find((value) => value.id === "guest")!.result).toBe("dnf");
  });

  test("absolute maximum duration bounds an obstructed Race and permits a fresh rematch", () => {
    const room = new Room({
      code: "AB12", hostId: "host", hostName: "Host", configuration: { laps: 99 },
      track: { ...fastTrack, fixedObstacles: ([0, 1, 2, 3] as const).map((lane) => ({ id: `block-${lane}`, progress: 1, lane })) },
      carProfile: { ...fastProfile, accelerationPerSecondSquared: 9, topSpeedPerSecond: 0.3 },
      createRaceId: (() => {
      let id = 0;
        return () => `race-${++id}`;
      })(),
    });
    room.join("guest", "Guest");
    const raceId = beginRacing(room);
    advance(room, MAX_RACE_DURATION_TICKS);

    expect(room.phase).toBe("results");
    expect(room.race!.cars.map((value) => value.result)).toEqual(["dnf", "dnf"]);
    expect(room.acceptInput("host", { raceId, seq: 1, laneChange: 1 })).toBe(false);
    expect(room.rematch("host", raceId)).toBe(true);
    expect(room.raceId).not.toBe(raceId);
  });
});

describe("Room rematches", () => {
  test("returns Results to Open, creates a fresh stable Race id, and ignores old-Race input", () => {
    const room = createTestRoom();
    room.join("guest", "Guest");
    const firstRaceId = beginRacing(room);
    finishTwoRacerRace(room, firstRaceId);

    expect(room.rematch("guest", firstRaceId)).toBe(false);
    expect(room.rematch("host", "wrong-race")).toBe(false);
    expect(room.rematch("host", firstRaceId)).toBe(true);
    expect(room.phase).toBe("open");
    expect(room.raceId).toBe("race-2");

    const secondRaceId = room.startRace("host")!;
    expect(secondRaceId).toBe("race-2");
    expect(secondRaceId).not.toBe(firstRaceId);
    expect(room.startRace("host")).toBe(secondRaceId);
    expect(room.race).toMatchObject({ hazards: [], powerUpLap: 0, nextHazardSequence: 0 });
    expect(room.race!.cars.every((car) => car.crashRecoveryTicksRemaining === 0
      && !car.ghost
      && car.shieldTicksRemaining === 0
      && car.boostTicksRemaining === 0)).toBe(true);
    expect(room.acceptInput("host", { raceId: firstRaceId, seq: 99 })).toBe(false);
    expect(room.snapshot("host").lastProcessedInputSequence).toBe(-1);

    advance(room, COUNTDOWN_TICKS);
    room.advance();
    expect(room.race!.cars.find((car) => car.id === "host")!.speed).toBeGreaterThan(0);
  });
});

describe("Room Boost spending", () => {
  /** Puts a charge on a Car by hand: the Room owns the Race, so this is the seam to use. */
  function giveCharge(room: Room, carId: string, charges: number): void {
    const race = room.race!;
    Reflect.set(room as unknown as Record<string, unknown>, "raceValue", {
      ...race,
      cars: race.cars.map((car) => (car.id === carId ? { ...car, boostCharges: charges } : car)),
    });
  }

  test("rejects a spend from a Car with no charge, and accepts one that holds it", () => {
    const room = createTestRoom();
    room.configureRace("host", { laps: 2 });
    const raceId = beginRacing(room);

    expect(room.acceptInput("host", { raceId, seq: 1, useBoost: true })).toBe(false);

    giveCharge(room, "host", 1);
    expect(room.acceptInput("host", { raceId, seq: 2, useBoost: true })).toBe(true);

    room.advance();
    const car = room.race!.cars.find((candidate) => candidate.id === "host")!;
    expect(car.boostCharges).toBe(0);
    expect(car.boostTicksRemaining).toBeGreaterThan(0);
  });

  test("rejects a second spend while a Boost is already running", () => {
    const room = createTestRoom();
    room.configureRace("host", { laps: 2 });
    const raceId = beginRacing(room);

    giveCharge(room, "host", 2);
    expect(room.acceptInput("host", { raceId, seq: 1, useBoost: true })).toBe(true);
    room.advance();
    expect(room.race!.cars.find((candidate) => candidate.id === "host")!.boostTicksRemaining).toBeGreaterThan(0);

    // The charge is still held, but it cannot be chained onto the running Boost.
    expect(room.acceptInput("host", { raceId, seq: 2, useBoost: true })).toBe(false);
    expect(room.race!.cars.find((candidate) => candidate.id === "host")!.boostCharges).toBe(1);
  });

  test("carries a Lane edge and a spend in the same accepted input", () => {
    const room = createTestRoom();
    room.configureRace("host", { laps: 2 });
    const raceId = beginRacing(room);

    giveCharge(room, "host", 1);
    expect(room.acceptInput("host", { raceId, seq: 1, laneChange: 1, useBoost: true })).toBe(true);
    room.advance();

    const car = room.race!.cars.find((candidate) => candidate.id === "host")!;
    expect(car.laneTransition).toMatchObject({ from: 0, to: 1 });
    expect(car.boostCharges).toBe(0);
  });

  test("a queued spend is dropped when control changes to a Bot", () => {
    const room = createTestRoom();
    room.configureRace("host", { laps: 2 });
    const raceId = beginRacing(room);

    giveCharge(room, "host", 1);
    expect(room.acceptInput("host", { raceId, seq: 1, useBoost: true })).toBe(true);
    room.disconnect("host");
    room.advance();

    // Rule 7: every controller transition clears queued input, the spend included.
    expect(room.race!.cars.find((candidate) => candidate.id === "host")!.boostCharges).toBe(1);
  });
});
