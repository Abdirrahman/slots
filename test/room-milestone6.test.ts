import { describe, expect, test } from "bun:test";
import {
  COUNTDOWN_TICKS,
  EMPTY_ROOM_EXPIRATION_MS,
  INPUT_LEASE_TICKS,
  MAX_CONNECTION_GENERATION,
  MAX_RACERS,
  MAX_SPECTATORS,
  RECONNECT_RESERVATION_MS,
} from "../src/multiplayer-config";
import {
  PROVISIONAL_DURATIONS,
  type CarProfile,
  type RaceEvent,
  type Track,
} from "../src/race";
import { Room } from "../src/room";

const track: Track = {
  id: "milestone-6-room",
  length: 12,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  startFinish: 0,
  checkpoints: [
    { id: "one", progress: 3 },
    { id: "two", progress: 6 },
    { id: "three", progress: 9 },
  ],
};

const profile: CarProfile = {
  accelerationPerSecondSquared: 3_600,
  topSpeedPerSecond: 3_600,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 3,
};

function tokenFactory(prefix = "t"): () => string {
  let sequence = 0;
  return () => `${prefix}${(++sequence).toString(36).padStart(42, "0")}`;
}

function clock(start = 1_000): { now: () => number; advance: (milliseconds: number) => void } {
  let value = start;
  return { now: () => value, advance: (milliseconds) => { value += milliseconds; } };
}

