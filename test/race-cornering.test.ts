import { describe, expect, test } from "bun:test";

import {
  PROVISIONAL_CORNERING,
  PROVISIONAL_DURATIONS,
  PROVISIONAL_SLIPSTREAM,
  PROVISIONAL_CONTACT,
  TICK_SECONDS,
  advanceRace,
  createRace,
  type CarProfile,
  type CarState,
  type LaneIndex,
  type RaceState,
  type Track,
  type TrackCorner,
} from "../src/race";

const profile: CarProfile = {
  accelerationPerSecondSquared: 30,
  topSpeedPerSecond: 30,
  brakingPerSecondSquared: 14,
  laneChangeDurationTicks: 4,
};

/** A left-hander at 20..40 whose limits fall from the inside Lane 0 to the outside Lane 3. */
const CORNER: TrackCorner = {
  id: "corner-a",
  fromProgress: 20,
  toProgress: 80,
  laneSpeedLimits: [14, 12, 10, 8],
};

function track(corners: readonly TrackCorner[] = [CORNER]): Track {
  return {
    id: "cornering-fixture",
    length: 120,
    lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
    startFinish: 0,
    checkpoints: [{ id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 }],
    fixedObstacles: [],
    powerUpOpportunities: [],
    hazardPlacementLocations: [],
    corners,
  };
}

function race(
  cars: readonly { id: string; lane: LaneIndex; progress: number; speed: number }[],
  corners?: readonly TrackCorner[],
): RaceState {
  return createRace({
    track: track(corners),
    configuration: { laps: 20 },
    cars: cars.map((car) => ({ ...car, profile })),
    seed: 1,
  });
}

function put(state: RaceState, id: string, patch: Partial<CarState>): RaceState {
  return { ...state, cars: state.cars.map((car) => (car.id === id ? { ...car, ...patch } : car)) };
}

function car(state: RaceState, id = "car"): CarState {
  return state.cars.find((candidate) => candidate.id === id)!;
}

/** Advances `ticks` times and returns the final state plus every event seen. */
function run(state: RaceState, ticks: number, inputs: Record<string, { useBoost?: boolean }> = {}) {
  const events = [];
  let current = state;
  for (let tick = 0; tick < ticks; tick += 1) {
    const result = advanceRace(current, inputs);
    current = result.state;
    events.push(...result.events);
  }
  return { state: current, events };
}

/** Advances until every Car has settled to a steady speed, so limits are read at rest. */
function settle(state: RaceState, ticks = 40): RaceState {
  return run(state, ticks).state;
}

