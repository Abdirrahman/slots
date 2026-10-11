import { describe, expect, test } from "bun:test";
import {
  acceptSnapshot,
  interpolateSnapshotCar,
  parseServerMessage,
  predictLocalCarPose,
  snapshotAlpha,
  type ServerSnapshotMessage,
} from "../src/multiplayer-client";
import { PROTOCOL_VERSION } from "../src/protocol";
import { advanceRace } from "../src/race";
import { createLocalRace } from "../src/presentation";

interface MutableMilestone6Snapshot {
  [key: string]: unknown;
  connectionGeneration: number;
  localPlayerId: string;
  state: {
    [key: string]: unknown;
    players: Record<string, unknown>[];
    localRole: string;
    canControlRace: boolean;
    localConnectionGeneration: number;
  };
}

interface MutableRaceSnapshot {
  [key: string]: unknown;
  state: {
    [key: string]: unknown;
    players: Record<string, unknown>[];
    race: {
      [key: string]: unknown;
      track: Record<string, unknown>;
      cars: Record<string, unknown>[];
      powerUpOpportunities: Record<string, unknown>[];
      hazards: Record<string, unknown>[];
    };
  };
}

function message(stateVersion: number, race = createLocalRace()): ServerSnapshotMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "snapshot",
    roomCode: "AB12",
    raceId: "race-1",
    simulationTick: race.tick,
    stateVersion,
    lastProcessedInputSequence: 2,
    localPlayerId: "local-car",
    connectionGeneration: 1,
    state: {
      roomCode: "AB12",
      phase: "racing",
      stateVersion,
      raceId: "race-1",
      countdownTicksRemaining: null,
      configuration: race.configuration,
      soloConfiguration: null,
      configuredBots: [],
      players: [{ id: "local-car", name: "Ada", role: "racer", raceSeatId: "local-car", controller: "human", reclaimPending: false, bestTimeEligible: true, isHost: true, connected: true }],
      race,
      lastProcessedInputSequence: 2,
      localConnectionGeneration: 1,
      localRole: "racer",
      canControlRace: true,
      canStartRace: false,
      canRematch: false,
    },
  };
}

