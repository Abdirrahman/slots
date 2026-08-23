import { describe, expect, test } from "bun:test";
import {
  COUNTDOWN_TICKS,
  MAX_RACE_DURATION_TICKS,
  type SoloRaceConfiguration,
} from "../src/multiplayer-config";
import { PROVISIONAL_DURATIONS, type CarProfile, type RaceEvent, type Track } from "../src/race";
import { Room } from "../src/room";

const track: Track = {
  id: "solo-room",
  length: 120,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  startFinish: 0,
  checkpoints: [
    { id: "one", progress: 30 },
    { id: "two", progress: 60 },
    { id: "three", progress: 90 },
  ],
  fixedObstacles: [],
  powerUpOpportunities: [],
  hazardPlacementLocations: [],
};

const profile: CarProfile = {
  accelerationPerSecondSquared: 3_600,
  topSpeedPerSecond: 120,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 3,
};

function createSoloRoom(
  soloConfiguration: SoloRaceConfiguration = { botCount: 2, botDifficulty: "normal" },
  options: { readonly raceTrack?: Track; readonly carProfile?: CarProfile; readonly laps?: number } = {},
): Room {
  let race = 0;
  return new Room({
    code: "AB12",
    hostId: "host",
    hostName: "Human",
    track: options.raceTrack ?? track,
    carProfile: options.carProfile ?? profile,
    configuration: { laps: options.laps ?? 1 },
    soloConfiguration,
    createRaceId: () => `race-${++race}`,
    createReconnectToken: (() => {
      let token = 0;
      return () => `s${(++token).toString(36).padStart(42, "0")}`;
    })(),
  });
}

function advance(room: Room, ticks: number): RaceEvent[] {
  const events: RaceEvent[] = [];
  for (let tick = 0; tick < ticks; tick += 1) events.push(...room.advance().events);
  return events;
}

function start(room: Room): string {
  const raceId = room.startRace("host")!;
  advance(room, COUNTDOWN_TICKS);
  expect(room.phase).toBe("racing");
  return raceId;
}

