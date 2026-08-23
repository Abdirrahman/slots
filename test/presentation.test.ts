import { describe, expect, test } from "bun:test";
import { WORKSHOP_PATH } from "../src/authored-track";
import {
  TICK_SECONDS,
  advanceRace,
  type CarInput,
  type RaceState,
} from "../src/race";
import {
  LOCAL_CAR_ID,
  PROVISIONAL_PRESENTATION,
  consumeFrameTime,
  createLocalRace,
  interpolateCarPose,
  lanePosition,
  raceStandings,
  speedCameraFov,
  sampleLaneRibbon,
  sampleRoadEdges,
  sampleTrackPose,
} from "../src/presentation";

function runSchedule(frameSeconds: readonly number[], inputs: readonly CarInput[]): RaceState {
  let state = createLocalRace();
  let accumulator = 0;
  let inputIndex = 0;

  for (const elapsedSeconds of frameSeconds) {
    const frame = consumeFrameTime(accumulator, elapsedSeconds);
    accumulator = frame.accumulatorSeconds;

    for (let step = 0; step < frame.steps && inputIndex < inputs.length; step += 1) {
      state = advanceRace(state, { [LOCAL_CAR_ID]: inputs[inputIndex] }).state;
      inputIndex += 1;
    }
  }

  expect(inputIndex).toBe(inputs.length);
  return state;
}

describe("fixed-step local simulation", () => {
  test("produces the same authoritative result under different render schedules", () => {
    const inputs: CarInput[] = Array.from({ length: 180 }, (_, tick) => ({
      ...(tick === 20 || tick === 90 ? { laneChange: 1 as const } : {}),
      ...(tick === 140 ? { laneChange: -1 as const } : {}),
    }));

    const oneTickFrames = Array.from({ length: 180 }, () => TICK_SECONDS);
    const unevenFrames = Array.from({ length: 60 }, () => [
      TICK_SECONDS / 2,
      TICK_SECONDS * 1.5,
      TICK_SECONDS,
    ]).flat();

    expect(runSchedule(unevenFrames, inputs)).toEqual(runSchedule(oneTickFrames, inputs));
  });

  test("caps a stalled frame instead of running an unbounded catch-up", () => {
    expect(consumeFrameTime(0, 10).steps).toBeLessThanOrEqual(8);
  });

  test("restart creates a fresh independent Race state", () => {
    const first = advanceRace(createLocalRace(), {
      [LOCAL_CAR_ID]: { laneChange: 1 },
    }).state;
    const restarted = createLocalRace();

    expect(restarted.tick).toBe(0);
    expect(restarted.status).toBe("racing");
    expect(restarted.cars[0]!.progress).toBe(0);
    expect(restarted.cars[0]!.laneTransition).toBeNull();
    expect(restarted).not.toBe(first);
  });
});

