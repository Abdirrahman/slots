import { describe, expect, test } from "bun:test";
import {
  PROVISIONAL_CONTACT,
  PROVISIONAL_DURATIONS,
  PROVISIONAL_POWER_UPS,
  TICK_SECONDS,
  advanceRace,
  createRace,
  type CarProfile,
  type CarState,
  type HazardState,
  type LaneIndex,
  type RaceCarStart,
  type RaceState,
  type Track,
} from "../src/race";

const profile: CarProfile = {
  accelerationPerSecondSquared: 0,
  topSpeedPerSecond: 10_000,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 4,
};

function track(overrides: Partial<Track> = {}): Track {
  return {
    id: "milestone-5",
    length: 120,
    lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
    startFinish: 0,
    checkpoints: [
      { id: "checkpoint-a", progress: 30 },
      { id: "checkpoint-b", progress: 60 },
      { id: "checkpoint-c", progress: 90 },
    ],
    fixedObstacles: [],
    powerUpOpportunities: [],
    hazardPlacementLocations: [],
    ...overrides,
  };
}

function race(raceTrack: Track, cars: readonly Omit<RaceCarStart, "profile">[], seed = 1): RaceState {
  return createRace({
    track: raceTrack,
    configuration: { laps: 2 },
    cars: cars.map((value) => ({ ...value, profile })),
    seed,
  });
}

function car(state: RaceState, id = "car"): CarState {
  return state.cars.find((value) => value.id === id)!;
}

function putCar(state: RaceState, id: string, values: Partial<CarState>): RaceState {
  return { ...state, cars: state.cars.map((value) => value.id === id ? { ...value, ...values } : value) };
}

function advanceTicks(state: RaceState, ticks: number): RaceState {
  for (let tick = 0; tick < ticks; tick += 1) state = advanceRace(state, {}).state;
  return state;
}