describe("Solo Room configured Bot Race seats", () => {
  test("rejects invalid Solo configuration at the Room seam", () => {
    for (const botCount of [0, 4, 1.5]) {
      expect(() => createSoloRoom({ botCount, botDifficulty: "normal" })).toThrow("Solo Bot count");
    }
    expect(() => createSoloRoom({ botCount: 1, botDifficulty: "unknown" } as unknown as SoloRaceConfiguration))
      .toThrow("Solo Bot difficulty");
  });

  test("starts one human with one to three configured Bots without making Bots Players", () => {
    for (const botCount of [1, 2, 3]) {
      const soloConfiguration = { botCount, botDifficulty: "hard" as const };
      const room = createSoloRoom(soloConfiguration);
      const open = room.snapshot("host");

      expect(open.players).toHaveLength(1);
      expect(open.players[0]).toMatchObject({ id: "host", role: "racer", isHost: true });
      expect(open.soloConfiguration).toEqual(soloConfiguration);
      expect(open.configuredBots).toEqual(Array.from({ length: botCount }, (_, index) => ({
        id: `configured-bot-${index + 1}`,
        name: `Bot ${index + 1}`,
      })));
      expect(open.configuredBots.every((bot) => !open.players.some((player) => player.id === bot.id))).toBe(true);
      for (const bot of open.configuredBots) {
        expect(room.connectionIdentity(bot.id)).toBeNull();
        expect(room.isActiveConnection(bot.id, 1)).toBe(false);
        expect(room.disconnect(bot.id)).toBe(false);
      }

      expect(room.startRace("host")).toBe("race-1");
      expect(room.race!.cars).toHaveLength(1 + botCount);
      expect(room.race!.cars.length).toBeLessThanOrEqual(4);
      expect(room.race!.cars.map((car) => car.id).sort()).toEqual([
        "host",
        ...open.configuredBots.map((bot) => bot.id),
      ].sort());
      expect(room.acceptInput("configured-bot-1", { raceId: "race-1", seq: 1, laneChange: 1 })).toBe(false);
    }
  });

  test("keeps multiplayer minimum start behavior and rejects all attempts to join a Solo Room", () => {
    const multiplayer = new Room({ code: "MP12", hostId: "host", hostName: "Host", createRaceId: () => "race-1" });
    expect(multiplayer.startRace("host")).toBeNull();
    expect(multiplayer.join("guest", "Guest").role).toBe("racer");
    expect(multiplayer.startRace("host")).toBe("race-1");

    const solo = createSoloRoom();
    expect(() => solo.join("guest", "Guest")).toThrow("Solo Rooms do not accept joins");
    expect(solo.snapshot().players).toHaveLength(1);
  });

  test("uses configured Bots in ordinary collisions, pickups, Crash, recovery, and automatic movement", () => {
    const interactionTrack: Track = {
      ...track,
      fixedObstacles: ([0, 1, 2, 3] as const).map((lane) => ({ id: `obstacle-${lane}`, progress: 2, lane })),
      powerUpOpportunities: [{ id: "shield", progress: 1, allowedEffects: ["shield"] }],
    };
    const room = createSoloRoom({ botCount: 3, botDifficulty: "hard" }, {
      raceTrack: interactionTrack,
      carProfile: { ...profile, accelerationPerSecondSquared: 1_800, topSpeedPerSecond: 60 },
      laps: 99,
    });
    const raceId = start(room);
    const before = room.race!.cars;
    expect(before.every((car) => car.speed === 0)).toBe(true);

    expect(room.acceptInput("host", { raceId, seq: 1, laneChange: -1 })).toBe(true);
    const interaction = room.advance();
    expect(interaction.events).toContainEqual(expect.objectContaining({ type: "blocked_lane_change", carId: "host" }));
    expect(interaction.events).toContainEqual(expect.objectContaining({ type: "power_up_collected", carId: "configured-bot-2" }));
    expect(interaction.events).toContainEqual(expect.objectContaining({ type: "shield_consumed", carId: "configured-bot-2" }));
    expect(interaction.events.some((event) => event.type === "crash" && event.carId.startsWith("configured-bot-"))).toBe(true);
    expect(room.race!.cars.every((car) => car.speed > 0 || car.crashRecoveryTicksRemaining > 0)).toBe(true);

    const recovery = advance(room, PROVISIONAL_DURATIONS.crashRecoveryTicks);
    expect(recovery.some((event) => event.type === "respawn" && event.carId.startsWith("configured-bot-"))).toBe(true);
  });

  test("attributes configured Bot results and DNF through ordinary bounded Race rules", () => {
    const room = createSoloRoom({ botCount: 3, botDifficulty: "easy" }, {
      carProfile: { ...profile, accelerationPerSecondSquared: 0, topSpeedPerSecond: 0 },
      laps: 99,
    });
    start(room);
    advance(room, MAX_RACE_DURATION_TICKS);

    expect(room.phase).toBe("results");
    expect(room.race!.cars).toHaveLength(4);
    expect(room.race!.cars.every((car) => car.result === "dnf")).toBe(true);
    expect(room.snapshot().configuredBots.map((bot) => bot.name)).toEqual(["Bot 1", "Bot 2", "Bot 3"]);
  });

  test("keeps configured Bot identities and options across rematch while old-Race input stays harmless", () => {
    const room = createSoloRoom({ botCount: 2, botDifficulty: "easy" }, {
      raceTrack: { ...track, length: 10, checkpoints: [
        { id: "one", progress: 2 }, { id: "two", progress: 4 }, { id: "three", progress: 6 },
      ] },
      carProfile: { ...profile, accelerationPerSecondSquared: 3_000, topSpeedPerSecond: 3_000 },
    });
    const configuredBots = room.snapshot().configuredBots;
    const firstRaceId = start(room);
    advance(room, 5);
    expect(room.phase).toBe("results");
    expect(room.snapshot("host").players[0]!.bestTimeEligible).toBe(true);

    expect(room.rematch("host", firstRaceId)).toBe(true);
    const open = room.snapshot("host");
    expect(open.raceId).toBe("race-2");
    expect(open.soloConfiguration).toEqual({ botCount: 2, botDifficulty: "easy" });
    expect(open.configuredBots).toEqual(configuredBots);
    expect(room.acceptInput("host", { raceId: firstRaceId, seq: 99, laneChange: 1 })).toBe(false);

    expect(room.startRace("host")).toBe("race-2");
    expect(room.race!.cars.map((car) => car.id).sort()).toEqual(["configured-bot-1", "configured-bot-2", "host"]);
  });

  test("marks a countdown controller transfer ineligible for best time", () => {
    const room = createSoloRoom();
    room.startRace("host");
    const identity = room.connectionIdentity("host")!;
    room.disconnect("host", identity.connectionGeneration);
    room.reconnect(identity.reconnectToken);
    expect(room.snapshot("host").players[0]).toMatchObject({ controller: "bot", bestTimeEligible: false });
  });

  test("preserves configured Bot Cars through human disconnect, takeover, reconnect, and Checkpoint reclaim", () => {
    const room = createSoloRoom({ botCount: 2, botDifficulty: "normal" }, { laps: 99 });
    const raceId = start(room);
    const bots = room.snapshot().configuredBots.map((bot) => bot.id);
    const identity = room.connectionIdentity("host")!;

    expect(room.disconnect("host", identity.connectionGeneration)).toBe(true);
    room.advance();
    expect(room.snapshot().players[0]).toMatchObject({ controller: "bot", connected: false, raceSeatId: "host", bestTimeEligible: false });
    expect(bots.every((id) => room.race!.cars.some((car) => car.id === id))).toBe(true);

    const reconnected = room.reconnect(identity.reconnectToken)!;
    expect(room.snapshot("host").players[0]).toMatchObject({ controller: "bot", reclaimPending: true, connected: true });
    expect(room.acceptInput("host", reconnected.connectionGeneration, { raceId, seq: 1, laneChange: 1 })).toBe(false);

    for (let tick = 0; tick < 100 && room.snapshot("host").players[0]!.controller !== "human"; tick += 1) room.advance();
    expect(room.snapshot("host").players[0]).toMatchObject({ controller: "human", reclaimPending: false });
    expect(room.race!.cars.map((car) => car.id).filter((id) => id.startsWith("configured-bot-"))).toEqual(bots);
  });
});