describe("logical Track pose mapping", () => {
  test("keeps every Lane position and Track heading continuous at authored boundaries and the cyclic seam", () => {
    const track = createLocalRace().track;
    const epsilon = 0.000_001;

    for (const boundary of WORKSHOP_PATH) {
      for (const lane of track.lanes) {
        const before = sampleTrackPose(track, boundary.progress - epsilon, lane.index);
        const after = sampleTrackPose(track, boundary.progress + epsilon, lane.index);
        const headingDelta = Math.atan2(
          Math.sin(after.heading - before.heading),
          Math.cos(after.heading - before.heading),
        );

        expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.001);
        expect(Math.abs(headingDelta)).toBeLessThan(0.001);
      }
    }
  });

  test("keeps one progress unit worth the same length of Track everywhere", () => {
    const track = createLocalRace().track;
    const samples = 2_800;
    const step = track.length / samples;
    let shortest = Infinity;
    let longest = 0;
    let previous = sampleTrackPose(track, 0, 1.5);

    for (let index = 1; index <= samples; index += 1) {
      const pose = sampleTrackPose(track, index * step, 1.5);
      const distance = Math.hypot(pose.x - previous.x, pose.y - previous.y, pose.z - previous.z) / step;
      shortest = Math.min(shortest, distance);
      longest = Math.max(longest, distance);
      previous = pose;
    }

    expect(longest / shortest).toBeLessThan(1.15);
  });

  test("crosses over itself only where the flyover clears the Track underneath", () => {
    const track = createLocalRace().track;
    const roadHalfWidth = (3 + PROVISIONAL_PRESENTATION.roadEdgeLaneMargin * 2) * PROVISIONAL_PRESENTATION.laneSpacing / 2;
    let overlaps = 0;
    let clearance = Infinity;

    for (let first = 0; first < track.length; first += 0.5) {
      for (let second = first + 40; second < track.length - 40 + first; second += 0.5) {
        const near = sampleTrackPose(track, first, 1.5);
        const far = sampleTrackPose(track, second % track.length, 1.5);
        if (Math.hypot(near.x - far.x, near.z - far.z) > roadHalfWidth * 2) continue;
        overlaps += 1;
        clearance = Math.min(clearance, Math.abs(near.y - far.y));
      }
    }

    expect(overlaps).toBeGreaterThan(0);
    expect(clearance).toBeGreaterThan(4);
  });

  test("banks every meaningful turn so its outside Lane sits above its inside Lane", () => {
    const track = createLocalRace().track;
    let banked = 0;

    for (let progress = 0; progress < track.length; progress += 0.5) {
      const center = sampleTrackPose(track, progress, 1.5);
      const ahead = sampleTrackPose(track, progress + 4, 1.5);
      const turn = Math.atan2(
        Math.sin(ahead.heading - center.heading),
        Math.cos(ahead.heading - center.heading),
      );
      if (Math.abs(center.bank) < 0.06 || Math.abs(turn) < 0.05) continue;
      banked += 1;
      const inside = sampleTrackPose(track, progress, turn < 0 ? 3 : 0);
      const outside = sampleTrackPose(track, progress, turn < 0 ? 0 : 3);
      expect(outside.y).toBeGreaterThan(inside.y);
    }

    expect(banked).toBeGreaterThan(100);
  });

  test("stays on the bench with a drivable minimum turn radius", () => {
    const track = createLocalRace().track;
    let tightest = Infinity;

    for (let progress = 0; progress < track.length; progress += 0.5) {
      const behind = sampleTrackPose(track, progress - 2, 1.5);
      const center = sampleTrackPose(track, progress, 1.5);
      const ahead = sampleTrackPose(track, progress + 2, 1.5);
      const turn = Math.abs(Math.atan2(
        Math.sin(ahead.heading - behind.heading),
        Math.cos(ahead.heading - behind.heading),
      ));
      const distance = Math.hypot(ahead.x - behind.x, ahead.z - behind.z);
      if (turn > 0.001) tightest = Math.min(tightest, distance / turn);
      expect(Math.abs(center.x)).toBeLessThan(38);
      expect(Math.abs(center.z)).toBeLessThan(21);
      expect(center.y).toBeGreaterThanOrEqual(0);
    }

    expect(tightest).toBeGreaterThan(PROVISIONAL_PRESENTATION.laneSpacing * 4);
  });

  test("returns finite stable poses for representative cyclic progress and Lane values", () => {
    const track = createLocalRace().track;
    for (const progress of [-1, 0, 13, 40.5, 80, 120, 159.999, 160, 321]) {
      for (const lane of [-0.7, 0, 1.5, 3, 3.7]) {
        const pose = sampleTrackPose(track, progress, lane);
        expect(Object.values(pose).every(Number.isFinite)).toBe(true);
        expect(sampleTrackPose(track, progress, lane)).toEqual(pose);
      }
    }
  });

  test("keeps four Lane centers ordered and evenly spaced across the banked surface", () => {
    const track = createLocalRace().track;
    for (let progress = 0; progress < track.length; progress += 2) {
      const center = sampleTrackPose(track, progress, 1.5);
      // The banked lateral direction: level across the road, then rolled about the heading.
      const normalX = -Math.cos(center.heading) * Math.cos(center.bank);
      const normalY = Math.sin(center.bank);
      const normalZ = Math.sin(center.heading) * Math.cos(center.bank);
      const lanes = track.lanes.map((lane) => sampleTrackPose(track, progress, lane.index));
      const offsets = lanes.map((pose) => (pose.x - center.x) * normalX
        + (pose.y - center.y) * normalY
        + (pose.z - center.z) * normalZ);

      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
      for (let lane = 1; lane < lanes.length; lane += 1) {
        const previous = lanes[lane - 1]!;
        const current = lanes[lane]!;
        expect(offsets[lane]! - offsets[lane - 1]!).toBeCloseTo(PROVISIONAL_PRESENTATION.laneSpacing, 10);
        expect(Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z))
          .toBeCloseTo(PROVISIONAL_PRESENTATION.laneSpacing, 10);
      }
    }
  });

  test("places start/finish and authored logical markers on intended Lane centers", () => {
    const track = createLocalRace().track;
    const markers = [
      ...track.lanes.map((lane) => ({ progress: track.startFinish, lane: lane.index })),
      ...track.checkpoints.flatMap((checkpoint) => track.lanes.map((lane) => ({ progress: checkpoint.progress, lane: lane.index }))),
      ...(track.fixedObstacles ?? []).map((obstacle) => ({ progress: obstacle.progress, lane: obstacle.lane })),
      ...(track.powerUpOpportunities ?? []).flatMap((opportunity) => track.lanes.map((lane) => ({ progress: opportunity.progress, lane: lane.index }))),
      ...(track.hazardPlacementLocations ?? []).flatMap((location) => location.allowedLanes.map((lane) => ({ progress: location.progress, lane }))),
    ];

    for (const marker of markers) {
      const center = sampleTrackPose(track, marker.progress, 1.5);
      const pose = sampleTrackPose(track, marker.progress, marker.lane);
      const deltaX = pose.x - center.x;
      const deltaY = pose.y - center.y;
      const deltaZ = pose.z - center.z;
      const expectedOffset = (marker.lane - 1.5) * PROVISIONAL_PRESENTATION.laneSpacing;
      const lateral = deltaX * -Math.cos(center.heading) * Math.cos(center.bank)
        + deltaY * Math.sin(center.bank)
        + deltaZ * Math.sin(center.heading) * Math.cos(center.bank);

      expect(lateral).toBeCloseTo(expectedOffset, 10);
      expect(deltaX * Math.sin(center.heading) + deltaZ * Math.cos(center.heading)).toBeCloseTo(0, 10);
    }
  });

  test("interpolates progress forward across the cyclic seam", () => {
    const race = createLocalRace();
    const car = race.cars[0]!;
    const previous = { ...car, progress: race.track.length - 1 };
    const current = { ...car, progress: 1 };

    const pose = interpolateCarPose(race.track, previous, current, 0.5);
    const seam = sampleTrackPose(race.track, 0, 1);

    expect(pose.x).toBeCloseTo(seam.x);
    expect(pose.z).toBeCloseTo(seam.z);
  });

  test("centers each Lane ribbon on the same canonical pose source used by Cars", () => {
    const track = createLocalRace().track;
    for (const progress of [0, 18, 40, 73, 101, 124, 159.9]) {
      for (const lane of track.lanes) {
        const ribbon = sampleLaneRibbon(track, progress, lane.index);
        const car = sampleTrackPose(track, progress, lane.index);

        expect((ribbon.left.x + ribbon.right.x) / 2).toBeCloseTo(car.x, 10);
        expect((ribbon.left.z + ribbon.right.z) / 2).toBeCloseTo(car.z, 10);
        expect(ribbon.left.heading).toBeCloseTo(car.heading, 10);
        expect(ribbon.right.heading).toBeCloseTo(car.heading, 10);
      }
    }
  });

  test("keeps Lane ribbon samples continuous through authored boundaries and the cyclic seam", () => {
    const track = createLocalRace().track;
    const before = structuredClone(track);
    const epsilon = 0.000_001;

    for (const boundary of WORKSHOP_PATH) {
      for (const lane of track.lanes) {
        const left = sampleLaneRibbon(track, boundary.progress - epsilon, lane.index);
        const right = sampleLaneRibbon(track, boundary.progress + epsilon, lane.index);
        expect(Math.hypot(right.left.x - left.left.x, right.left.z - left.left.z)).toBeLessThan(0.001);
        expect(Math.hypot(right.right.x - left.right.x, right.right.z - left.right.z)).toBeLessThan(0.001);
      }
    }
    expect(track).toEqual(before);
  });

  test("uses one finite stable Track-surface height for grounded Cars and Lane ribbons", () => {
    expect(Number.isFinite(PROVISIONAL_PRESENTATION.trackSurfaceY)).toBe(true);
    expect(PROVISIONAL_PRESENTATION.trackSurfaceY).toBe(0.02);
    expect(PROVISIONAL_PRESENTATION.laneRibbonY).toBeGreaterThan(PROVISIONAL_PRESENTATION.trackSurfaceY);
    expect(PROVISIONAL_PRESENTATION.laneRibbonY - PROVISIONAL_PRESENTATION.trackSurfaceY).toBeLessThan(0.03);
  });

  test("centers road sampling on the same canonical pose source used by Cars", () => {
    const track = createLocalRace().track;
    for (const progress of [0, 18, 40, 73, 101, 124, 159.9]) {
      const road = sampleRoadEdges(track, progress);
      const car = sampleTrackPose(track, progress, 1.5);

      expect((road.left.x + road.right.x) / 2).toBeCloseTo(car.x, 10);
      expect((road.left.z + road.right.z) / 2).toBeCloseTo(car.z, 10);
      expect(road.left.heading).toBeCloseTo(car.heading, 10);
      expect(road.right.heading).toBeCloseTo(car.heading, 10);
    }
  });

  test("uses authoritative Lane-transition progress", () => {
    const car = createLocalRace().cars[0]!;
    const transitioning = {
      ...car,
      laneTransition: { from: 1 as const, to: 2 as const, progress: 0.25, phase: "changing" as const },
    };

    expect(lanePosition(transitioning)).toBe(1.25);
    expect(sampleTrackPose(createLocalRace().track, 0, lanePosition(transitioning)).lanePosition).toBe(1.25);
  });

  test("samples authoritative blocked-return progress deterministically", () => {
    const car = createLocalRace().cars[0]!;
    const returning = {
      ...car,
      laneTransition: { from: 1 as const, to: 2 as const, progress: 0.625, phase: "returning" as const },
    };
    expect(lanePosition(returning)).toBe(1.625);
    expect(lanePosition(structuredClone(returning))).toBe(1.625);
  });

  test("pose sampling and rendering interpolation do not mutate Race outcomes", () => {
    const initial = createLocalRace();
    const expected = advanceRace(initial, {}).state;
    const sampled = createLocalRace();

    sampleTrackPose(sampled.track, sampled.cars[0]!.progress, lanePosition(sampled.cars[0]!));
    interpolateCarPose(sampled.track, sampled.cars[0]!, sampled.cars[0]!, 0.75);

    expect(advanceRace(sampled, {}).state).toEqual(expected);
  });
});