describe("fixed obstacles, Crash, Respawn, and Ghost", () => {
  test("truncates travel at the first stable-id obstacle, validates only earlier markers, and emits one Crash", () => {
    const raceTrack = track({
      checkpoints: [
        { id: "before", progress: 5 },
        { id: "at-crash", progress: 10 },
        { id: "later", progress: 90 },
      ],
      fixedObstacles: [
        { id: "obstacle-z", progress: 10, lane: 1 },
        { id: "obstacle-a", progress: 10, lane: 1 },
        { id: "later-obstacle", progress: 15, lane: 1 },
      ],
    });
    const result = advanceRace(race(raceTrack, [{ id: "car", lane: 1, progress: 0, speed: 600 }]), {});

    expect(car(result.state).progress).toBe(10);
    expect(car(result.state).speed).toBe(0);
    expect(car(result.state).crashRecoveryTicksRemaining).toBe(PROVISIONAL_DURATIONS.crashRecoveryTicks);
    expect(car(result.state).nextCheckpointIndex).toBe(1);
    expect(car(result.state).respawnProgress).toBe(5);
    expect(result.events.filter((event) => event.type === "checkpoint").map((event) => event.checkpointId)).toEqual(["before"]);
    expect(result.events.filter((event) => event.type === "crash")).toEqual([
      expect.objectContaining({ cause: "fixed_obstacle", sourceId: "obstacle-a", timeSeconds: TICK_SECONDS / 2 }),
    ]);
  });

  test("recovers after the shared duration at full normal speed in the safest lower-index tied Lane", () => {
    const initial = race(track({ fixedObstacles: [
      { id: "crash", progress: 10, lane: 1 },
      { id: "blocks-1", progress: 0, lane: 1 },
      { id: "blocks-2", progress: 0, lane: 2 },
      { id: "blocks-3", progress: 0, lane: 3 },
    ] }), [{ id: "car", lane: 1, progress: 0, speed: 600 }]);
    let state = advanceRace(initial, {}).state;
    state = advanceTicks(state, PROVISIONAL_DURATIONS.crashRecoveryTicks - 1);
    expect(car(state).crashRecoveryTicksRemaining).toBe(1);

    const respawn = advanceRace(state, {});
    expect(car(respawn.state)).toMatchObject({
      progress: 0,
      lane: 0,
      speed: profile.topSpeedPerSecond,
      crashRecoveryTicksRemaining: 0,
      ghostMinimumTicksRemaining: PROVISIONAL_DURATIONS.minimumGhostTicks,
    });
    expect(respawn.events).toContainEqual(expect.objectContaining({ type: "respawn", carId: "car", lane: 0 }));
  });

  test("all occupied Lanes never delay Respawn and Ghost remains intangible until minimum time and clearance", () => {
    const starts = ([0, 1, 2, 3] as const).map((lane) => ({ id: `block-${lane}`, lane, progress: 0, speed: 0 }));
    let state = race(track(), [{ id: "car", lane: 2, progress: 50 }, ...starts]);
    state = putCar(state, "car", { crashRecoveryTicksRemaining: 1, respawnProgress: 0, speed: 0 });
    const respawn = advanceRace(state, {});
    expect(car(respawn.state).lane).toBe(0);
    expect(car(respawn.state).crashRecoveryTicksRemaining).toBe(0);

    state = {
      ...putCar(respawn.state, "car", { speed: 30 }),
      configuration: { laps: 100 },
    };
    state = advanceTicks(state, PROVISIONAL_DURATIONS.minimumGhostTicks);
    expect(car(state).ghostMinimumTicksRemaining).toBe(0);
    expect(car(state).progress).toBeGreaterThan(0);
  });

  test("a Ghost ignores an obstacle and exits only after becoming clear", () => {
    const raceTrack = track({ fixedObstacles: [{ id: "obstacle", progress: 5, lane: 0 }] });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 0, speed: 300 }]);
    state = putCar(state, "car", { ghost: true, ghostMinimumTicksRemaining: 1 });
    const result = advanceRace(state, {});
    expect(car(result.state).progress).toBe(10);
    expect(car(result.state).ghost).toBe(false);
    expect(car(result.state).crashRecoveryTicksRemaining).toBe(0);
    expect(result.events.some((event) => event.type === "crash")).toBe(false);
    expect(result.events.some((event) => event.type === "ghost_end")).toBe(true);
  });

  test("a Ghost stays intangible without a timeout while its occupied path is blocked", () => {
    const raceTrack = track({ fixedObstacles: [{ id: "obstacle", progress: 0, lane: 0 }] });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 0, speed: 0 }]);
    state = putCar(state, "car", { ghost: true, ghostMinimumTicksRemaining: 1 });
    state = advanceTicks(state, 2);
    expect(car(state)).toMatchObject({ ghost: true, ghostMinimumTicksRemaining: 0, crashRecoveryTicksRemaining: 0 });

    state = putCar(state, "car", { progress: 10 });
    const clear = advanceRace(state, {});
    expect(car(clear.state).ghost).toBe(false);
    expect(clear.events.some((event) => event.type === "ghost_end")).toBe(true);
  });
});