describe("authored corner speed limits", () => {
  test("holds a Car to its Lane's limit inside a corner", () => {
    // Entering at the limit, the throttle neither accelerates past it nor drops below it.
    const state = race([{ id: "car", lane: 3, progress: 22, speed: 8 }]);
    const settled = settle(state);

    expect(car(settled).progress).toBeLessThan(CORNER.toProgress);
    expect(car(settled).speed).toBeCloseTo(8, 10);
  });

  test("lifts at the braking rate before the corner rather than at its mouth", () => {
    const approaching = race([{ id: "car", lane: 3, progress: 10, speed: 30 }]);
    const control = race([{ id: "car", lane: 3, progress: 10, speed: 30 }], []);
    const braked = advanceRace(approaching, {});

    // The corner is within the braking lookahead, so the lift has already started, and it
    // proceeds at the profile's braking rate rather than snapping to the arrival speed.
    expect(car(braked.state).speed)
      .toBeCloseTo(30 - profile.brakingPerSecondSquared * TICK_SECONDS, 10);
    expect(car(advanceRace(control, {}).state).speed).toBe(30);
  });

  test("ignores a corner further ahead than the braking lookahead", () => {
    const far = race([{ id: "car", lane: 3, progress: 20 - PROVISIONAL_CORNERING.brakingLookaheadProgress - 1, speed: 20 }]);
    expect(car(advanceRace(far, {}).state).speed).toBeGreaterThan(20);
  });

  test("the inside Lane is the fast line through the same corner", () => {
    const state = race([
      { id: "inside", lane: 0, progress: 22, speed: 5 },
      { id: "outside", lane: 3, progress: 22, speed: 5 },
    ]);
    const settled = settle(state);

    expect(car(settled, "inside").speed).toBeCloseTo(14, 10);
    expect(car(settled, "outside").speed).toBeCloseTo(8, 10);
    expect(car(settled, "inside").progress).toBeGreaterThan(car(settled, "outside").progress);
  });

  test("a Car straddling two Lanes is held to the tighter of the two limits", () => {
    const straddling = put(race([{ id: "car", lane: 0, progress: 22, speed: 5 }]), "car", {
      laneTransition: { from: 0, to: 1, progress: 0.5, phase: "changing" },
    });
    // The transition completes almost immediately, so read the limit on the first tick.
    expect(car(advanceRace(straddling, {}).state).speed)
      .toBeCloseTo(5 + profile.accelerationPerSecondSquared * TICK_SECONDS, 10);
    expect(car(settle(straddling)).speed).toBeCloseTo(12, 10);
  });

  test("a corner that crosses the Track seam still applies", () => {
    const seam = race([{ id: "car", lane: 0, progress: 112, speed: 9 }], [
      { id: "corner-seam", fromProgress: 110, toProgress: 15, laneSpeedLimits: [9, 9, 9, 9] },
    ]);
    const settled = settle(seam);

    // The Car has crossed the seam and is still inside the corner, still held to the limit.
    expect(car(settled).progress).toBeLessThan(15);
    expect(car(settled).speed).toBeCloseTo(9, 10);
  });

  test("no corners means no lift at all", () => {
    const open = race([{ id: "car", lane: 0, progress: 25, speed: 5 }], []);
    expect(car(settle(open, 60)).speed).toBeCloseTo(profile.topSpeedPerSecond, 10);
  });

  test("a Car dropped deep into a corner far over the limit de-slots even while braking", () => {
    // Nothing in normal play does this -- the throttle lifts at the braking point -- but it
    // records that pressure answers to the speed carried, not to the Racer's intent.
    const dropped = race([{ id: "car", lane: 3, progress: 25, speed: 30 }]);
    expect(run(dropped, 40).events.some((event) => event.type === "crash" && event.cause === "deslot")).toBe(true);
  });
});