describe("authoritative snapshot presentation", () => {
  test("strictly parses private identity and rejects malformed reconnect credentials", () => {
    const identity = {
      protocolVersion: PROTOCOL_VERSION,
      type: "identity" as const,
      roomCode: "AB12",
      localPlayerId: "local-car",
      reconnectToken: "a".repeat(43),
      connectionGeneration: 1,
    };
    expect(parseServerMessage(JSON.stringify(identity))).toEqual(identity);
    for (const malformed of [
      { ...identity, reconnectToken: "short" },
      { ...identity, reconnectToken: "!".repeat(43) },
      { ...identity, connectionGeneration: 0 },
      { ...identity, connectionGeneration: -1 },
      { ...identity, connectionGeneration: 1.5 },
      { ...identity, extra: true },
    ]) expect(() => parseServerMessage(JSON.stringify(malformed))).toThrow("Malformed server message");
  });

  test("strictly validates configured Solo Bots without treating them as Players", () => {
    const solo = structuredClone(message(1)) as unknown as MutableRaceSnapshot;
    const bot = { ...solo.state.race.cars[0]!, id: "configured-bot-1", lane: 0 };
    solo.state.race.cars.push(bot);
    Object.assign(solo.state, {
      soloConfiguration: { botCount: 1, botDifficulty: "hard" },
      configuredBots: [{ id: "configured-bot-1", name: "Bot 1" }],
    });
    expect(parseServerMessage(JSON.stringify(solo))).toEqual(solo as unknown as ServerSnapshotMessage);

    const twoBots = structuredClone(solo);
    twoBots.state.soloConfiguration = { botCount: 2, botDifficulty: "hard" };
    twoBots.state.configuredBots = [
      { id: "configured-bot-1", name: "Bot 1" },
      { id: "configured-bot-2", name: "Bot 2" },
    ];
    twoBots.state.race.cars.push({ ...bot, id: "configured-bot-2", lane: 1 });
    expect(parseServerMessage(JSON.stringify(twoBots))).toEqual(twoBots as unknown as ServerSnapshotMessage);

    const malformed: ((value: MutableRaceSnapshot) => void)[] = [
      (value) => { value.state.configuredBots = []; },
      (value) => {
        value.state.configuredBots = [{ id: "configured-bot-2", name: "Bot 2" }];
        value.state.race.cars[1]!.id = "configured-bot-2";
      },
      (value) => { value.state.configuredBots = [{ id: "configured-bot-1", name: "Bot 1", extra: true }]; },
      (value) => { value.state.configuredBots = [{ id: "local-car", name: "Bot 1" }]; },
      (value) => { value.state.soloConfiguration = { botCount: 2, botDifficulty: "hard" }; },
      (value) => { value.state.soloConfiguration = { botCount: 1, botDifficulty: "Hard" }; },
      (value) => { value.state.soloConfiguration = null; },
    ];
    for (const mutate of malformed) {
      const value = structuredClone(solo);
      mutate(value);
      expect(() => parseServerMessage(JSON.stringify(value))).toThrow("Malformed server message");
    }

    twoBots.state.configuredBots = [
      { id: "configured-bot-2", name: "Bot 2" },
      { id: "configured-bot-1", name: "Bot 1" },
    ];
    expect(() => parseServerMessage(JSON.stringify(twoBots))).toThrow("Malformed server message");
  });

  test("validates Racer, Bot reclaim, and Spectator capability combinations", () => {
    const bot = structuredClone(message(1)) as unknown as MutableMilestone6Snapshot;
    bot.state.players[0] = { ...bot.state.players[0]!, controller: "bot", reclaimPending: true };
    bot.state.canControlRace = false;
    expect(parseServerMessage(JSON.stringify(bot))).toEqual(bot as unknown as ServerSnapshotMessage);

    const spectator = structuredClone(message(2)) as unknown as MutableMilestone6Snapshot;
    spectator.localPlayerId = "spectator";
    spectator.state.localRole = "spectator";
    spectator.state.canControlRace = false;
    spectator.state.players.push({
      id: "spectator", name: "Sam", role: "spectator", raceSeatId: null, controller: "none",
      reclaimPending: false, bestTimeEligible: false, isHost: false, connected: true,
    });
    expect(parseServerMessage(JSON.stringify(spectator))).toEqual(spectator as unknown as ServerSnapshotMessage);

    const malformed: ((value: MutableMilestone6Snapshot) => void)[] = [
      (value) => { value.state.players[0] = { ...value.state.players[0]!, role: "spectator", raceSeatId: null }; },
      (value) => { value.state.players[0] = { ...value.state.players[0]!, controller: "warp" }; },
      (value) => { value.state.players[0] = { ...value.state.players[0]!, reclaimPending: true }; },
      (value) => { value.state.players[0] = { ...value.state.players[0]!, raceSeatId: "other" }; },
      (value) => { value.state.canControlRace = false; },
      (value) => { value.state.localConnectionGeneration = 2; },
      (value) => { value.connectionGeneration = 0; },
    ];
    for (const mutate of malformed) {
      const value = structuredClone(message(3)) as unknown as MutableMilestone6Snapshot;
      mutate(value);
      expect(() => parseServerMessage(JSON.stringify(value))).toThrow("Malformed server message");
    }
    const openWithRace = structuredClone(message(4)) as unknown as MutableMilestone6Snapshot;
    openWithRace.state.phase = "open";
    openWithRace.state.players[0] = { ...openWithRace.state.players[0]!, controller: "none" };
    openWithRace.state.canControlRace = false;
    openWithRace.state.canStartRace = true;
    expect(() => parseServerMessage(JSON.stringify(openWithRace))).toThrow("Malformed server message");
  });

  test("keeps only increasing authoritative snapshots and interpolates without mutation", () => {
    const first = message(1);
    const advancedRace = advanceRace(first.state.race!, { "local-car": { laneChange: 1 } }).state;
    const second = message(2, advancedRace);
    const before = structuredClone(second);
    const pair = acceptSnapshot(acceptSnapshot(null, first), second);

    expect(acceptSnapshot(pair, first)).toBe(pair);
    expect(interpolateSnapshotCar(pair, "local-car", 0.5)).not.toBeNull();
    expect(second).toEqual(before);
  });

  test("strictly validates authoritative contact and blocked-return snapshot fields", () => {
    const valid = message(1);
    expect(parseServerMessage(JSON.stringify(valid))).toEqual(valid);

    const disconnectedMalformed = structuredClone(valid) as unknown as { state: { players: Record<string, unknown>[] } };
    delete disconnectedMalformed.state.players[0]!.connected;
    expect(() => parseServerMessage(JSON.stringify(disconnectedMalformed))).toThrow("Malformed server message");
    expect(() => parseServerMessage(JSON.stringify({ ...valid, extra: true }))).toThrow("Malformed server message");

    const malformed = [
      { laneTransition: undefined },
      { laneTransition: { from: 1, to: 2, progress: 0.5, phase: "blocked" } },
      { laneTransition: { from: 1, to: 4, progress: 0.5, phase: "returning" } },
      { laneTransition: { from: 1, to: 2, progress: 2, phase: "returning" } },
      { laneTransition: { from: 1, to: 2, progress: 0.5, phase: "returning", extra: true } },
      { ordinaryContact: undefined },
      { ordinaryContact: { leadingCarId: "", enteredAtTick: 0 } },
      { ordinaryContact: { leadingCarId: "lead", enteredAtTick: -1 } },
      { ordinaryContact: { leadingCarId: "lead", enteredAtTick: 0, extra: true } },
      { result: "crashed" },
      { speed: -1 },
    ];
    for (const fields of malformed) {
      const value = structuredClone(valid) as unknown as { state: { race: { cars: Record<string, unknown>[] } } };
      Object.assign(value.state.race.cars[0]!, fields);
      expect(() => parseServerMessage(JSON.stringify(value))).toThrow("Malformed server message");
    }
  });

  test("strictly validates Milestone 5 Track, Race, opportunity, Hazard, and Car fields", () => {
    const valid = structuredClone(message(1)) as unknown as MutableRaceSnapshot;
    const race = valid.state.race;
    Object.assign(race.track, {
      fixedObstacles: [{ id: "obstacle", progress: 10, lane: 0 }],
      powerUpOpportunities: [{ id: "power", progress: 20, allowedEffects: ["shield", "boost"] }],
      hazardPlacementLocations: [{ id: "placement", progress: 30, allowedLanes: [1, 2] }],
    });
    race.powerUpOpportunities = [{ id: "power", lane: 1, effect: "shield", collected: false }];
    race.hazards = [{ id: "hazard-0", locationId: "placement", progress: 30, lane: 2, phase: "warning", ticksRemaining: 2 }];
    race.nextHazardSequence = 1;
    expect(parseServerMessage(JSON.stringify(valid))).toEqual(valid as unknown as ServerSnapshotMessage);

    const malformed: ((value: MutableRaceSnapshot) => void)[] = [
      (value) => { delete value.state.race.seed; },
      (value) => { delete value.state.race.track.fixedObstacles; },
      (value) => { delete value.state.race.track.powerUpOpportunities; },
      (value) => { delete value.state.race.track.hazardPlacementLocations; },
      (value) => { value.state.race.extra = true; },
      (value) => { value.state.race.seed = 1.5; },
      (value) => { value.state.race.randomState = Number.POSITIVE_INFINITY; },
      (value) => { value.state.race.randomState = 0x1_0000_0000; },
      (value) => { value.state.race.powerUpLap = -1; },
      (value) => { value.state.race.nextHazardSequence = -1; },
      (value) => { delete (value.state.race.track.fixedObstacles as Record<string, unknown>[])[0]!.lane; },
      (value) => { (value.state.race.track.fixedObstacles as Record<string, unknown>[])[0]!.extra = true; },
      (value) => { (value.state.race.track.fixedObstacles as Record<string, unknown>[])[0]!.progress = -1; },
      (value) => { (value.state.race.track.powerUpOpportunities as Record<string, unknown>[])[0]!.allowedEffects = ["warp"]; },
      (value) => { (value.state.race.track.powerUpOpportunities as Record<string, unknown>[])[0]!.id = "quarter"; },
      (value) => { (value.state.race.track.hazardPlacementLocations as Record<string, unknown>[])[0]!.allowedLanes = [1, 1]; },
      (value) => { delete value.state.race.powerUpOpportunities[0]!.collected; },
      (value) => { value.state.race.powerUpOpportunities[0]!.extra = true; },
      (value) => { value.state.race.powerUpOpportunities[0]!.effect = "hazard"; },
      (value) => { value.state.race.powerUpOpportunities[0]!.lane = -1; },
      (value) => { value.state.race.hazards[0]!.locationId = "missing"; },
      (value) => { value.state.race.hazards[0]!.progress = 31; },
      (value) => { value.state.race.hazards[0]!.lane = 0; },
      (value) => { value.state.race.hazards[0]!.phase = "expired"; },
      (value) => { value.state.race.hazards[0]!.ticksRemaining = Number.NaN; },
      (value) => { value.state.race.hazards[0]!.ticksRemaining = -1; },
      (value) => { delete value.state.race.cars[0]!.ghost; },
      (value) => { value.state.race.cars[0]!.extra = true; },
      (value) => { value.state.race.cars[0]!.crashRecoveryTicksRemaining = -1; },
      (value) => { value.state.race.cars[0]!.ghost = "true"; },
      (value) => { value.state.race.cars[0]!.ghostMinimumTicksRemaining = 1; },
      (value) => { value.state.race.cars[0]!.shieldTicksRemaining = Number.POSITIVE_INFINITY; },
      (value) => { value.state.race.cars[0]!.boostTicksRemaining = -1; },
      (value) => { value.state.race.cars[0]!.shieldTicksRemaining = 301; },
      (value) => { value.state.race.cars[0]!.boostTicksRemaining = 91; },
      (value) => { value.state.race.cars[0]!.crashRecoveryTicksRemaining = 91; },
      (value) => { value.state.race.cars[0]!.respawnProgress = -1; },
      (value) => {
        value.state.race.cars[0]!.crashRecoveryTicksRemaining = 1;
        value.state.race.cars[0]!.speed = 1;
      },
    ];
    for (const mutate of malformed) {
      const value = structuredClone(valid);
      mutate(value);
      expect(() => parseServerMessage(JSON.stringify(value))).toThrow("Malformed server message");
    }
  });

  test("snapshot interpolation holds authoritative Crash and Respawn poses", () => {
    const previous = message(1);
    const previousCar = previous.state.race!.cars[0]!;
    const recovering = message(2, {
      ...previous.state.race!,
      tick: 1,
      cars: [{ ...previousCar, progress: 40, speed: 0, crashRecoveryTicksRemaining: 10 }],
    });
    const recoveryPair = acceptSnapshot(acceptSnapshot(null, previous), recovering);
    expect(interpolateSnapshotCar(recoveryPair, "local-car", 0.5)).toEqual(
      predictLocalCarPose(recoveryPair, "local-car", 0),
    );

    const ghost = message(3, {
      ...recovering.state.race!,
      tick: 2,
      cars: [{ ...previousCar, progress: 0, speed: previousCar.profile.topSpeedPerSecond, ghost: true, ghostMinimumTicksRemaining: 30 }],
    });
    const ghostPair = acceptSnapshot(recoveryPair, ghost);
    expect(interpolateSnapshotCar(ghostPair, "local-car", 0.5)).toEqual(
      predictLocalCarPose(ghostPair, "local-car", 0),
    );
  });

  test("predicts the local Lane on an authored Track carrying obstacles and pickups", () => {
    // The Workshop Bench has fixed obstacles, pickup opportunities and live Hazards, which is
    // exactly the Track that used to switch prediction off altogether.
    const authority = message(1);
    const track = authority.state.race!.track;
    expect(track.fixedObstacles!.length).toBeGreaterThan(0);
    expect(track.powerUpOpportunities!.length).toBeGreaterThan(0);

    const pair = acceptSnapshot(null, authority);
    const settled = predictLocalCarPose(pair, "local-car", 0);
    const changing = predictLocalCarPose(pair, "local-car", 0.05, 1);
    expect(changing!.lanePosition).toBeGreaterThan(settled!.lanePosition);
    expect(predictLocalCarPose(pair, "local-car", 0.05, -1)!.lanePosition).toBeLessThan(settled!.lanePosition);
  });

  test("takes forward travel from authority while a Track can interrupt it", () => {
    const authority = message(1);
    const pair = acceptSnapshot(null, authority);
    const car = authority.state.race!.cars[0]!;
    const moving = message(2, { ...authority.state.race!, tick: 1, cars: [{ ...car, progress: car.progress + 3 }] });
    const movingPair = acceptSnapshot(pair, moving);

    // Lane is predicted, so the pose differs from pure interpolation; progress is not, so it
    // matches the interpolated progress exactly at the same Lane.
    const alpha = snapshotAlpha(0.05);
    const interpolated = interpolateSnapshotCar(movingPair, "local-car", alpha)!;
    const predicted = predictLocalCarPose(movingPair, "local-car", 0.05, 1)!;
    expect(predicted.lanePosition).toBeGreaterThan(interpolated.lanePosition);
    expect(predictLocalCarPose(movingPair, "local-car", 0.05)).toEqual(interpolated);
  });

  test("extrapolates forward travel only when nothing on the Track can interrupt it", () => {
    const authority = message(1);
    const race = authority.state.race!;
    const clear = message(1, {
      ...race,
      track: { ...race.track, fixedObstacles: [], powerUpOpportunities: [] },
      powerUpOpportunities: [],
      hazards: [],
    });
    const pair = acceptSnapshot(null, clear);
    const settled = predictLocalCarPose(pair, "local-car", 0)!;
    const ahead = predictLocalCarPose(pair, "local-car", 0.05)!;
    expect(ahead).not.toEqual(settled);
    // Still bounded by one snapshot interval, so a stalled connection cannot run away.
    expect(predictLocalCarPose(pair, "local-car", 10)).toEqual(predictLocalCarPose(pair, "local-car", snapshotAlpha(10) / 15));
    expect(snapshotAlpha(10)).toBe(1);
  });

  test("keeps predicting the Lane through contact, Shield, Boost and Ghost state", () => {
    const authority = message(1);
    for (const state of [
      { ordinaryContact: { leadingCarId: "lead", enteredAtTick: 0 } },
      { shieldTicksRemaining: 1 },
      { boostTicksRemaining: 1 },
      { ghost: true },
    ]) {
      const race = { ...authority.state.race!, cars: authority.state.race!.cars.map((car) => ({ ...car, ...state })) };
      const before = structuredClone(race);
      const pair = acceptSnapshot(null, message(1, race));
      expect(predictLocalCarPose(pair, "local-car", 0.05, 1)!.lanePosition)
        .toBeGreaterThan(predictLocalCarPose(pair, "local-car", 0)!.lanePosition);
      expect(race).toEqual(before);
    }
  });

  test("stops predicting the Lane for a Car that cannot act on the input", () => {
    const authority = message(1);
    for (const state of [
      { crashRecoveryTicksRemaining: 1, speed: 0 },
      { result: "finished" as const, finishedAtSeconds: 1 },
      { result: "dnf" as const },
    ]) {
      const race = { ...authority.state.race!, cars: authority.state.race!.cars.map((car) => ({ ...car, ...state })) };
      const pair = acceptSnapshot(null, message(1, race));
      expect(predictLocalCarPose(pair, "local-car", 0.05, 1)).toEqual(predictLocalCarPose(pair, "local-car", 0));
    }
  });

  test("refuses to predict a Lane change off the edge of the Track", () => {
    const authority = message(1);
    for (const [lane, direction] of [[0, -1], [3, 1]] as const) {
      const race = { ...authority.state.race!, cars: authority.state.race!.cars.map((car) => ({ ...car, lane })) };
      const pair = acceptSnapshot(null, message(1, race));
      expect(predictLocalCarPose(pair, "local-car", 0.05, direction)).toEqual(predictLocalCarPose(pair, "local-car", 0));
    }
  });

  test("advances an authoritative transition and runs a Blocked return backwards", () => {
    const authority = message(1);
    const withTransition = (phase: "changing" | "returning") => acceptSnapshot(null, message(1, {
      ...authority.state.race!,
      cars: authority.state.race!.cars.map((car) => ({
        ...car,
        lane: 1 as const,
        laneTransition: { from: 1 as const, to: 2 as const, progress: 0.5, phase },
      })),
    }));
    const changing = withTransition("changing");
    const returning = withTransition("returning");
    // A held Lane edge never overrides the transition already running.
    expect(predictLocalCarPose(changing, "local-car", 0.05, -1))
      .toEqual(predictLocalCarPose(changing, "local-car", 0.05, 1));
    expect(predictLocalCarPose(changing, "local-car", 0.05)!.lanePosition)
      .toBeGreaterThan(predictLocalCarPose(changing, "local-car", 0)!.lanePosition);
    expect(predictLocalCarPose(returning, "local-car", 0.05)!.lanePosition)
      .toBeLessThan(predictLocalCarPose(returning, "local-car", 0)!.lanePosition);
  });
});