describe("Power-ups, Shield, and Boosted impacts", () => {
  test("same-seed authored choices are stable under Track and Car storage permutations", () => {
    const authored = track({
      fixedObstacles: [
        { id: "z", progress: 10, lane: 1 },
        { id: "a", progress: 10, lane: 1 },
      ],
      powerUpOpportunities: [
        { id: "power-z", progress: 20, allowedEffects: ["boost", "shield"] },
        { id: "power-a", progress: 40, allowedEffects: ["hazard", "shield"] },
      ],
    });
    const reversed = track({
      fixedObstacles: [...authored.fixedObstacles!].reverse(),
      powerUpOpportunities: [...authored.powerUpOpportunities!].reverse(),
    });
    const cars = [
      { id: "b", lane: 2 as const, progress: 0, speed: 0 },
      { id: "a", lane: 3 as const, progress: 0, speed: 0 },
    ];
    const first = race(authored, cars, 987654);
    const second = race(reversed, [...cars].reverse(), 987654);

    expect(second.powerUpOpportunities).toEqual(first.powerUpOpportunities);
    expect(second.randomState).toBe(first.randomState);
    expect(second.cars).toEqual(first.cars);
  });

  test("a pickup exactly at impacts resolves first; one Shield absorbs only the first stable-id cause", () => {
    const raceTrack = track({
      fixedObstacles: [
        { id: "obstacle-z", progress: 10, lane: 0 },
        { id: "obstacle-a", progress: 10, lane: 0 },
      ],
      powerUpOpportunities: [{ id: "shield", progress: 10, allowedEffects: ["shield"] }],
    });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 0, speed: 600 }]);
    const pickupLane = state.powerUpOpportunities[0]!.lane;
    state = putCar(state, "car", { lane: pickupLane });
    const fixedObstacles = raceTrack.fixedObstacles!.map((value) => ({ ...value, lane: pickupLane }));
    state = { ...state, track: { ...raceTrack, fixedObstacles } };
    const result = advanceRace(state, {});

    expect(result.events.map((event) => event.type)).toEqual(["power_up_collected", "shield_consumed", "crash"]);
    expect(result.events.find((event) => event.type === "shield_consumed")).toMatchObject({ sourceId: "obstacle-a" });
    expect(result.events.find((event) => event.type === "crash")).toMatchObject({ sourceId: "obstacle-z" });
  });

  test("a Boost pickup banks a charge, and spending it enables a later swept impact", () => {
    const raceTrack = track({ powerUpOpportunities: [{ id: "boost", progress: 5, allowedEffects: ["boost"] }] });
    let state = race(raceTrack, [
      { id: "attacker", lane: 0, progress: 0, speed: 600 },
      { id: "target", lane: 0, progress: 15, speed: 0 },
    ]);
    const lane = state.powerUpOpportunities[0]!.lane;
    state = putCar(putCar(state, "attacker", { lane }), "target", { lane });

    // Collecting Boost arms a charge and nothing else: the pickup tick is not an impact.
    const collected = advanceRace(state, {});
    expect(car(collected.state, "attacker").boostCharges).toBe(1);
    expect(car(collected.state, "attacker").boostTicksRemaining).toBe(0);
    expect(car(collected.state, "target").crashRecoveryTicksRemaining).toBe(0);
    // Without a spend the same closing speed is only an Ordinary collision.
    expect(collected.events.map((event) => event.type)).toEqual(["power_up_collected", "ordinary_collision"]);

    state = putCar(
      putCar(collected.state, "attacker", { progress: 0, speed: 600, ordinaryContact: null }),
      "target", { progress: 15, speed: 0 },
    );
    const spent = advanceRace(state, { attacker: { useBoost: true } });
    expect(car(spent.state, "attacker").boostCharges).toBe(0);
    expect(car(spent.state, "attacker").boostTicksRemaining).toBe(PROVISIONAL_DURATIONS.boostTicks);
    expect(car(spent.state, "target").crashRecoveryTicksRemaining).toBe(PROVISIONAL_DURATIONS.crashRecoveryTicks);
    expect(spent.events.map((event) => event.type)).toEqual(["boost_activated", "boosted_impact", "crash"]);
  });

  test("a shielded target consumes Shield and slows/constrains the still-boosted attacker", () => {
    let state = race(track(), [
      { id: "attacker", lane: 1, progress: 0, speed: 600 },
      { id: "target", lane: 1, progress: 15, speed: 0 },
    ]);
    state = putCar(putCar(state, "attacker", { boostTicksRemaining: 10 }), "target", { shieldTicksRemaining: 10 });
    const result = advanceRace(state, {});
    const attacker = car(result.state, "attacker");
    const target = car(result.state, "target");
    const gap = (target.progress - attacker.progress + state.track.length) % state.track.length;

    expect(target.crashRecoveryTicksRemaining).toBe(0);
    expect(target.shieldTicksRemaining).toBe(0);
    expect(attacker.speed).toBe(600 * PROVISIONAL_CONTACT.trailingSpeedRetainedOnEntry);
    expect(attacker.boostTicksRemaining).toBe(9);
    expect(gap).toBeCloseTo(PROVISIONAL_CONTACT.minimumLongitudinalGap);
  });

  test("collection refreshes an active timer and Lap advance rerolls/reset opportunities", () => {
    const raceTrack = track({ powerUpOpportunities: [{ id: "shield", progress: 119, allowedEffects: ["shield"] }] });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 118, speed: 60 }], 7);
    const lane = state.powerUpOpportunities[0]!.lane;
    state = putCar(state, "car", { lane, shieldTicksRemaining: 2, nextCheckpointIndex: 3 });
    const result = advanceRace(state, {});

    expect(car(result.state).shieldTicksRemaining).toBe(PROVISIONAL_DURATIONS.shieldTicks);
    expect(car(result.state).completedLaps).toBe(1);
    expect(result.state.powerUpLap).toBe(1);
    expect(result.state.powerUpOpportunities[0]!.collected).toBe(false);
  });
});

