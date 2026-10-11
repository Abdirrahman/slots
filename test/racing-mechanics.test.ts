import { describe, expect, test } from "bun:test";
import { createRace, advanceRace, raceCarProfile, PROVISIONAL_CAR_PROFILE, SYNTHETIC_CIRCULAR_TRACK, type RaceState, type Track } from "../src/race";
import { cyclePickups, safePickupLocation } from "../src/pickups";
import { DINING_TRACK } from "../src/authored-track";
import { botInput } from "../src/bot";
import { Room } from "../src/room";
import { parseServerMessage } from "../src/multiplayer-client";
import { parseClientCommand, PROTOCOL_VERSION } from "../src/protocol";
import { bestTimeKey } from "../src/best-times";
import { readGhost, saveGhost, sampleGhost, scoreCupRound } from "../src/replay";

function race(track: Track = SYNTHETIC_CIRCULAR_TRACK, assist = false): RaceState {
  return createRace({ track, configuration: { laps: 3, rules: "club", assist, voltage: 6 }, seed: 42,
    cars: [{ id: "racer", lane: 0, profile: raceCarProfile("r2-car-club") }] });
}
function ticks(state: RaceState, count: number, input = {}): RaceState {
  for (let index = 0; index < count; index += 1) state = advanceRace(state, { racer: input }).state;
  return state;
}

describe("manual racing", () => {
  test("rests without throttle, accelerates on demand, coasts on lift and brakes harder", () => {
    expect(ticks(race(), 30).cars[0]!.speed).toBe(0);
    const moving = ticks(race(), 30, { throttle: 1 });
    expect(moving.cars[0]!.speed).toBeCloseTo(9);
    expect(ticks(moving, 10).cars[0]!.speed).toBeGreaterThan(ticks(moving, 10, { brake: true }).cars[0]!.speed);
    expect(ticks(race(undefined, true), 30).cars[0]!.speed).toBeGreaterThan(0);
  });
  test("inner lanes shorten travel but punish overspeed, and recovery preserves earned progress", () => {
    const track: Track = { ...SYNTHETIC_CIRCULAR_TRACK, corners: [{ id: "turn", fromProgress: 1, toProgress: 110, laneSpeedLimits: [19, 18, 17, 16] }] };
    let state = race(track);
    const car = { ...state.cars[0]!, progress: 50, speed: 23, profile: raceCarProfile("r2-car-club", 9) };
    state = { ...state, cars: [car] };
    const inner = advanceRace(state, { racer: { throttle: 1 } }).state;
    const outer = advanceRace({ ...state, cars: [{ ...car, lane: 3 }] }, { racer: { throttle: 1 } }).state;
    expect(inner.cars[0]!.progress).toBeGreaterThan(outer.cars[0]!.progress);
    for (let index = 0; index < 90 && state.cars[0]!.crashRecoveryTicksRemaining === 0; index += 1) state = advanceRace(state, { racer: { throttle: 1 } }).state;
    expect(state.cars[0]!.crashRecoveryTicksRemaining).toBe(36);
    const crashedAt = state.cars[0]!.progress;
    state = ticks(state, 36);
    expect(state.cars[0]!.progress).toBeCloseTo(crashedAt);
    expect(state.cars[0]!.ghost).toBe(true);
  });
  test("held shields activate only when spent and boosting needs an intentional barge to attack", () => {
    let state = race();
    state = { ...state, cars: [{ ...state.cars[0]!, shieldCharges: 1, boostCharges: 1 }] };
    const shielded = advanceRace(state, { racer: { useShield: true } }).state.cars[0]!;
    expect(shielded.shieldCharges).toBe(0); expect(shielded.shieldTicksRemaining).toBe(300);
    const boosted = advanceRace(state, { racer: { useBoost: true, barge: true } }).state.cars[0]!;
    expect(boosted.bargeTicks).toBe(12); expect(boosted.bargeCooldown).toBe(90);
    const repeated = advanceRace({ ...state, cars: [boosted] }, { racer: { barge: true } }).state.cars[0]!;
    expect(repeated.bargeTicks).toBe(11); expect(repeated.bargeCooldown).toBe(89);
  });
  test("bots send ordinary throttle on every tick and do not receive faster hidden profiles", () => {
    const state = race(DINING_TRACK);
    for (let tick = 0; tick < 30; tick += 1) expect(botInput({ ...state, tick }, "racer").throttle).toBe(1);
    expect(raceCarProfile("r2-car-muscle").topSpeedPerSecond).toBeGreaterThan(raceCarProfile("r2-car-prototype").topSpeedPerSecond);
  });
});

