import { describe, expect, test } from "bun:test";
import rawTrack from "../src/workshop-track.json";
import { WORKSHOP_TRACK, WORKSHOP_TRACK_IDENTITY, validateAuthoredTrack } from "../src/authored-track";
import { PROVISIONAL_CAR_PROFILE, advanceRace, createRace } from "../src/race";
import { createLocalRace, sampleTrackPose } from "../src/presentation";
import { Room } from "../src/room";

function clone(): Record<string, unknown> { return structuredClone(rawTrack) as Record<string, unknown>; }

describe("authored Workshop Track", () => {
  test("loads with stable identity, exactly four Lanes, ordered checkpoints, and unique canonical ids", () => {
    const content = validateAuthoredTrack(rawTrack);
    expect(content.track).toEqual(WORKSHOP_TRACK);
    expect(WORKSHOP_TRACK_IDENTITY).toBe("workshop-bench@3.0.0");
    expect(content.track.lanes.map((lane) => lane.index)).toEqual([0, 1, 2, 3]);
    expect(content.track.checkpoints.map((point) => point.progress)).toEqual([70, 140, 210]);
    const ids = [
      ...content.track.checkpoints, ...content.track.fixedObstacles!,
      ...content.track.powerUpOpportunities!, ...content.track.hazardPlacementLocations!,
    ].map((point) => point.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("strictly rejects missing, extra, wrong-type, range, order, duplicate, and malformed placement fields", () => {
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => { delete value.version; },
      (value) => { value.extra = true; },
      (value) => { value.length = "160"; },
      (value) => { (value.lanes as unknown[]).pop(); },
      (value) => { (value.checkpoints as Record<string, unknown>[])[1]!.progress = 20; },
      (value) => { (value.fixedObstacles as Record<string, unknown>[])[0]!.id = "checkpoint-back-straight"; },
      (value) => { (value.fixedObstacles as Record<string, unknown>[])[0]!.lane = 4; },
      (value) => { (value.powerUpOpportunities as Record<string, unknown>[])[0]!.allowedEffects = ["boost", "boost"]; },
      (value) => { (value.hazardPlacementLocations as Record<string, unknown>[])[0]!.allowedLanes = []; },
      (value) => { (value.presentation as { path: Record<string, unknown>[] }).path[0]!.x = Number.NaN; },
      (value) => { (value.presentation as { path: Record<string, unknown>[] }).path[1]!.progress = 0; },
      (value) => { (value.presentation as { path: Record<string, unknown>[] }).path[2]!.y = -0.5; },
      (value) => { delete (value.presentation as { path: Record<string, unknown>[] }).path[2]!.bank; },
      (value) => { (value.presentation as { path: Record<string, unknown>[] }).path[2]!.bank = Math.PI / 2; },
    ];
    for (const mutate of mutations) {
      const value = clone(); mutate(value);
      expect(() => validateAuthoredTrack(value)).toThrow();
    }
  });

  test("authoritative Room defaults and renderer sampling share the exact Track identity", () => {
    const race = createLocalRace();
    const room = new Room({ code: "AB12", hostId: "host", hostName: "Host", createRaceId: () => "race-1" });
    room.join("guest", "Guest"); room.startRace("host");
    expect(`${race.track.id}@${race.track.version}`).toBe(WORKSHOP_TRACK_IDENTITY);
    expect(`${room.race!.track.id}@${room.race!.track.version}`).toBe(WORKSHOP_TRACK_IDENTITY);
    expect(sampleTrackPose(race.track, 0, 1)).toEqual(sampleTrackPose(WORKSHOP_TRACK, 0, 1));
  });

  test("authoritative outcomes ignore authored interaction storage order", () => {
    const options = {
      configuration: { laps: 1 },
      cars: [{ id: "car", profile: PROVISIONAL_CAR_PROFILE, lane: 1 as const }],
      seed: 42,
    };
    const canonical = createRace({ ...options, track: WORKSHOP_TRACK });
    const permuted = createRace({ ...options, track: {
      ...WORKSHOP_TRACK,
      fixedObstacles: [...WORKSHOP_TRACK.fixedObstacles!].reverse(),
      powerUpOpportunities: [...WORKSHOP_TRACK.powerUpOpportunities!].reverse(),
      hazardPlacementLocations: [...WORKSHOP_TRACK.hazardPlacementLocations!].reverse(),
    } });
    expect(permuted).toEqual(canonical);
    expect(advanceRace(permuted, {})).toEqual(advanceRace(canonical, {}));
  });
});
