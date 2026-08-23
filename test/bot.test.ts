import { describe, expect, test } from "bun:test";
import { BOT_DIFFICULTY_PROFILES, botInput } from "../src/bot";
import { BOT_REACTION_TICKS } from "../src/multiplayer-config";
import {
  MILESTONE_5_TRACK,
  PROVISIONAL_CAR_PROFILE,
  SYNTHETIC_CIRCULAR_TRACK,
  advanceRace,
  createRace,
  type CarInput,
  type CarState,
  type HazardState,
  type LaneIndex,
  type RaceCarStart,
  type RaceEvent,
  type RaceState,
  type Track,
} from "../src/race";

const tacticalTrack: Track = {
  ...SYNTHETIC_CIRCULAR_TRACK,
  id: "bot-test",
  fixedObstacles: [],
  powerUpOpportunities: [],
  hazardPlacementLocations: [],
};

function race(
  cars: readonly Omit<RaceCarStart, "profile">[] = [{ id: "B", lane: 1 }],
  track: Track = tacticalTrack,
  seed = 123,
): RaceState {
  return createRace({
    track,
    configuration: { laps: 1 },
    cars: cars.map((car) => ({ ...car, profile: PROVISIONAL_CAR_PROFILE })),
    seed,
  });
}

function putCar(state: RaceState, id: string, values: Partial<CarState>): RaceState {
  return {
    ...state,
    cars: state.cars.map((car) => car.id === id ? { ...car, ...values } : car),
  };
}

function botStep(state: RaceState, ids = state.cars.map((car) => car.id)): { state: RaceState; events: readonly RaceEvent[] } {
  return advanceRace(state, Object.fromEntries(ids.map((id) => [id, botInput(state, id)])));
}

function expectCarInput(input: CarInput): void {
  expect(Object.keys(input).every((key) => key === "laneChange" || key === "useBoost")).toBe(true);
  if (input.laneChange !== undefined) expect([-1, 1]).toContain(input.laneChange);
  if (input.useBoost !== undefined) expect(input.useBoost).toBe(true);
}

