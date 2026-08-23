import { describe, expect, test } from "bun:test";
import {
  PROVISIONAL_CAR_PROFILE,
  SYNTHETIC_CIRCULAR_TRACK,
  TICK_SECONDS,
  advanceRace,
  createRace,
  type CarInput,
  type CarProfile,
  type RaceState,
  type Track,
} from "../src/race";

const constantSpeedProfile: CarProfile = {
  accelerationPerSecondSquared: 0,
  topSpeedPerSecond: 10_000,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 3,
};

function raceAt(options: {
  progress?: number;
  speed?: number;
  lane?: 0 | 1 | 2 | 3;
  profile?: CarProfile;
  track?: Track;
  laps?: number;
} = {}): RaceState {
  return createRace({
    track: options.track ?? SYNTHETIC_CIRCULAR_TRACK,
    configuration: { laps: options.laps ?? 2 },
    cars: [
      {
        id: "car-a",
        profile: options.profile ?? constantSpeedProfile,
        lane: options.lane ?? 1,
        ...(options.progress === undefined ? {} : { progress: options.progress }),
        ...(options.speed === undefined ? {} : { speed: options.speed }),
      },
    ],
  });
}

const noLaneInput: CarInput = {};

describe("Track progress and Lap validation", () => {
  test("the fixture has exactly four Lanes and sweeps ordered markers across the seam", () => {
    const initial = raceAt({ progress: 20, speed: 3_000 });
    const result = advanceRace(initial, { "car-a": noLaneInput });

    expect(SYNTHETIC_CIRCULAR_TRACK.lanes.map((lane) => lane.index)).toEqual([0, 1, 2, 3]);
    expect(result.state.cars[0]!.progress).toBe(0);
    expect(result.state.cars[0]!.completedLaps).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "checkpoint",
      "checkpoint",
      "checkpoint",
      "lap",
    ]);
  });

  test("does not advance a Lap when Checkpoints are first crossed out of order", () => {
    let state = raceAt({ progress: 50, speed: 2_400 });
    let result = advanceRace(state, { "car-a": noLaneInput });

    expect(result.state.cars[0]!.completedLaps).toBe(0);
    expect(result.state.cars[0]!.nextCheckpointIndex).toBe(0);
    expect(result.events).toEqual([]);

    state = result.state;
    result = advanceRace(state, { "car-a": noLaneInput });
    expect(result.state.cars[0]!.nextCheckpointIndex).toBe(3);
    expect(result.state.cars[0]!.completedLaps).toBe(0);
  });

  test("ignores a repeated or out-of-order Checkpoint instead of advancing validation", () => {
    const created = raceAt({ progress: 20, speed: 600 });
    const car = created.cars[0]!;
    const state: RaceState = {
      ...created,
      cars: [{ ...car, nextCheckpointIndex: 1 }],
    };

    const result = advanceRace(state, { "car-a": noLaneInput });
    expect(result.state.cars[0]!.nextCheckpointIndex).toBe(1);
    expect(result.state.cars[0]!.completedLaps).toBe(0);
    expect(result.events).toEqual([]);
  });

  test("processes several markers and more than one seam crossing in one tick", () => {
    const initial = raceAt({ progress: 20, speed: 7_200, laps: 3 });
    const result = advanceRace(initial, { "car-a": noLaneInput });

    expect(result.state.cars[0]!.completedLaps).toBe(2);
    expect(result.state.cars[0]!.progress).toBe(20);
    expect(result.events.filter((event) => event.type === "checkpoint")).toHaveLength(6);
    expect(result.events.filter((event) => event.type === "lap")).toHaveLength(2);
  });
});

