import { describe, expect, test } from "bun:test";
import { WORKSHOP_TRACK } from "../src/authored-track";
import {
  chaseCameraPose,
  createLocalRace,
  sampleTrackPose,
  selectCameraCarId,
  type CameraPose,
  type TrackPose,
} from "../src/presentation";
import { Room } from "../src/room";

function forward(pose: TrackPose): { readonly x: number; readonly z: number } {
  return { x: Math.sin(pose.heading), z: Math.cos(pose.heading) };
}

describe("chase camera presentation", () => {
  test("stays behind and above the followed Car while targeting upcoming Track", () => {
    const car: TrackPose = { x: 10, y: 0, z: -4, heading: Math.PI / 3, pitch: 0, bank: 0, lanePosition: 2 };
    const camera = chaseCameraPose(car, null, 1 / 60, 0, false);
    const direction = forward(car);
    const cameraForwardOffset = (camera.x - car.x) * direction.x + (camera.z - car.z) * direction.z;
    const targetForwardOffset = (camera.targetX - car.x) * direction.x + (camera.targetZ - car.z) * direction.z;

    expect(cameraForwardOffset).toBeLessThan(0);
    expect(camera.y).toBeGreaterThan(0.66);
    expect(targetForwardOffset).toBeGreaterThan(0);
  });

  test("follows Track heading changes instead of looking toward Track center", () => {
    const north = chaseCameraPose({ x: 12, y: 0, z: 7, heading: 0, pitch: 0, bank: 0, lanePosition: 1 }, null, 1 / 60, 0, false);
    const east = chaseCameraPose({ x: 12, y: 0, z: 7, heading: Math.PI / 2, pitch: 0, bank: 0, lanePosition: 1 }, null, 1 / 60, 0, false);

    expect(north.targetX).toBeCloseTo(12);
    expect(north.targetZ).toBeGreaterThan(7);
    expect(east.targetX).toBeGreaterThan(12);
    expect(east.targetZ).toBeCloseTo(7);
  });

  test("rises with the Track so the flyover is framed from above its deck", () => {
    const flyover = sampleTrackPose(WORKSHOP_TRACK, 245, 1.5);
    const underpass = sampleTrackPose(WORKSHOP_TRACK, 105, 1.5);
    const above = chaseCameraPose(flyover, null, 1 / 60, 0, false);
    const below = chaseCameraPose(underpass, null, 1 / 60, 0, false);

    expect(flyover.y - underpass.y).toBeGreaterThan(4);
    expect(above.y).toBeGreaterThan(flyover.y);
    expect(above.y - below.y).toBeGreaterThan(4);
    expect(above.targetY).toBeGreaterThan(below.targetY + 4);
  });

  test("looks up the climb instead of into the Track surface", () => {
    const climbing = sampleTrackPose(WORKSHOP_TRACK, 196, 1.5);
    const ahead = sampleTrackPose(WORKSHOP_TRACK, 196 + 12, 1.5);
    const camera = chaseCameraPose(climbing, null, 1 / 60, 0, false);

    expect(climbing.pitch).toBeGreaterThan(0.05);
    expect(camera.targetY).toBeGreaterThan(climbing.y);
    expect(Math.abs(camera.targetY - ahead.y)).toBeLessThan(1.5);
  });

  test("crosses the cyclic seam without a large camera position or target jump", () => {
    const epsilon = 0.000_1;
    const before = chaseCameraPose(
      sampleTrackPose(WORKSHOP_TRACK, WORKSHOP_TRACK.length - epsilon, 1),
      null,
      1 / 60,
      0,
      false,
    );
    const after = chaseCameraPose(sampleTrackPose(WORKSHOP_TRACK, epsilon, 1), null, 1 / 60, 0, false);

    expect(distance(before, after)).toBeLessThan(0.01);
    expect(targetDistance(before, after)).toBeLessThan(0.01);
    expect(viewAngle(before, after)).toBeLessThan(0.001);
  });

  test("smooths ordinary corrections while reduced motion follows directly without impulse", () => {
    const previous = chaseCameraPose(sampleTrackPose(WORKSHOP_TRACK, 20, 1), null, 1 / 60, 0, false);
    const followed = sampleTrackPose(WORKSHOP_TRACK, 40, 2);
    const desired = chaseCameraPose(followed, null, 1 / 60, 0, false);
    const smoothed = chaseCameraPose(followed, previous, 1 / 60, 0, false);
    const reduced = chaseCameraPose(followed, previous, 1 / 60, 0.3, true);

    expect(distance(smoothed, desired)).toBeLessThan(distance(previous, desired));
    expect(distance(smoothed, desired)).toBeGreaterThan(0);
    expect(reduced).toEqual(desired);
    expect(chaseCameraPose(followed, null, 1 / 60, 0.3, false).y).toBeGreaterThan(desired.y);
  });

  test("selects a stable local target and a deterministic Spectator fallback", () => {
    const cars = [
      { id: "racer-z", result: "racing" as const },
      { id: "racer-a", result: "finished" as const },
      { id: "racer-m", result: "racing" as const },
    ];
    const before = structuredClone(cars);

    expect(selectCameraCarId(cars, "racer-a")).toBe("racer-a");
    expect(selectCameraCarId(cars, "spectator")).toBe("racer-m");
    const dnfs = cars.map((car) => ({ ...car, result: "dnf" as const }));
    expect(selectCameraCarId(dnfs, "racer-z")).toBe("racer-z");
    expect(selectCameraCarId(dnfs, "spectator")).toBe("racer-a");
    expect(cars).toEqual(before);
  });

  test("does not mutate snapshot, Race, or Room authority", () => {
    const race = createLocalRace();
    const raceBefore = structuredClone(race);
    const room = new Room({
      code: "AB12", hostId: "host", hostName: "Host", createRaceId: () => "race-1",
      soloConfiguration: { botCount: 2, botDifficulty: "hard" },
    });
    room.startRace("host");
    const roomBefore = room.snapshot("host");
    const snapshot = structuredClone(roomBefore);
    const snapshotBefore = structuredClone(snapshot);
    const followedId = selectCameraCarId(snapshot.race!.cars, snapshot.players[0]!.id);
    const car = snapshot.race!.cars.find((candidate) => candidate.id === followedId)!;
    const pose = sampleTrackPose(snapshot.race!.track, car.progress, car.lane);

    chaseCameraPose(pose, null, 1 / 60, 0.2, false);

    expect(race).toEqual(raceBefore);
    expect(snapshot).toEqual(snapshotBefore);
    expect(room.snapshot("host")).toEqual(roomBefore);
  });
});

function distance(a: CameraPose, b: CameraPose): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function targetDistance(a: CameraPose, b: CameraPose): number {
  return Math.hypot(a.targetX - b.targetX, a.targetY - b.targetY, a.targetZ - b.targetZ);
}

function viewAngle(a: CameraPose, b: CameraPose): number {
  const aView = [a.targetX - a.x, a.targetY - a.y, a.targetZ - a.z] as const;
  const bView = [b.targetX - b.x, b.targetY - b.y, b.targetZ - b.z] as const;
  const dot = aView[0] * bView[0] + aView[1] * bView[1] + aView[2] * bView[2];
  const magnitude = Math.hypot(...aView) * Math.hypot(...bView);
  return Math.acos(Math.min(1, Math.max(-1, dot / magnitude)));
}