describe("botInput decisions", () => {
  test("uses the configured difficulty cadence and lookahead only", () => {
    const obstacleTrack: Track = {
      ...tacticalTrack,
      fixedObstacles: [{ id: "obstacle", progress: 15, lane: 1 }],
      powerUpOpportunities: [{ id: "pickup", progress: 10, allowedEffects: ["shield"] }],
    };
    const created = race([{ id: "B", lane: 1 }], obstacleTrack);
    const state: RaceState = {
      ...created,
      tick: 6,
      powerUpOpportunities: [{ id: "pickup", lane: 1, effect: "shield", collected: false }],
    };

    expect(botInput(state, "B", BOT_DIFFICULTY_PROFILES.easy)).toEqual({});
    expect(botInput(state, "B", BOT_DIFFICULTY_PROFILES.normal)).toEqual({ laneChange: -1 });
    expect(botInput(state, "B", BOT_DIFFICULTY_PROFILES.hard)).toEqual({ laneChange: -1 });

    const farther: RaceState = { ...state, track: { ...state.track, fixedObstacles: [{ id: "farther", progress: 21, lane: 1 }] } };
    expect(botInput(farther, "B", BOT_DIFFICULTY_PROFILES.normal)).toEqual({});
    expect(botInput(farther, "B", BOT_DIFFICULTY_PROFILES.hard)).toEqual({ laneChange: -1 });

    const cadenceState = race([{ id: "B", lane: 1 }], {
      ...tacticalTrack,
      fixedObstacles: [{ id: "near", progress: 10, lane: 1 }],
    });
    const reactionTicks = (difficulty: keyof typeof BOT_DIFFICULTY_PROFILES) => Array.from({ length: 25 }, (_, tick) => tick)
      .filter((tick) => botInput({ ...cadenceState, tick }, "B", BOT_DIFFICULTY_PROFILES[difficulty]).laneChange !== undefined);
    expect(reactionTicks("easy")).toEqual([6, 18]);
    expect(reactionTicks("normal")).toEqual([0, 6, 12, 18, 24]);
    expect(reactionTicks("hard")).toEqual([0, 3, 6, 9, 12, 15, 18, 21, 24]);
  });

  test("is deterministic for identical state and seed and only emits CarInput", () => {
    const first = race(undefined, MILESTONE_5_TRACK, 987654);
    const second = race(undefined, MILESTONE_5_TRACK, 987654);
    expect(first).toEqual(second);
    for (const profile of Object.values(BOT_DIFFICULTY_PROFILES)) {
      const firstInput = botInput(first, "B", profile);
      const secondInput = botInput(second, "B", profile);
      expect(firstInput).toEqual(secondInput);
      expectCarInput(firstInput);
      expectCarInput(botInput(first, "missing", profile));
    }
  });

  test("waits for its stable reaction tick before changing lane", () => {
    const obstacleTrack: Track = {
      ...tacticalTrack,
      fixedObstacles: [{ id: "obstacle", progress: 10, lane: 1 }],
    };
    let state = race([{ id: "A", lane: 1 }], obstacleTrack);

    expect(botInput(state, "A")).toEqual({});
    state = botStep(state).state;
    expect(state.tick).toBe(1);
    expect(botInput(state, "A")).toEqual({ laneChange: -1 });

    const delayedTicks = Array.from({ length: BOT_REACTION_TICKS }, (_, tick) => ({ ...state, tick } as RaceState))
      .filter((candidate) => botInput(candidate, "A").laneChange !== undefined)
      .map((candidate) => candidate.tick);
    expect(delayedTicks).toEqual([1]);
  });

  test("avoids a fixed obstacle and an active hazard", () => {
    const obstacleState = race([{ id: "B", lane: 1 }], {
      ...tacticalTrack,
      fixedObstacles: [{ id: "obstacle", progress: 10, lane: 1 }],
    });
    const hazard: HazardState = {
      id: "hazard",
      locationId: "location",
      progress: 10,
      lane: 1,
      phase: "active",
      ticksRemaining: 20,
    };
    const hazardState: RaceState = { ...race(), hazards: [hazard] };

    expect(botInput(obstacleState, "B")).toEqual({ laneChange: -1 });
    expect(botInput(hazardState, "B")).toEqual({ laneChange: -1 });
    expect(botStep(obstacleState).state.cars[0]!.laneTransition?.to).toBe(0);
    expect(botStep(hazardState).state.cars[0]!.laneTransition?.to).toBe(0);
  });

  test("selects the viable adjacent lane and avoids a nearby racing car where possible", () => {
    const constrained = race([{ id: "B", lane: 1 }], {
      ...tacticalTrack,
      fixedObstacles: [
        { id: "ahead", progress: 10, lane: 1 },
        { id: "left", progress: 10, lane: 0 },
      ],
    });
    const traffic = race([
      { id: "B", lane: 1, progress: 0 },
      { id: "other", lane: 1, progress: 10 },
    ]);

    expect(botInput(constrained, "B")).toEqual({ laneChange: 1 });
    expect(botInput(traffic, "B")).toEqual({ laneChange: -1 });
    expect(botStep(constrained, ["B"]).state.cars.find((car) => car.id === "B")!.laneTransition?.to).toBe(2);
  });

  test("prefers an available pickup through ordinary lane choice", () => {
    const pickupTrack: Track = {
      ...tacticalTrack,
      powerUpOpportunities: [{ id: "pickup", progress: 10, allowedEffects: ["shield"] }],
    };
    const created = race([{ id: "B", lane: 1 }], pickupTrack);
    const state: RaceState = {
      ...created,
      powerUpOpportunities: [{ id: "pickup", lane: 2, effect: "shield", collected: false }],
    };

    expect(botInput(state, "B")).toEqual({ laneChange: 1 });
    expect(botStep(state).state.cars[0]!.laneTransition?.to).toBe(2);
  });

  test("keeps lane changes adjacent and inside both lane bounds", () => {
    const atLeft = race([{ id: "B", lane: 0 }], {
      ...tacticalTrack,
      fixedObstacles: [{ id: "left-edge", progress: 10, lane: 0 }],
    });
    const atRight = race([{ id: "B", lane: 3 }], {
      ...tacticalTrack,
      fixedObstacles: [{ id: "right-edge", progress: 10, lane: 3 }],
    });
    const leftInput = botInput(atLeft, "B");
    const rightInput = botInput(atRight, "B");

    expect(leftInput).toEqual({ laneChange: 1 });
    expect(rightInput).toEqual({ laneChange: -1 });
    expect(botStep(atLeft).state.cars[0]!.laneTransition).toMatchObject({ from: 0, to: 1 });
    expect(botStep(atRight).state.cars[0]!.laneTransition).toMatchObject({ from: 3, to: 2 });
  });

  test("does not issue another lane command while a blocked transition returns", () => {
    let state = race([
      { id: "B", lane: 1, progress: 0 },
      { id: "blocker", lane: 2, progress: 0 },
    ]);
    state = putCar(state, "B", {
      laneTransition: { from: 1, to: 2, progress: 0, phase: "changing" },
    });

    expect(botInput(state, "B")).toEqual({});
    const blocked = botStep(state, ["B"]);
    expect(blocked.events).toContainEqual(expect.objectContaining({ type: "blocked_lane_change", carId: "B" }));
    expect(blocked.state.cars.find((car) => car.id === "B")!.laneTransition?.phase).toBe("returning");
    expect(botInput(blocked.state, "B")).toEqual({});
  });

  test("is inactive during Crash recovery and for finished or DNF cars", () => {
    let state = race([
      { id: "B", lane: 1, progress: 5, speed: 10 },
      { id: "finished", lane: 2, progress: 20 },
      { id: "dnf", lane: 3, progress: 30 },
    ]);
    state = putCar(state, "B", { crashRecoveryTicksRemaining: 2 });
    state = putCar(state, "finished", { result: "finished", speed: 0 });
    state = putCar(state, "dnf", { result: "dnf", speed: 0 });

    for (const profile of Object.values(BOT_DIFFICULTY_PROFILES)) {
      expect(botInput(state, "B", profile)).toEqual({});
      expect(botInput(state, "finished", profile)).toEqual({});
      expect(botInput(state, "dnf", profile)).toEqual({});
    }

    const advanced = botStep(state);
    const recovering = advanced.state.cars.find((car) => car.id === "B")!;
    expect(recovering).toMatchObject({ progress: 5, speed: 0, crashRecoveryTicksRemaining: 1 });
    expect(advanced.state.cars.find((car) => car.id === "finished")!.progress).toBe(20);
    expect(advanced.state.cars.find((car) => car.id === "dnf")!.progress).toBe(30);
  });

  test("drives a Ghost with ordinary obstacle-aware behavior", () => {
    let state = race([{ id: "B", lane: 1 }], {
      ...tacticalTrack,
      fixedObstacles: [{ id: "obstacle", progress: 10, lane: 1 }],
    });
    state = putCar(state, "B", { ghost: true, ghostMinimumTicksRemaining: 30 });

    const reactionTick = { easy: 6, normal: 0, hard: 0 } as const;
    for (const difficulty of Object.keys(BOT_DIFFICULTY_PROFILES) as (keyof typeof BOT_DIFFICULTY_PROFILES)[]) {
      expect(botInput({ ...state, tick: reactionTick[difficulty] }, "B", BOT_DIFFICULTY_PROFILES[difficulty]))
        .toEqual({ laneChange: -1 });
    }
    const advanced = botStep(state);
    expect(advanced.state.cars[0]!.laneTransition?.to).toBe(0);
    expect(advanced.state.cars[0]!.ghost).toBe(true);
  });

  test("is independent of car, obstacle, hazard, and pickup storage order", () => {
    const authored: Track = {
      ...tacticalTrack,
      fixedObstacles: [
        { id: "z", progress: 12, lane: 1 },
        { id: "a", progress: 11, lane: 0 },
      ],
      powerUpOpportunities: [
        { id: "z-pickup", progress: 12, allowedEffects: ["boost"] },
        { id: "a-pickup", progress: 11, allowedEffects: ["shield"] },
      ],
    };
    let state = race([
      { id: "B", lane: 1, progress: 0 },
      { id: "z-car", lane: 3, progress: 8 },
      { id: "a-car", lane: 2, progress: 9 },
    ], authored, 55);
    state = {
      ...state,
      hazards: [
        { id: "z-hazard", locationId: "z", progress: 14, lane: 3, phase: "active", ticksRemaining: 10 },
        { id: "a-hazard", locationId: "a", progress: 13, lane: 2, phase: "active", ticksRemaining: 10 },
      ],
    };
    const reversed: RaceState = {
      ...state,
      track: {
        ...state.track,
        fixedObstacles: [...state.track.fixedObstacles!].reverse(),
        powerUpOpportunities: [...state.track.powerUpOpportunities!].reverse(),
      },
      cars: [...state.cars].reverse(),
      hazards: [...state.hazards].reverse(),
      powerUpOpportunities: [...state.powerUpOpportunities].reverse(),
    };

    for (const profile of Object.values(BOT_DIFFICULTY_PROFILES)) {
      expect(botInput(reversed, "B", profile)).toEqual(botInput(state, "B", profile));
    }
  });
});