describe("competitive random pickups", () => {
  test("same seed and race state produce identical safe placements with a visible warning", () => {
    const initial = race(DINING_TRACK);
    const ready = { ...initial, powerUpOpportunities: initial.powerUpOpportunities.map((item) => ({ ...item, ticksRemaining: 1 })) };
    const first = cyclePickups(ready), second = cyclePickups(ready);
    expect(first).toEqual(second);
    const spawned = first.opportunities.filter((item) => item.phase === "warning");
    expect(spawned.length).toBeGreaterThan(0);
    for (const item of spawned) {
      expect(item.ticksRemaining).toBe(45);
      expect(safePickupLocation(ready, first.opportunities, item.id, item.progress!, item.lane)).toBe(true);
    }
    const other = cyclePickups({ ...ready, randomState: 381 });
    expect(other.opportunities).not.toEqual(first.opportunities);
  });
  test("no pickups spawn on corners, checkpoint lines, a car or its immediate approach", () => {
    const state = race(DINING_TRACK);
    expect(safePickupLocation(state, [], "test", 100, 0)).toBe(false);
    expect(safePickupLocation(state, [], "test", DINING_TRACK.checkpoints[1]!.progress, 0)).toBe(false);
    expect(safePickupLocation(state, [], "test", 0, 3)).toBe(false);
    expect(safePickupLocation(state, [], "test", 20, 3)).toBe(false);
    expect(safePickupLocation(state, [], "test", 60, 3)).toBe(true);
  });
  test("a leader's lap does not reset a rival's pickup opportunity or its timer", () => {
    let state = race(DINING_TRACK);
    state = { ...state, cars: [{ ...state.cars[0]!, completedLaps: 1 }], powerUpOpportunities: state.powerUpOpportunities.map((item) => ({ ...item, phase: "active", collected: false, ticksRemaining: 200 })) };
    const after = advanceRace(state, {}).state;
    expect(after.powerUpOpportunities.map((item) => [item.progress, item.lane, item.effect, item.ticksRemaining]))
      .toEqual(state.powerUpOpportunities.map((item) => [item.progress, item.lane, item.effect, 199]));
  });
  test("collecting schedules an independent respawn; camping and full inventory cannot consume a crate", () => {
    const track: Track = { ...SYNTHETIC_CIRCULAR_TRACK, powerUpOpportunities: [{ id: "crate", progress: 60, spawnRadius: 12, allowedEffects: ["boost"] }] };
    let state = race(track);
    state = { ...state, cars: [{ ...state.cars[0]!, progress: 59.5, speed: 18 }], powerUpOpportunities: [{ id: "crate", lane: 0, effect: "boost", progress: 60, collected: false, phase: "active", ticksRemaining: 600 }] };
    const collected = advanceRace(state, { racer: { throttle: 1 } }).state;
    expect(collected.cars[0]!.boostCharges).toBe(1);
    expect(collected.powerUpOpportunities[0]!.phase).toBe("cooldown");
    expect(collected.powerUpOpportunities[0]!.ticksRemaining).toBeGreaterThanOrEqual(179);
    const camped = { ...state, cars: [{ ...state.cars[0]!, travelled: 20, lastPickupTravel: 19, lastPickupTick: -300 }] };
    expect(advanceRace(camped, { racer: { throttle: 1 } }).state.powerUpOpportunities[0]!.collected).toBe(false);
    const full = { ...state, cars: [{ ...state.cars[0]!, boostCharges: 2 }] };
    expect(advanceRace(full, { racer: { throttle: 1 } }).state.powerUpOpportunities[0]!.collected).toBe(false);
  });
  test("warning crates cannot be collected and expired crates migrate between safe zones", () => {
    let state = race(DINING_TRACK);
    const positions = new Set<number>();
    for (let index = 0; index < 20; index += 1) {
      const cycled = cyclePickups({ ...state, powerUpOpportunities: state.powerUpOpportunities.map((item) => ({ ...item, phase: "cooldown", collected: true, ticksRemaining: 1 })) });
      state = { ...state, randomState: cycled.randomState, powerUpOpportunities: cycled.opportunities };
      for (const item of cycled.opportunities) if (item.phase === "warning") positions.add(item.progress!);
    }
    expect(positions.size).toBeGreaterThan(20);
  });
});