describe("Hazards", () => {
  function hazardRace(): RaceState {
    const raceTrack = track({
      powerUpOpportunities: [{ id: "hazard-power", progress: 10, allowedEffects: ["hazard"] }],
      hazardPlacementLocations: [{ id: "behind", progress: 5, allowedLanes: [0, 1, 2, 3] }],
    });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 0, speed: 600 }], 42);
    return putCar(state, "car", { lane: state.powerUpOpportunities[0]!.lane });
  }

  test("places deterministically behind the collector, warns, activates, and is consumed by Shield", () => {
    let state = hazardRace();
    const placed = advanceRace(state, {});
    expect(placed.state.hazards).toHaveLength(1);
    expect(placed.state.hazards[0]).toMatchObject({ id: "hazard-0", locationId: "behind", progress: 5, phase: "warning", ticksRemaining: PROVISIONAL_DURATIONS.hazardWarningTicks });
    expect(placed.events.some((event) => event.type === "hazard_placed")).toBe(true);

    state = {
      ...putCar(placed.state, "car", { speed: 0 }),
      configuration: { laps: 100 },
    };
    state = advanceTicks(state, PROVISIONAL_DURATIONS.hazardWarningTicks - 1);
    state = putCar(state, "car", { progress: 0, speed: 300, lane: state.hazards[0]!.lane, shieldTicksRemaining: 10 });
    const impact = advanceRace(state, {});
    expect(impact.state.hazards).toEqual([]);
    expect(car(impact.state).crashRecoveryTicksRemaining).toBe(0);
    expect(car(impact.state).shieldTicksRemaining).toBe(0);
    expect(impact.events.map((event) => event.type)).toEqual(["hazard_activated", "shield_consumed", "hazard_consumed"]);
  });

  test("an active Hazard uses swept seam collision, crashes once, and later active Hazards clean up", () => {
    let state = race(track(), [{ id: "car", lane: 2, progress: 118, speed: 300 }]);
    const hazards: HazardState[] = [
      { id: "seam", locationId: "seam-location", progress: 2, lane: 2, phase: "active", ticksRemaining: 20 },
      { id: "expires", locationId: "other", progress: 50, lane: 3, phase: "active", ticksRemaining: 1 },
    ];
    state = { ...state, hazards };
    const result = advanceRace(state, {});

    expect(car(result.state).progress).toBe(2);
    expect(car(result.state).crashRecoveryTicksRemaining).toBe(PROVISIONAL_DURATIONS.crashRecoveryTicks);
    expect(result.state.hazards).toEqual([]);
    expect(result.events.filter((event) => event.type === "crash")).toHaveLength(1);
    expect(result.events.some((event) => event.type === "hazard_removed" && event.hazardId === "expires")).toBe(true);
  });

  test("no valid authored placement still collects successfully without creating a Hazard", () => {
    const raceTrack = track({
      powerUpOpportunities: [{ id: "hazard-power", progress: 10, allowedEffects: ["hazard"] }],
      hazardPlacementLocations: [],
    });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 0, speed: 600 }]);
    const pickupLane = state.powerUpOpportunities[0]!.lane;
    const blockedLane = ((pickupLane + 1) % 4) as LaneIndex;
    state = {
      ...putCar(state, "car", { lane: pickupLane }),
      track: {
        ...raceTrack,
        fixedObstacles: [{ id: "block", progress: 5, lane: blockedLane }],
        hazardPlacementLocations: [{ id: "behind", progress: 5, allowedLanes: [blockedLane] }],
      },
    };
    const result = advanceRace(state, {});
    expect(result.events.filter((event) => event.type === "power_up_collected")).toHaveLength(1);
    expect(result.events.some((event) => event.type === "hazard_placed")).toBe(false);
    expect(result.state.hazards).toEqual([]);
  });

  test("same-tick Hazard winner and full output are independent of Car storage order", () => {
    let state = race(track(), [
      { id: "b", lane: 1, progress: 0, speed: 300 },
      { id: "a", lane: 1, progress: 0, speed: 300 },
    ]);
    state = { ...state, hazards: [{ id: "hazard", locationId: "location", progress: 5, lane: 1, phase: "active", ticksRemaining: 50 }] };
    const reversed = { ...state, cars: [...state.cars].reverse() };
    const first = advanceRace(state, {});
    const second = advanceRace(reversed, {});

    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual(first.events);
    expect(first.events.find((event) => event.type === "hazard_consumed")).toMatchObject({ carId: "a" });
  });
});