test("human and every Bot difficulty use the same automatic forward movement rules", () => {
  for (const profile of Object.values(BOT_DIFFICULTY_PROFILES)) {
    const state = race([
      { id: "human", lane: 3, progress: 0 },
      { id: "bot", lane: 0, progress: 0 },
    ]);
    const advanced = advanceRace(state, {
      human: {},
      bot: botInput(state, "bot", profile),
    });
    const human = advanced.state.cars.find((car) => car.id === "human")!;
    const bot = advanced.state.cars.find((car) => car.id === "bot")!;

    expect(bot.speed).toBe(human.speed);
    expect(bot.progress).toBe(human.progress);
    expect(Object.keys(botInput(state, "bot", profile))).not.toContain("throttle");
  }
});

test("a representative same-seed bot race deterministically finishes within a bounded tick count", () => {
  function run(): { state: RaceState; events: readonly RaceEvent[] } {
    let state = race([
      { id: "bot-a", lane: 0, progress: 0 },
      { id: "bot-b", lane: 1, progress: 114 },
      { id: "bot-c", lane: 2, progress: 108 },
      { id: "bot-d", lane: 3, progress: 102 },
    ], MILESTONE_5_TRACK, 424242);
    const events: RaceEvent[] = [];
    const maximumTicks = 3_000;

    while (state.status === "racing" && state.tick < maximumTicks) {
      const advanced = botStep(state);
      state = advanced.state;
      events.push(...advanced.events);
    }

    expect(state.status).toBe("finished");
    expect(state.tick).toBeLessThanOrEqual(maximumTicks);
    expect(state.cars.every((car) => car.result === "finished")).toBe(true);
    return { state, events };
  }

  expect(run()).toEqual(run());
});