function snapshot(room: Room) {
  const state = room.snapshot("host");
  return parseServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "snapshot", roomCode: room.code,
    raceId: room.raceId, simulationTick: room.race?.tick ?? 0, stateVersion: state.stateVersion,
    lastProcessedInputSequence: state.lastProcessedInputSequence, localPlayerId: "host", connectionGeneration: 1, state }));
}
describe("wire contracts and records", () => {
  test("validates new mode snapshots and Time Trial runs with zero bots and no items", () => {
    for (const rules of ["club", "party", "trial"] as const) {
      const room = new Room({ code: "AB12", hostId: "host", hostName: "Driver", track: DINING_TRACK,
        configuration: { laps: 1, rules, assist: true, voltage: 6 }, soloConfiguration: { botCount: rules === "trial" ? 0 : 2, botDifficulty: "normal" } });
      room.startRace("host"); snapshot(room);
      for (let tick = 0; tick < 180; tick += 1) room.advance();
      expect(snapshot(room).type).toBe("snapshot");
      if (rules === "trial") { expect(room.race!.cars.length).toBe(1); expect(room.race!.powerUpOpportunities).toEqual([]); }
    }
  });
  test("accepts bounded driving inputs and rejects forged state, invalid modes and assisted trial bots", () => {
    const base = { protocolVersion: PROTOCOL_VERSION, seq: 1 };
    expect(parseClientCommand(JSON.stringify({ ...base, type: "input", raceId: "r1", throttle: 0.5, brake: false, useShield: true, barge: true })).type).toBe("input");
    for (const throttle of [-1, 2, "1"]) expect(() => parseClientCommand(JSON.stringify({ ...base, type: "input", raceId: "r1", throttle }))).toThrow();
    expect(() => parseClientCommand(JSON.stringify({ ...base, type: "create_solo_race", name: "Driver", botCount: 1, botDifficulty: "hard", configuration: { laps: 1, rules: "trial" } }))).toThrow();
  });
  test("mode, assist, voltage and braking profiles cannot share a best-time record", () => {
    const identity = { trackId: "test", trackVersion: "1.0.0", configuration: { laps: 1, rules: "trial" as const, assist: false, voltage: 6 as const }, soloConfiguration: null, carProfileId: "car", carProfile: PROVISIONAL_CAR_PROFILE };
    const original = bestTimeKey(identity);
    expect(bestTimeKey({ ...identity, configuration: { ...identity.configuration, assist: true } })).not.toBe(original);
    expect(bestTimeKey({ ...identity, configuration: { ...identity.configuration, voltage: 9 } })).not.toBe(original);
    expect(bestTimeKey({ ...identity, carProfile: { ...identity.carProfile, brakingPerSecondSquared: 20 } })).not.toBe(original);
  });
  test("ghosts interpolate across the finish line, retain faster runs and reject corrupt storage", () => {
    const map = new Map<string, string>(); const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    const run = { version: 1 as const, seconds: 10, length: 120, samples: [[0, 110, 1], [10, 130, 2]] as [number, number, number][], sectors: [5, 10] };
    saveGhost(storage, "record", run);
    expect(sampleGhost(readGhost(storage, "record", 120)!, 5)).toEqual({ progress: 0, lane: 1.5 });
    saveGhost(storage, "record", { ...run, seconds: 12 });
    expect(readGhost(storage, "record", 120)!.seconds).toBe(10);
    map.set("record|ghost", JSON.stringify({ ...run, samples: [[1, 20, 0], [0, 30, 0]] }));
    expect(readGhost(storage, "record", 120)).toBeNull();
    expect(scoreCupRound([{ id: "You", finished: true }, { id: "Bot", finished: false }])).toEqual({ You: 10, Bot: 0 });
  });
});