describe("de-slot risk", () => {
  function boostedInCorner(lane: LaneIndex): RaceState {
    return put(race([{ id: "car", lane, progress: 21, speed: 30 }]), "car", {
      boostTicksRemaining: PROVISIONAL_DURATIONS.boostTicks,
      speed: 30,
    });
  }

  test("Boost carries a Car past the Lane limit and de-slots it, after one warning", () => {
    const result = run(boostedInCorner(3), 40);
    const kinds = result.events.map((event) => event.type);

    expect(kinds.filter((kind) => kind === "deslot_warning")).toHaveLength(1);
    expect(kinds.indexOf("deslot_warning")).toBeLessThan(kinds.indexOf("crash"));
    const crash = result.events.find((event) => event.type === "crash")!;
    expect(crash).toMatchObject({ type: "crash", carId: "car", cause: "deslot", sourceId: "corner-a" });
    expect(car(result.state).crashRecoveryTicksRemaining).toBeGreaterThan(0);
    expect(car(result.state).deslotPressure).toBe(0);
  });

  test("Shield does not absorb a de-slot: it is driver error, not an impact", () => {
    const shielded = put(boostedInCorner(3), "car", { shieldTicksRemaining: PROVISIONAL_DURATIONS.shieldTicks });
    const result = run(shielded, 40);

    expect(result.events.some((event) => event.type === "shield_consumed")).toBe(false);
    expect(result.events.some((event) => event.type === "crash" && event.cause === "deslot")).toBe(true);
  });

  test("a mild overspeed survives the corner instead of crashing", () => {
    // A limit just under the boosted top speed: pressure builds far slower than the corner lasts.
    const mild = put(race([{ id: "car", lane: 0, progress: 21, speed: 30 }], [
      { id: "corner-mild", fromProgress: 20, toProgress: 80, laneSpeedLimits: [34, 34, 34, 34] },
    ]), "car", { boostTicksRemaining: PROVISIONAL_DURATIONS.boostTicks, speed: 37.5 });
    const result = run(mild, 40);

    expect(car(result.state).progress).toBeLessThan(80);
    expect(result.events.some((event) => event.type === "crash")).toBe(false);
    expect(car(result.state).deslotPressure).toBeGreaterThan(0);
    expect(car(result.state).deslotPressure).toBeLessThan(PROVISIONAL_CORNERING.deslotThreshold);
  });

  test("pressure decays once the Car is back under the limit", () => {
    const pressured = put(race([{ id: "car", lane: 3, progress: 22, speed: 8 }]), "car", {
      deslotPressure: PROVISIONAL_CORNERING.deslotThreshold * 0.5,
      speed: 8,
    });
    const relieved = advanceRace(pressured, {});

    expect(car(relieved.state).deslotPressure)
      .toBeCloseTo(PROVISIONAL_CORNERING.deslotThreshold * 0.5 - PROVISIONAL_CORNERING.deslotRecoveryPerTick, 10);
    expect(car(run(pressured, 60).state).deslotPressure).toBe(0);
  });

  test("a Car outside every corner never builds pressure", () => {
    const straight = put(race([{ id: "car", lane: 0, progress: 100, speed: 30 }]), "car", {
      boostTicksRemaining: PROVISIONAL_DURATIONS.boostTicks,
      speed: 37.5,
    });
    const result = run(straight, 15);

    expect(car(result.state).deslotPressure).toBe(0);
    expect(result.events.some((event) => event.type === "deslot_warning")).toBe(false);
  });

  test("de-slot resolution does not depend on Car storage order", () => {
    const state = put(put(race([
      { id: "alpha", lane: 3, progress: 21, speed: 30 },
      { id: "beta", lane: 2, progress: 60, speed: 30 },
    ]), "alpha", { boostTicksRemaining: PROVISIONAL_DURATIONS.boostTicks, speed: 30 }),
      "beta", { boostTicksRemaining: PROVISIONAL_DURATIONS.boostTicks, speed: 30 });
    const reversed = { ...state, cars: [...state.cars].reverse() };

    expect(run(state, 30).state.cars).toEqual(run(reversed, 30).state.cars);
  });
});