describe("Milestone 5 interface gaps", () => {
  test("sweeps a fixed obstacle across the Track seam without tunneling", () => {
    const result = advanceRace(race(
      track({ fixedObstacles: [{ id: "seam-obstacle", progress: 2, lane: 2 }] }),
      [{ id: "car", lane: 2, progress: 118, speed: 300 }],
    ), {});

    expect(car(result.state)).toMatchObject({ progress: 2, speed: 0, crashRecoveryTicksRemaining: PROVISIONAL_DURATIONS.crashRecoveryTicks });
    expect(result.events).toContainEqual(expect.objectContaining({ type: "crash", sourceId: "seam-obstacle" }));
  });

  test("Crash clears both changing and blocked-return Lane transitions", () => {
    const raceTrack = track({ fixedObstacles: [{ id: "obstacle", progress: 10, lane: 2 }] });
    for (const phase of ["changing", "returning"] as const) {
      let state = race(raceTrack, [{ id: "car", lane: 1, progress: 0, speed: 600 }]);
      state = putCar(state, "car", {
        laneTransition: { from: 1, to: 2, progress: 0.5, phase },
        ordinaryContact: { leadingCarId: "old-contact", enteredAtTick: 0 },
      });
      const result = advanceRace(state, {});
      expect(car(result.state)).toMatchObject({ lane: 1, laneTransition: null, ordinaryContact: null, speed: 0 });
      expect(result.events.filter((event) => event.type === "crash")).toHaveLength(1);
    }
  });

  test("a Crash immediately before start/finish prevents that finish", () => {
    let state = race(
      track({ fixedObstacles: [{ id: "last-moment", progress: 119, lane: 0 }] }),
      [{ id: "car", lane: 0, progress: 118, speed: 60 }],
    );
    state = putCar(state, "car", { nextCheckpointIndex: 3 });
    const result = advanceRace(state, {});

    expect(car(result.state)).toMatchObject({ progress: 119, result: "racing", completedLaps: 0, finishedAtSeconds: null });
    expect(result.events.some((event) => event.type === "lap" || event.type === "finish")).toBe(false);
  });

  test("Ghost clear-position checks non-Ghost Cars across the cyclic seam", () => {
    let state = race(track(), [
      { id: "ghost", lane: 1, progress: 119, speed: 0 },
      { id: "blocker", lane: 1, progress: 1, speed: 0 },
    ]);
    state = putCar(state, "ghost", { ghost: true, ghostMinimumTicksRemaining: 0 });
    const blocked = advanceRace(state, {});
    expect(car(blocked.state, "ghost").ghost).toBe(true);

    state = putCar(blocked.state, "blocker", { progress: 2 });
    const clear = advanceRace(state, {});
    expect(car(clear.state, "ghost").ghost).toBe(false);
    expect(clear.events).toContainEqual(expect.objectContaining({ type: "ghost_end", carId: "ghost" }));
  });

  test("sweeps a pickup across the seam and exact-time contention uses stable Car id", () => {
    const raceTrack = track({ powerUpOpportunities: [{ id: "seam-pickup", progress: 2, allowedEffects: ["shield"] }] });
    let state = race(raceTrack, [
      { id: "b", lane: 0, progress: 118, speed: 300 },
      { id: "a", lane: 0, progress: 118, speed: 300 },
    ]);
    const lane = state.powerUpOpportunities[0]!.lane;
    state = putCar(putCar(state, "a", { lane }), "b", { lane });
    const reversed = { ...state, cars: [...state.cars].reverse() };
    const first = advanceRace(state, {});
    const second = advanceRace(reversed, {});

    expect(first.events.filter((event) => event.type === "power_up_collected")).toEqual([
      expect.objectContaining({ carId: "a", opportunityId: "seam-pickup" }),
    ]);
    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual(first.events);
  });

  test("Shield activates, refreshes, expires, and protects from exactly one obstacle", () => {
    const pickupTrack = track({ powerUpOpportunities: [{ id: "shield", progress: 5, allowedEffects: ["shield"] }] });
    let state = race(pickupTrack, [{ id: "car", lane: 0, progress: 0, speed: 300 }]);
    state = putCar(state, "car", { lane: state.powerUpOpportunities[0]!.lane, shieldTicksRemaining: 2 });
    const refreshed = advanceRace(state, {});
    expect(car(refreshed.state).shieldTicksRemaining).toBe(PROVISIONAL_DURATIONS.shieldTicks);

    const obstacleTrack = track({ fixedObstacles: [{ id: "obstacle", progress: 5, lane: 1 }] });
    state = race(obstacleTrack, [{ id: "car", lane: 1, progress: 0, speed: 300 }]);
    const protectedResult = advanceRace(putCar(state, "car", { shieldTicksRemaining: 2 }), {});
    expect(car(protectedResult.state)).toMatchObject({ shieldTicksRemaining: 0, crashRecoveryTicksRemaining: 0 });
    expect(protectedResult.events.map((event) => event.type)).toEqual(["shield_consumed"]);

    const expired = advanceRace(putCar(state, "car", { shieldTicksRemaining: 1 }), {});
    expect(car(expired.state).crashRecoveryTicksRemaining).toBe(PROVISIONAL_DURATIONS.crashRecoveryTicks);
    expect(expired.events.map((event) => event.type)).toEqual(["crash"]);
  });

  test("Boost charges cap, spend one at a time, and apply only their speed multiplier", () => {
    const boostProfile: CarProfile = { ...profile, accelerationPerSecondSquared: 900, topSpeedPerSecond: 120 };
    const boostTrack = track({ powerUpOpportunities: [{ id: "boost", progress: 5, allowedEffects: ["boost"] }] });
    let state = createRace({
      track: boostTrack,
      configuration: { laps: 10 },
      cars: [{ id: "car", lane: 0, progress: 0, speed: 120, profile: boostProfile }],
      seed: 3,
    });

    // A collection at the charge cap is absorbed rather than stacked.
    state = putCar(state, "car", {
      lane: state.powerUpOpportunities[0]!.lane,
      boostCharges: PROVISIONAL_POWER_UPS.maximumBoostCharges,
    });
    const capped = advanceRace(state, {});
    expect(car(capped.state).boostCharges).toBe(PROVISIONAL_POWER_UPS.maximumBoostCharges);

    // Spending one charge raises the top speed for exactly the Boost duration.
    state = putCar(capped.state, "car", { progress: 20, speed: 120, boostCharges: 2 });
    const spent = advanceRace(state, { car: { useBoost: true } });
    expect(car(spent.state)).toMatchObject({
      speed: boostProfile.topSpeedPerSecond * PROVISIONAL_POWER_UPS.boostSpeedMultiplier,
      boostTicksRemaining: PROVISIONAL_DURATIONS.boostTicks,
      boostCharges: 1,
    });

    // A second spend while already boosting is rejected, so charges cannot be chained.
    const chained = advanceRace(spent.state, { car: { useBoost: true } });
    expect(car(chained.state).boostCharges).toBe(1);

    state = putCar(spent.state, "car", { progress: 40, speed: 150, boostTicksRemaining: 1 });
    const expired = advanceRace(state, {});
    expect(car(expired.state)).toMatchObject({ speed: boostProfile.topSpeedPerSecond, boostTicksRemaining: 0 });
  });

  test("one boosted attacker crashes a three-Car chain independent of storage order", () => {
    let state = race(track(), [
      { id: "attacker", lane: 1, progress: 0, speed: 1_200 },
      { id: "target-a", lane: 1, progress: 10, speed: 0 },
      { id: "target-b", lane: 1, progress: 20, speed: 0 },
    ]);
    state = putCar(state, "attacker", { boostTicksRemaining: 10 });
    const reversed = { ...state, cars: [...state.cars].reverse() };
    const first = advanceRace(state, {});
    const second = advanceRace(reversed, {});

    expect(first.events.filter((event) => event.type === "boosted_impact").map((event) => event.targetCarId)).toEqual(["target-a", "target-b"]);
    expect(["target-a", "target-b"].map((id) => car(first.state, id).crashRecoveryTicksRemaining)).toEqual([
      PROVISIONAL_DURATIONS.crashRecoveryTicks,
      PROVISIONAL_DURATIONS.crashRecoveryTicks,
    ]);
    expect(car(first.state, "attacker").boostTicksRemaining).toBe(9);
    expect(second.state).toEqual(first.state);
    expect(second.events).toEqual(first.events);
  });

  test("an active unshielded Hazard crashes and consumes itself", () => {
    let state = race(track(), [{ id: "car", lane: 3, progress: 0, speed: 300 }]);
    state = { ...state, hazards: [{ id: "hazard", locationId: "location", progress: 5, lane: 3, phase: "active", ticksRemaining: 20 }] };
    const result = advanceRace(state, {});

    expect(car(result.state).crashRecoveryTicksRemaining).toBe(PROVISIONAL_DURATIONS.crashRecoveryTicks);
    expect(result.state.hazards).toEqual([]);
    expect(result.events.map((event) => event.type)).toEqual(["crash", "hazard_consumed"]);
  });

  test("warning and active Hazard phases last their exact provisional durations", () => {
    let state = race(track(), [{ id: "car", lane: 0, progress: 20, speed: 0 }]);
    state = {
      ...state,
      configuration: { laps: 100 },
      hazards: [{ id: "hazard", locationId: "location", progress: 60, lane: 3, phase: "warning", ticksRemaining: PROVISIONAL_DURATIONS.hazardWarningTicks }],
    };
    state = advanceTicks(state, PROVISIONAL_DURATIONS.hazardWarningTicks - 1);
    expect(state.hazards[0]).toMatchObject({ phase: "warning", ticksRemaining: 1 });

    const activated = advanceRace(state, {});
    expect(activated.state.hazards[0]).toMatchObject({ phase: "active", ticksRemaining: PROVISIONAL_DURATIONS.hazardActiveTicks });
    state = advanceTicks(activated.state, PROVISIONAL_DURATIONS.hazardActiveTicks - 1);
    expect(state.hazards[0]).toMatchObject({ phase: "active", ticksRemaining: 1 });

    const removed = advanceRace(state, {});
    expect(removed.state.hazards).toEqual([]);
    expect(removed.events).toContainEqual(expect.objectContaining({ type: "hazard_removed", hazardId: "hazard" }));
  });

  test("Hazard placement skips invalid candidates and falls back to a valid authored location", () => {
    const raceTrack = track({
      powerUpOpportunities: [{ id: "hazard-power", progress: 10, allowedEffects: ["hazard"] }],
      hazardPlacementLocations: [
        { id: "invalid", progress: 5, allowedLanes: [1] },
        { id: "valid", progress: 4, allowedLanes: [2] },
      ],
    });
    let state = race(raceTrack, [{ id: "car", lane: 0, progress: 0, speed: 600 }]);
    state = {
      ...putCar(state, "car", { lane: state.powerUpOpportunities[0]!.lane }),
      hazards: [{ id: "existing", locationId: "invalid", progress: 5, lane: 1, phase: "warning", ticksRemaining: 20 }],
    };
    const result = advanceRace(state, {});

    expect(result.events.find((event) => event.type === "hazard_placed")).toMatchObject({ locationId: "valid", lane: 2 });
    expect(result.state.hazards.some((hazard) => hazard.locationId === "valid")).toBe(true);
  });
});