test("Party recovery replaces an offensive item, never changes car pace, and Club retains its drawn item", () => {
  const track: Track = { ...SYNTHETIC_CIRCULAR_TRACK, powerUpOpportunities: [{ id: "crate", progress: 20, allowedEffects: ["boost", "shield", "hazard"] }] };
  const base = createRace({ track, configuration: { laps: 3, rules: "party", assist: false }, seed: 2,
    cars: [{ id: "racer", profile: raceCarProfile("r2-car-club"), lane: 0, progress: 19.5, speed: 18 },
      { id: "leader", profile: raceCarProfile("r2-car-club"), lane: 2, progress: 80, speed: 18 }] });
  const state = { ...base, powerUpOpportunities: [{ id: "crate", lane: 0 as const, effect: "hazard" as const, collected: false, progress: 20, phase: "active" as const, ticksRemaining: 600 }] };
  const party = advanceRace(state, { racer: { throttle: 1 }, leader: { throttle: 1 } }).state;
  const club = advanceRace({ ...state, configuration: { ...state.configuration, rules: "club" } }, { racer: { throttle: 1 }, leader: { throttle: 1 } }).state;
  expect(party.cars.find((car) => car.id === "racer")!.boostCharges).toBe(1);
  expect(club.cars.find((car) => car.id === "racer")!.mineCharges).toBe(1);
  expect(party.cars.map((car) => [car.speed, car.progress])).toEqual(club.cars.map((car) => [car.speed, car.progress]));
});

test("boost contact alone is harmless; a readable barge windup precedes an attack and a shield counters it", () => {
  const initial = createRace({ track: SYNTHETIC_CIRCULAR_TRACK, configuration: { laps: 3, rules: "club" },
    cars: [{ id: "racer", lane: 0, profile: raceCarProfile("r2-car-club"), progress: 8, speed: 18 },
      { id: "target", lane: 0, profile: raceCarProfile("r2-car-club"), progress: 10 }] });
  const state = { ...initial, cars: initial.cars.map((car) => car.id === "racer" ? { ...car, boostTicksRemaining: 90 } : car) };
  expect(advanceRace(state, { racer: { throttle: 1 } }).events.some((event) => event.type === "boosted_impact")).toBe(false);
  expect(advanceRace(state, { racer: { throttle: 1, barge: true } }).events.some((event) => event.type === "boosted_impact")).toBe(false);
  const armed = { ...state, cars: state.cars.map((car) => car.id === "racer" ? { ...car, bargeTicks: 6, bargeCooldown: 84 } : car) };
  const hit = advanceRace(armed, { racer: { throttle: 1 } });
  expect(hit.events.some((event) => event.type === "boosted_impact")).toBe(true);
  const shielded = { ...armed, cars: armed.cars.map((car) => car.id === "target" ? { ...car, shieldTicksRemaining: 100 } : car) };
  const blocked = advanceRace(shielded, { racer: { throttle: 1 } });
  expect(blocked.events.some((event) => event.type === "shield_consumed")).toBe(true);
  expect(blocked.state.cars.find((car) => car.id === "target")!.crashRecoveryTicksRemaining).toBe(0);
});