function room(options: {
  prefix?: string;
  now?: () => number;
  raceIds?: readonly string[];
  raceTrack?: Track;
  carProfile?: CarProfile;
  laps?: number;
} = {}): Room {
  let race = 0;
  return new Room({
    code: "AB12",
    hostId: "host",
    hostName: "Host",
    track: options.raceTrack ?? track,
    carProfile: options.carProfile ?? profile,
    configuration: { laps: options.laps ?? 1 },
    createRaceId: () => {
      const raceId = options.raceIds?.[race] ?? `race-${race + 1}`;
      race += 1;
      return raceId;
    },
    createReconnectToken: tokenFactory(options.prefix),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function advance(value: Room, ticks: number): RaceEvent[] {
  const events: RaceEvent[] = [];
  for (let tick = 0; tick < ticks; tick += 1) events.push(...value.advance().events);
  return events;
}

function start(value: Room): string {
  if (value.snapshot().players.length === 1) value.join("guest", "Guest");
  const raceId = value.startRace(value.hostId)!;
  advance(value, COUNTDOWN_TICKS);
  expect(value.phase).toBe("racing");
  return raceId;
}

function player(value: Room, id: string) {
  return value.snapshot(id).players.find((candidate) => candidate.id === id)!;
}

function finish(value: Room, _raceId: string): void {
  for (let tick = 0; tick < 10 && value.phase === "racing"; tick += 1) value.advance();
  expect(value.phase).toBe("results");
}

describe("Milestone 6 reconnect identity and credentials", () => {
  test("keeps Player, Race seat, and Car identity through Open, Countdown, Racing, and Results reconnects", () => {
    const value = room();
    value.join("guest", "Guest");

    let identity = value.connectionIdentity("guest")!;
    expect(value.disconnect("guest", identity.connectionGeneration)).toBe(true);
    identity = value.reconnect(identity.reconnectToken)!;
    expect(player(value, "guest")).toMatchObject({ id: "guest", raceSeatId: "guest", connected: true });

    const raceId = value.startRace("host")!;
    const carBefore = value.race!.cars.find((car) => car.id === "guest")!;
    expect(value.disconnect("guest", identity.connectionGeneration)).toBe(true);
    identity = value.reconnect(identity.reconnectToken)!;
    expect(value.race!.cars.find((car) => car.id === "guest")).toBe(carBefore);
    expect(player(value, "guest")).toMatchObject({ raceSeatId: "guest", controller: "bot", reclaimPending: true });

    advance(value, COUNTDOWN_TICKS);
    value.advance();
    expect(player(value, "guest")).toMatchObject({ controller: "human", reclaimPending: false });
    expect(value.disconnect("guest", identity.connectionGeneration)).toBe(true);
    value.advance();
    identity = value.reconnect(identity.reconnectToken)!;
    expect(value.raceId).toBe(raceId);
    expect(value.race!.cars.map((car) => car.id)).toContain("guest");

    finish(value, raceId);
    expect(value.disconnect("guest", identity.connectionGeneration)).toBe(true);
    identity = value.reconnect(identity.reconnectToken)!;
    expect(player(value, "guest")).toMatchObject({ raceSeatId: "guest", controller: "none", connected: true });
    expect(value.race!.cars.find((car) => car.id === "guest")!.id).toBe("guest");
  });

  test("scopes tokens to a Room, rotates them, increments generations, and rejects stale or duplicate credentials", () => {
    const first = room({ prefix: "a" });
    const other = room({ prefix: "b" });
    const original = first.connectionIdentity("host")!;

    expect(other.reconnect(original.reconnectToken)).toBeNull();
    expect(first.disconnect("host", original.connectionGeneration + 1)).toBe(false);
    expect(first.disconnect("host", original.connectionGeneration)).toBe(true);
    const reconnected = first.reconnect(original.reconnectToken)!;
    expect(reconnected).toMatchObject({ playerId: "host", connectionGeneration: original.connectionGeneration + 1 });
    expect(reconnected.reconnectToken).not.toBe(original.reconnectToken);
    expect(first.reconnect(original.reconnectToken)).toBeNull();
    expect(first.isActiveConnection("host", original.connectionGeneration)).toBe(false);
    expect(first.isActiveConnection("host", reconnected.connectionGeneration)).toBe(true);
  });

  test("rejects expired reservations and the maximum generation with an injected clock", () => {
    const time = clock();
    const expired = room({ now: time.now });
    const credential = expired.connectionIdentity("host")!;
    expired.disconnect("host", credential.connectionGeneration);
    time.advance(RECONNECT_RESERVATION_MS - 1);
    expect(expired.reconnect(credential.reconnectToken)).not.toBeNull();

    const expiring = room({ now: time.now, prefix: "e" });
    const old = expiring.connectionIdentity("host")!;
    expiring.disconnect("host", old.connectionGeneration);
    time.advance(RECONNECT_RESERVATION_MS);
    expect(expiring.reconnect(old.reconnectToken)).toBeNull();
    expect(expiring.snapshot().players).toEqual([]);

    const capped = room({ prefix: "m" });
    const cappedIdentity = capped.connectionIdentity("host")!;
    const records = (capped as unknown as { players: Map<string, { connectionGeneration: number }> }).players;
    records.get("host")!.connectionGeneration = MAX_CONNECTION_GENERATION;
    capped.disconnect("host", MAX_CONNECTION_GENERATION);
    expect(capped.reconnect(cappedIdentity.reconnectToken)).toBeNull();
  });
});

describe("Milestone 6 controller boundaries", () => {
  test("known disconnect changes to Bot on exactly the next advance and clears Lane intent", () => {
    const dirty = room({ laps: 99 });
    const clean = room({ laps: 99 });
    const dirtyRace = start(dirty);
    const cleanRace = start(clean);
    expect(dirtyRace).toBe(cleanRace);

    dirty.acceptInput("host", { raceId: dirtyRace, seq: 1, laneChange: 1 });
    const generation = dirty.connectionIdentity("host")!.connectionGeneration;
    dirty.disconnect("host", generation);
    clean.disconnect("host", clean.connectionIdentity("host")!.connectionGeneration);
    expect(player(dirty, "host").controller).toBe("human");

    const dirtyAdvance = dirty.advance();
    const cleanAdvance = clean.advance();
    expect(player(dirty, "host")).toMatchObject({ controller: "bot", bestTimeEligible: false });
    expect(dirty.race).toEqual(clean.race);
    expect(dirtyAdvance.events).toEqual(cleanAdvance.events);
  });

  test("expires a silent human lease at the exact tick", () => {
    const value = room({
      laps: 99,
      raceTrack: { ...track, length: 120, checkpoints: [
        { id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 },
      ] },
      carProfile: { ...profile, accelerationPerSecondSquared: 1, topSpeedPerSecond: 1 },
    });
    const raceId = start(value);
    value.acceptInput("host", { raceId, seq: 1 });

    advance(value, INPUT_LEASE_TICKS - 1);
    expect(player(value, "host").controller).toBe("human");
    value.advance();
    expect(player(value, "host").controller).toBe("bot");
  });

  test("accepts a fresh input sequence after a new connection generation reclaims control", () => {
    const value = room({ laps: 99 });
    value.join("guest", "Guest");
    const raceId = value.startRace("host")!;
    const old = value.connectionIdentity("host")!;
    expect(value.acceptInput("host", old.connectionGeneration, { raceId, seq: 20 })).toBe(true);
    expect(value.disconnect("host", old.connectionGeneration)).toBe(true);
    const connected = value.reconnect(old.reconnectToken)!;

    advance(value, COUNTDOWN_TICKS);
    value.advance();

    expect(player(value, "host")).toMatchObject({ controller: "human", reclaimPending: false });
    expect(value.acceptInput("host", connected.connectionGeneration, { raceId, seq: 1 })).toBe(true);
    expect(value.snapshot("host").lastProcessedInputSequence).toBe(1);
  });

  test("defers reclaim to the recorded checkpoint boundary, ignores pending input, and clears stale intent", () => {
    const reclaimTrack: Track = { ...track, length: 120, checkpoints: [
      { id: "one", progress: 3 }, { id: "two", progress: 60 }, { id: "three", progress: 90 },
    ] };
    const reclaimProfile: CarProfile = { ...profile, accelerationPerSecondSquared: 900, topSpeedPerSecond: 90 };
    const value = room({ raceTrack: reclaimTrack, carProfile: reclaimProfile, laps: 99 });
    const raceId = start(value);
    const old = value.connectionIdentity("host")!;
    value.acceptInput("host", { raceId, seq: 1, laneChange: 1 });
    value.disconnect("host", old.connectionGeneration);
    value.advance();
    const connected = value.reconnect(old.reconnectToken)!;

    expect(player(value, "host")).toMatchObject({ controller: "bot", reclaimPending: true });
    expect(value.acceptInput("host", connected.connectionGeneration, { raceId, seq: 2, laneChange: -1 })).toBe(false);
    const boundaryEvents = value.advance().events;
    expect(boundaryEvents).toContainEqual(expect.objectContaining({ type: "checkpoint", carId: "host", checkpointId: "one" }));
    expect(player(value, "host")).toMatchObject({ controller: "bot", reclaimPending: true });

    value.advance();
    expect(player(value, "host")).toMatchObject({ controller: "human", reclaimPending: false });
    expect(value.race!.cars.find((car) => car.id === "host")!.laneTransition).toBeNull();
    expect(value.acceptInput("host", connected.connectionGeneration, { raceId, seq: 2 })).toBe(true);
  });

  test("replays controller transitions deterministically while effects, Crash recovery, Respawn, and Ghost state survive reconnect", () => {
    const interactionTrack: Track = {
      ...track,
      length: 120,
      checkpoints: [{ id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 }],
      fixedObstacles: ([0, 1, 2, 3] as const).map((lane) => ({ id: `obstacle-${lane}`, progress: 10, lane })),
      powerUpOpportunities: [{ id: "shield", progress: 10, allowedEffects: ["shield"] }],
      hazardPlacementLocations: [],
    };
    const interactionProfile: CarProfile = { ...profile, accelerationPerSecondSquared: 18_000, topSpeedPerSecond: 600 };
    const first = room({ raceTrack: interactionTrack, carProfile: interactionProfile, laps: 99 });
    const replay = room({ raceTrack: interactionTrack, carProfile: interactionProfile, laps: 99 });
    const firstRace = start(first);
    const replayRace = start(replay);
    for (const value of [first, replay]) {
      value.acceptInput("host", { raceId: value === first ? firstRace : replayRace, seq: 1 });
      value.acceptInput("guest", { raceId: value === first ? firstRace : replayRace, seq: 1 });
    }
    const firstInteraction = first.advance();
    const replayInteraction = replay.advance();
    expect(firstInteraction).toEqual(replayInteraction);
    expect(first.race).toEqual(replay.race);
    expect(firstInteraction.events.some((event) => event.type === "power_up_collected" && event.effect === "shield")).toBe(true);
    expect(first.race!.powerUpOpportunities.some((opportunity) => opportunity.collected)).toBe(true);
    expect(first.race!.cars.some((car) => car.crashRecoveryTicksRemaining === PROVISIONAL_DURATIONS.crashRecoveryTicks)).toBe(true);

    const credentials = [first, replay].map((value) => value.connectionIdentity("host")!);
    first.disconnect("host", credentials[0]!.connectionGeneration);
    replay.disconnect("host", credentials[1]!.connectionGeneration);
    expect(first.advance()).toEqual(replay.advance());
    const reconnected = [first.reconnect(credentials[0]!.reconnectToken), replay.reconnect(credentials[1]!.reconnectToken)];
    expect(reconnected.every(Boolean)).toBe(true);
    expect(first.race).toEqual(replay.race);

    const eventsA = advance(first, PROVISIONAL_DURATIONS.crashRecoveryTicks + 2);
    const eventsB = advance(replay, PROVISIONAL_DURATIONS.crashRecoveryTicks + 2);
    expect(eventsA).toEqual(eventsB);
    expect(first.race).toEqual(replay.race);
    expect(eventsA.some((event) => event.type === "respawn")).toBe(true);
    expect(first.race!.cars.some((car) => car.ghost || car.ghostMinimumTicksRemaining > 0)).toBe(true);
  });
});

describe("Milestone 6 Host and Spectator policy", () => {
  test("active Host replacement transfers capability unless it is the only connection", () => {
    const value = room();
    value.join("first", "First");
    const token = value.connectionIdentity("host")!.reconnectToken;
    value.reconnect(token);
    expect(value.hostId).toBe("first");
    expect(value.configureRace("host", { laps: 2 })).toBe(false);
    expect(value.configureRace("first", { laps: 2 })).toBe(true);

    const alone = room();
    alone.reconnect(alone.connectionIdentity("host")!.reconnectToken);
    expect(alone.hostId).toBe("host");
  });

  test("transfers Host deterministically once, never lets the previous Host preempt, and authorizes only the new Host", () => {
    const value = room();
    value.join("first", "First");
    value.join("second", "Second");
    const oldHost = value.connectionIdentity("host")!;
    value.disconnect("host", oldHost.connectionGeneration);

    expect(value.hostId).toBe("first");
    expect(value.snapshot().players.filter((candidate) => candidate.isHost)).toHaveLength(1);
    expect(value.configureRace("host", { laps: 2 })).toBe(false);
    expect(value.configureRace("first", { laps: 2 })).toBe(true);
    value.reconnect(oldHost.reconnectToken);
    expect(value.hostId).toBe("first");
    expect(value.snapshot().players.filter((candidate) => candidate.isHost).map((candidate) => candidate.id)).toEqual(["first"]);
    expect(value.startRace("host")).toBeNull();
    expect(value.startRace("first")).toBe("race-1");
  });

  test("promotes a sole connected Spectator before granting Results Host capability", () => {
    const value = room({ laps: 1 });
    value.join("guest", "Guest");
    const raceId = value.startRace("host")!;
    const late = value.join("late", "Late");
    advance(value, COUNTDOWN_TICKS);
    finish(value, raceId);
    value.disconnect("host", value.connectionIdentity("host")!.connectionGeneration);
    value.disconnect("guest", value.connectionIdentity("guest")!.connectionGeneration);

    expect(value.hostId).toBe(late.id);
    expect(player(value, late.id).role).toBe("racer");
    expect(value.snapshot(late.id).canRematch).toBe(true);
  });

  test("admits late/full Spectators with no race capabilities and promotes connected Spectators on rematch", () => {
    const value = room({ laps: 1 });
    value.join("guest", "Guest");
    const raceId = value.startRace("host")!;
    const late = value.join("late", "Late");
    expect(late).toMatchObject({ role: "spectator", raceSeatId: null, controller: "none" });
    expect(value.snapshot("late")).toMatchObject({ localRole: "spectator", canControlRace: false, canStartRace: false, canRematch: false });
    advance(value, COUNTDOWN_TICKS);
    expect(value.join("later", "Later").role).toBe("spectator");
    finish(value, raceId);
    expect(value.snapshot("late")).toMatchObject({ canControlRace: false, canStartRace: false, canRematch: false });
    expect(value.rematch("host", raceId)).toBe(true);
    expect(player(value, "late")).toMatchObject({ role: "racer", raceSeatId: "late" });
    expect(player(value, "later")).toMatchObject({ role: "racer", raceSeatId: "later" });
  });

  test("enforces Racer, Spectator, and total connection limits", () => {
    const value = room();
    for (let index = 1; index < MAX_RACERS; index += 1) value.join(`racer-${index}`, `Racer ${index}`);
    for (let index = 0; index < MAX_SPECTATORS; index += 1) value.join(`spectator-${index}`, `Spectator ${index}`);
    expect(value.snapshot().players.filter((candidate) => candidate.role === "racer")).toHaveLength(MAX_RACERS);
    expect(value.snapshot().players.filter((candidate) => candidate.role === "spectator")).toHaveLength(MAX_SPECTATORS);
    expect(() => value.join("over-total", "Over total")).toThrow("Room connection limit reached");

    value.disconnect("spectator-0");
    expect(() => value.join("over-spectators", "Over spectators")).toThrow("Spectator limit reached");
  });
});

describe("Milestone 6 cleanup and Room lifetime", () => {
  test("cleans expired Open reservations but preserves them until the exact boundary", () => {
    const time = clock();
    const value = room({ now: time.now });
    value.join("guest", "Guest");
    value.disconnect("guest");
    time.advance(RECONNECT_RESERVATION_MS - 1);
    value.join("before", "Before");
    expect(value.snapshot().players.some((candidate) => candidate.id === "guest")).toBe(true);

    time.advance(1);
    value.join("boundary", "Boundary");
    expect(value.snapshot().players.some((candidate) => candidate.id === "guest")).toBe(false);
  });

  test("expires empty Open and Results Rooms at the exact injected-clock boundary", () => {
    const openTime = clock();
    const open = room({ now: openTime.now });
    open.disconnect("host");
    openTime.advance(EMPTY_ROOM_EXPIRATION_MS - 1);
    expect(open.isExpired()).toBe(false);
    openTime.advance(1);
    expect(open.isExpired()).toBe(true);

    const resultsTime = clock();
    const results = room({ now: resultsTime.now });
    const raceId = start(results);
    finish(results, raceId);
    results.disconnect("host");
    results.disconnect("guest");
    resultsTime.advance(EMPTY_ROOM_EXPIRATION_MS - 1);
    expect(results.isExpired()).toBe(false);
    resultsTime.advance(1);
    expect(results.isExpired()).toBe(true);
  });
});