// --- Racecraft -----------------------------------------------------------------------------

/** A Track whose single corner rewards Lane 0 and punishes Lane 3. */
const corneringTrack: Track = {
  ...tacticalTrack,
  id: "bot-cornering",
  corners: [{ id: "corner-a", fromProgress: 40, toProgress: 90, laneSpeedLimits: [20, 16, 12, 8] }],
};

/** The Race moved to a tick on which this Bot's stable reaction phase has it deciding. */
function reactingTick(state: RaceState, id: string, reactionTicks: number): RaceState {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (Math.imul(hash, 31) + id.charCodeAt(index)) >>> 0;
  return { ...state, tick: (reactionTicks - (hash % reactionTicks)) % reactionTicks };
}

/** The same corner mirrored, so the quick Lane is the high index instead of the low one. */
const mirroredTrack: Track = {
  ...tacticalTrack,
  id: "bot-cornering-mirrored",
  corners: [{ id: "corner-a", fromProgress: 40, toProgress: 90, laneSpeedLimits: [8, 12, 16, 20] }],
};

describe("Bot racecraft", () => {
  test("moves toward the faster Lane while approaching a corner", () => {
    const approaching = reactingTick(race([{ id: "B", lane: 3, progress: 30 }], corneringTrack), "B", 3);
    expect(botInput(approaching, "B", BOT_DIFFICULTY_PROFILES.hard).laneChange).toBe(-1);
  });

  test("an easy Bot does not read the racing line at all", () => {
    // Mirrored, so the quick Lane is 3. Equal scores break to the lowest Lane index, so a Bot
    // that is not reading the line simply stays put in Lane 0 while a hard Bot climbs to it.
    const approaching = reactingTick(race([{ id: "B", lane: 0, progress: 30 }], mirroredTrack), "B", 12);
    expect(botInput(approaching, "B", BOT_DIFFICULTY_PROFILES.easy).laneChange).toBeUndefined();

    const reading = reactingTick(race([{ id: "B", lane: 0, progress: 30 }], mirroredTrack), "B", 3);
    expect(botInput(reading, "B", BOT_DIFFICULTY_PROFILES.hard).laneChange).toBe(1);
  });

  test("holds its Lane once inside the corner rather than straddling two limits", () => {
    // Mid-corner a change would occupy both Lanes and be held to the tighter of the two, so
    // the line is worth taking only before the corner.
    const inside = reactingTick(race([{ id: "B", lane: 3, progress: 60 }], corneringTrack), "B", 3);
    expect(botInput(inside, "B", BOT_DIFFICULTY_PROFILES.hard).laneChange).toBeUndefined();
  });

  test("a hard Bot refuses a Boost whose run would carry too much corner", () => {
    const armed = (progress: number): RaceState =>
      putCar(reactingTick(race([{ id: "B", lane: 0, progress }], corneringTrack), "B", 3), "B", { boostCharges: 1 });

    // Entering the corner: the whole charge would be spent inside it.
    expect(botInput(armed(38), "B", BOT_DIFFICULTY_PROFILES.hard).useBoost).toBeUndefined();
    // Leaving it: the exposure is nearly over, which is the cheap moment to spend.
    expect(botInput(armed(88), "B", BOT_DIFFICULTY_PROFILES.hard).useBoost).toBe(true);
  });

  test("an easy Bot spends a charge the moment it holds one", () => {
    const armed = putCar(reactingTick(race([{ id: "B", lane: 0, progress: 38 }], corneringTrack), "B", 12), "B", { boostCharges: 1 });
    expect(botInput(armed, "B", BOT_DIFFICULTY_PROFILES.easy).useBoost).toBe(true);
  });

  test("never spends a charge it does not hold, or a second one while boosting", () => {
    const boosting = putCar(race([{ id: "B", lane: 0, progress: 10 }], corneringTrack), "B", { boostCharges: 2, boostTicksRemaining: 30 });
    expect(botInput(boosting, "B", BOT_DIFFICULTY_PROFILES.easy).useBoost).toBeUndefined();

    const empty = race([{ id: "B", lane: 0, progress: 10 }], corneringTrack);
    expect(botInput(empty, "B", BOT_DIFFICULTY_PROFILES.easy).useBoost).toBeUndefined();
  });

  test("a hard Bot defends the Lane a Car is closing on, and other difficulties do not", () => {
    // Clear of every corner, so nothing but the defending term separates the Lanes: a Bot that
    // is not defending drifts to the lowest Lane index on the tie-break.
    const chased = (reactionTicks: number): RaceState => reactingTick(race([
      { id: "B", lane: 1, progress: 100 },
      { id: "C", lane: 1, progress: 96 },
    ], corneringTrack), "B", reactionTicks);

    expect(botInput(chased(3), "B", BOT_DIFFICULTY_PROFILES.hard).laneChange).toBeUndefined();
    expect(botInput(chased(BOT_REACTION_TICKS), "B", BOT_DIFFICULTY_PROFILES.normal).laneChange).toBe(-1);
    expect(BOT_DIFFICULTY_PROFILES.hard.defendsLane).toBe(true);
    expect(BOT_DIFFICULTY_PROFILES.normal.defendsLane).toBe(false);
  });

  test("difficulty is ordered by result, not by Car profile", () => {
    // Every Bot drives the identical Car profile, so any ordering here comes from racecraft.
    expect(BOT_DIFFICULTY_PROFILES.hard.lineWeight).toBeGreaterThan(BOT_DIFFICULTY_PROFILES.normal.lineWeight);
    expect(BOT_DIFFICULTY_PROFILES.normal.lineWeight).toBeGreaterThan(BOT_DIFFICULTY_PROFILES.easy.lineWeight);
    expect(BOT_DIFFICULTY_PROFILES.hard.boostCornerExposureProgress)
      .toBeLessThan(BOT_DIFFICULTY_PROFILES.normal.boostCornerExposureProgress);

    const finishes = (difficulty: "easy" | "normal" | "hard"): number => {
      let state = createRace({
        track: MILESTONE_5_TRACK,
        configuration: { laps: 2 },
        cars: [{ id: "B", lane: 1, profile: PROVISIONAL_CAR_PROFILE }],
        seed: 5,
      });
      for (let tick = 0; tick < 30 * 240 && state.status === "racing"; tick += 1) {
        state = advanceRace(state, { B: botInput(state, "B", BOT_DIFFICULTY_PROFILES[difficulty]) }).state;
      }
      return state.cars[0]!.finishedAtSeconds ?? Number.POSITIVE_INFINITY;
    };

    expect(finishes("hard")).toBeLessThanOrEqual(finishes("easy"));
  });
});