describe("Race standings and speed-driven framing", () => {
  const track = { length: 100, startFinish: 0 };
  const racer = (id: string, progress: number, completedLaps: number) =>
    ({ id, progress, completedLaps, result: "racing" as const, finishedAtSeconds: null });

  test("orders by distance travelled, not by raw Track progress", () => {
    const standings = raceStandings(track, [
      racer("a", 10, 2),
      racer("b", 90, 1),
      racer("c", 20, 2),
    ]);
    expect(standings.map((standing) => standing.carId)).toEqual(["c", "a", "b"]);
    expect(standings.map((standing) => standing.position)).toEqual([1, 2, 3]);
  });

  test("reports the gap to the Car ahead and to the leader", () => {
    const standings = raceStandings(track, [racer("a", 40, 0), racer("b", 25, 0), racer("c", 10, 0)]);
    expect(standings[0]).toMatchObject({ carId: "a", gapToAhead: null, gapToLeader: null });
    expect(standings[1]).toMatchObject({ carId: "b", gapToAhead: 15, gapToLeader: 15 });
    expect(standings[2]).toMatchObject({ carId: "c", gapToAhead: 15, gapToLeader: 30 });
  });

  test("finished Cars hold their finishing order ahead of everyone still running", () => {
    const standings = raceStandings(track, [
      { id: "slow-finisher", progress: 0, completedLaps: 3, result: "finished", finishedAtSeconds: 90 },
      { id: "leader-on-track", progress: 99, completedLaps: 2, result: "racing", finishedAtSeconds: null },
      { id: "fast-finisher", progress: 0, completedLaps: 3, result: "finished", finishedAtSeconds: 88 },
      { id: "retired", progress: 50, completedLaps: 2, result: "dnf", finishedAtSeconds: null },
    ]);
    expect(standings.map((standing) => standing.carId))
      .toEqual(["fast-finisher", "slow-finisher", "leader-on-track", "retired"]);
  });

  test("breaks an exact tie on stable Car id so positions do not flicker", () => {
    const forward = raceStandings(track, [racer("b", 30, 1), racer("a", 30, 1)]);
    const reversed = raceStandings(track, [racer("a", 30, 1), racer("b", 30, 1)]);
    expect(forward.map((standing) => standing.carId)).toEqual(["a", "b"]);
    expect(reversed.map((standing) => standing.carId)).toEqual(["a", "b"]);
  });

  test("field of view opens with speed, is bounded, and is pinned under reduced motion", () => {
    const rest = PROVISIONAL_PRESENTATION.cameraFovAtRest;
    const wide = PROVISIONAL_PRESENTATION.cameraFovAtBoost;

    expect(speedCameraFov(0, 15, false)).toBe(rest);
    expect(speedCameraFov(15, 15, false)).toBe(rest);
    expect(speedCameraFov(15 * 1.25, 15, false)).toBeCloseTo(wide, 10);
    expect(speedCameraFov(999, 15, false)).toBe(wide);
    expect(speedCameraFov(15 * 1.125, 15, false)).toBeCloseTo((rest + wide) / 2, 10);
    expect(speedCameraFov(15 * 1.25, 15, true)).toBe(rest);
    expect(speedCameraFov(Number.NaN, 15, false)).toBe(rest);
    expect(speedCameraFov(20, 0, false)).toBe(rest);
  });
});