describe("slipstream", () => {
  const gap = 5;
  const expected = (1 - (gap - PROVISIONAL_CONTACT.minimumLongitudinalGap)
    / (PROVISIONAL_SLIPSTREAM.rangeProgress - PROVISIONAL_CONTACT.minimumLongitudinalGap))
    * PROVISIONAL_SLIPSTREAM.maximumBonus;

  function pair(trailingLane: LaneIndex, distance: number): RaceState {
    return race([
      { id: "lead", lane: 0, progress: 60 + distance, speed: profile.topSpeedPerSecond },
      { id: "trail", lane: trailingLane, progress: 60, speed: profile.topSpeedPerSecond },
    ], []);
  }

  test("a Car in the wake exceeds its own top speed by a bounded amount", () => {
    const result = advanceRace(pair(0, gap), {});

    expect(car(result.state, "trail").drafting).toBe(true);
    // One tick of acceleration toward the raised ceiling, which is above the plain top speed.
    expect(car(result.state, "trail").speed).toBeGreaterThan(profile.topSpeedPerSecond);
    expect(car(result.state, "lead").drafting).toBe(false);
    expect(car(result.state, "lead").speed).toBe(profile.topSpeedPerSecond);
  });

  test("the wake ceiling is exactly the bounded bonus", () => {
    // Starting above the ceiling, the throttle lifts back down onto it.
    const over = put(pair(0, gap), "trail", { speed: 40 });
    expect(car(advanceRace(over, {}).state, "trail").speed)
      .toBeCloseTo(40 - profile.brakingPerSecondSquared * TICK_SECONDS, 10);

    const settled = put(pair(0, gap), "trail", { speed: profile.topSpeedPerSecond * (1 + expected) });
    expect(car(advanceRace(settled, {}).state, "trail").speed)
      .toBeCloseTo(profile.topSpeedPerSecond * (1 + expected), 10);
  });

  test("the bonus fades to nothing at the edge of the wake", () => {
    const edge = advanceRace(pair(0, PROVISIONAL_SLIPSTREAM.rangeProgress), {});
    const beyond = advanceRace(pair(0, PROVISIONAL_SLIPSTREAM.rangeProgress + 0.001), {});

    expect(car(edge.state, "trail").speed).toBeCloseTo(profile.topSpeedPerSecond, 6);
    expect(car(beyond.state, "trail").drafting).toBe(false);
  });

  test("a Car in another Lane is not in the wake", () => {
    expect(car(advanceRace(pair(2, gap), {}).state, "trail").drafting).toBe(false);
  });

  test("Ghost and crashed Cars neither give nor take a slipstream", () => {
    const ghosted = put(pair(0, gap), "lead", { ghost: true });
    expect(car(advanceRace(ghosted, {}).state, "trail").drafting).toBe(false);

    const crashed = put(pair(0, gap), "trail", { crashRecoveryTicksRemaining: 10 });
    expect(car(advanceRace(crashed, {}).state, "trail").drafting).toBe(false);
  });

  test("slipstream is resolved from the pre-tick batch, not from storage order", () => {
    const state = pair(0, gap);
    const reversed = { ...state, cars: [...state.cars].reverse() };
    expect(advanceRace(state, {}).state.cars).toEqual(advanceRace(reversed, {}).state.cars);
  });

  test("a corner limit still caps a drafting Car", () => {
    const drafting = race([
      { id: "lead", lane: 3, progress: 22 + gap, speed: 8 },
      { id: "trail", lane: 3, progress: 22, speed: 8 },
    ]);
    const settled = settle(drafting);

    expect(car(settled, "trail").drafting).toBe(true);
    expect(car(settled, "trail").speed).toBeLessThanOrEqual(8);
  });
});

describe("Boost as a spent resource", () => {
  function armed(charges: number): RaceState {
    return put(race([{ id: "car", lane: 0, progress: 60, speed: 10 }], []), "car", { boostCharges: charges });
  }

  test("spending needs a charge and emits one activation", () => {
    const empty = advanceRace(armed(0), { car: { useBoost: true } });
    expect(empty.events).toHaveLength(0);
    expect(car(empty.state).boostTicksRemaining).toBe(0);

    const spent = advanceRace(armed(2), { car: { useBoost: true } });
    expect(spent.events).toMatchObject([{ type: "boost_activated", carId: "car", chargesRemaining: 1 }]);
    expect(car(spent.state).boostCharges).toBe(1);
  });

  test("charges survive a Crash so the Racer keeps what they collected", () => {
    const crashed = put(armed(2), "car", { crashRecoveryTicksRemaining: 5 });
    expect(car(advanceRace(crashed, {}).state).boostCharges).toBe(2);
  });

  test("a Ghost Car cannot spend a charge", () => {
    const ghosted = put(armed(1), "car", { ghost: true, ghostMinimumTicksRemaining: 10 });
    const result = advanceRace(ghosted, { car: { useBoost: true } });

    expect(car(result.state).boostCharges).toBe(1);
    expect(car(result.state).boostTicksRemaining).toBe(0);
  });
});