describe("Lane transitions", () => {
  test("rejects changes beyond Lane bounds", () => {
    const left = advanceRace(raceAt({ lane: 0 }), { "car-a": { laneChange: -1 } });
    const right = advanceRace(raceAt({ lane: 3 }), { "car-a": { laneChange: 1 } });

    expect(left.state.cars[0]!.laneTransition).toBeNull();
    expect(left.state.cars[0]!.lane).toBe(0);
    expect(right.state.cars[0]!.laneTransition).toBeNull();
    expect(right.state.cars[0]!.lane).toBe(3);
  });

  test("changes only to an adjacent Lane over authoritative ticks", () => {
    let state = raceAt({ lane: 1 });
    state = advanceRace(state, { "car-a": { laneChange: 1 } }).state;
    expect(state.cars[0]!.lane).toBe(1);
    expect(state.cars[0]!.laneTransition).toEqual({ from: 1, to: 2, progress: 1 / 3, phase: "changing" });

    state = advanceRace(state, { "car-a": noLaneInput }).state;
    expect(state.cars[0]!.laneTransition!.progress).toBeCloseTo(2 / 3);
    state = advanceRace(state, { "car-a": noLaneInput }).state;
    expect(state.cars[0]!.lane).toBe(2);
    expect(state.cars[0]!.laneTransition).toBeNull();
  });
});

describe("Speed integration", () => {
  test("automatically accelerates without player movement input", () => {
    const result = advanceRace(raceAt({ profile: PROVISIONAL_CAR_PROFILE }), {});

    expect(result.state.cars[0]!.speed).toBeCloseTo(
      PROVISIONAL_CAR_PROFILE.accelerationPerSecondSquared * TICK_SECONDS,
    );
    expect(result.state.cars[0]!.progress).toBeGreaterThan(0);
  });

  test("clamps acceleration at top speed", () => {
    const profile: CarProfile = {
      ...PROVISIONAL_CAR_PROFILE,
      topSpeedPerSecond: 10,
      accelerationPerSecondSquared: 300,
    };
    const result = advanceRace(raceAt({ profile, speed: 9 }), {});
    expect(result.state.cars[0]!.speed).toBe(10);
  });

  test("automatic speed stays finite and never below zero", () => {
    const profile: CarProfile = { ...PROVISIONAL_CAR_PROFILE, topSpeedPerSecond: 0 };
    const result = advanceRace(raceAt({ profile, speed: 0 }), {});
    expect(result.state.cars[0]!.speed).toBe(0);
    expect(Number.isFinite(result.state.cars[0]!.speed)).toBe(true);
  });
});

describe("Finish behavior", () => {
  const finishTrack: Track = {
    id: "finish-timing",
    length: 100,
    lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
    startFinish: 0,
    checkpoints: [
      { id: "one", progress: 92 },
      { id: "two", progress: 94 },
      { id: "three", progress: 96 },
    ],
  };

  test("records a sub-tick finish time", () => {
    const result = advanceRace(
      raceAt({ track: finishTrack, progress: 90, speed: 600, laps: 1 }),
      { "car-a": noLaneInput },
    );

    expect(result.state.status).toBe("finished");
    expect(result.state.cars[0]!.finishedAtSeconds).toBeCloseTo(TICK_SECONDS / 2);
    expect(result.events.at(-1)).toMatchObject({ type: "finish", timeSeconds: TICK_SECONDS / 2 });
  });

  test("finishes a Car and emits its finish event at most once", () => {
    const first = advanceRace(
      raceAt({ track: finishTrack, progress: 90, speed: 600, laps: 1 }),
      { "car-a": noLaneInput },
    );
    const second = advanceRace(first.state, { "car-a": { laneChange: 1 } });

    expect(first.events.filter((event) => event.type === "finish")).toHaveLength(1);
    expect(second.events).toEqual([]);
    expect(second.state).toBe(first.state);
  });
});

test("replaying identical input frames produces identical state and events", () => {
  const frames: CarInput[] = Array.from({ length: 180 }, (_, tick) => ({
    ...(tick === 20 || tick === 80 ? { laneChange: 1 as const } : {}),
    ...(tick === 140 ? { laneChange: -1 as const } : {}),
  }));

  function replay(): unknown {
    let state = createRace({
      track: SYNTHETIC_CIRCULAR_TRACK,
      configuration: { laps: 3 },
      cars: [{ id: "car-a", profile: PROVISIONAL_CAR_PROFILE, lane: 0 }],
    });
    const events = [];
    for (const input of frames) {
      const result = advanceRace(state, { "car-a": input });
      state = result.state;
      events.push(...result.events);
    }
    return { state, events };
  }

  expect(replay()).toEqual(replay());
});
