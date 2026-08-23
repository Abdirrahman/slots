import { describe, expect, test } from "bun:test";

import { WORKSHOP_TRACK } from "../src/authored-track";
import { BOT_DIFFICULTY_PROFILES, botInput } from "../src/bot";
import { feedbackForEvent } from "../src/feedback";
import { parseServerMessage } from "../src/multiplayer-client";
import { PROTOCOL_VERSION } from "../src/protocol";
import {
  CRASH_CAUSES,
  PROVISIONAL_CAR_PROFILE,
  advanceRace,
  createRace,
  type CarInput,
  type LaneIndex,
  type RaceEvent,
} from "../src/race";

/**
 * Every event type the simulation can emit.
 *
 * Kept as a literal list rather than derived, so adding an event to `RaceEvent` without adding
 * it here fails the exhaustiveness check below, and adding it here without teaching the client
 * fails the round trip. Both halves of that drift shipped once: `boost_activated` and
 * `deslot_warning` reached the wire while the client's validator still rejected them, which
 * made the client tear down its connection the first time a Bot spent a charge.
 */
const EVENT_TYPES: readonly RaceEvent["type"][] = [
  "checkpoint", "lap", "finish", "ordinary_collision", "blocked_lane_change", "crash",
  "respawn", "ghost_end", "power_up_collected", "shield_consumed", "boosted_impact",
  "hazard_placed", "hazard_activated", "hazard_removed", "hazard_consumed",
  "boost_activated", "deslot_warning",
];

function wrap(events: readonly RaceEvent[]): string {
  return JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    type: "race_events",
    roomCode: "AB12",
    raceId: "11111111-2222-3333-4444-555555555555",
    events: events.map((event, index) => ({ id: `e-${index}`, event })),
  });
}

/** One representative instance of each event type, with plausible identifiers. */
function sample(type: RaceEvent["type"]): RaceEvent {
  const timed = { tick: 3, timeSeconds: 0.1 } as const;
  const carId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const otherId = "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee";
  switch (type) {
    case "checkpoint": return { ...timed, type, carId, checkpointId: "checkpoint-back-straight" };
    case "lap": return { ...timed, type, carId, lap: 2 };
    case "finish": case "blocked_lane_change": case "ghost_end": return { ...timed, type, carId };
    case "ordinary_collision": return { ...timed, type, carId, leadingCarId: otherId };
    case "crash": return { ...timed, type, carId, cause: "deslot", sourceId: "corner-01" };
    case "respawn": return { ...timed, type, carId, lane: 2 };
    case "power_up_collected": return { ...timed, type, carId, opportunityId: "pickup-start", effect: "boost" };
    case "shield_consumed": return { ...timed, type, carId, sourceId: "obstacle-toolbox" };
    case "boosted_impact": return { ...timed, type, carId, targetCarId: otherId };
    case "hazard_placed": return { ...timed, type, carId, hazardId: "hazard-0", locationId: "hazard-far-end", lane: 1 };
    case "hazard_activated": case "hazard_removed": return { ...timed, type, hazardId: "hazard-0" };
    case "hazard_consumed": return { ...timed, type, carId, hazardId: "hazard-0" };
    case "boost_activated": return { ...timed, type, carId, chargesRemaining: 1 };
    case "deslot_warning": return { ...timed, type, carId, cornerId: "corner-01" };
  }
}

describe("Race events survive the trip to the client", () => {
  test("the sample list covers every declared crash cause", () => {
    expect([...CRASH_CAUSES]).toEqual(["fixed_obstacle", "boosted_impact", "hazard", "deslot"]);
    for (const cause of CRASH_CAUSES) {
      const crash: RaceEvent = { tick: 1, timeSeconds: 0.1, type: "crash", carId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cause, sourceId: "corner-01" };
      expect(() => parseServerMessage(wrap([crash]))).not.toThrow();
    }
  });

  test("the client accepts one of every event type", () => {
    for (const type of EVENT_TYPES) {
      expect(() => parseServerMessage(wrap([sample(type)]))).not.toThrow();
    }
    expect(() => parseServerMessage(wrap(EVENT_TYPES.map(sample)))).not.toThrow();
  });

  test("each event type still maps to feedback", () => {
    for (const type of EVENT_TYPES) {
      const feedback = feedbackForEvent({ id: "e-0", event: sample(type) }, false);
      expect(feedback.announcement.length).toBeGreaterThan(0);
      expect(feedback.audio.length).toBeGreaterThan(0);
    }
  });

  test("an unknown event type is still rejected", () => {
    const rogue = { tick: 1, timeSeconds: 0.1, type: "teleport", carId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
    expect(() => parseServerMessage(wrap([rogue as unknown as RaceEvent]))).toThrow();
  });

  test("a full Bot-driven Workshop Race emits nothing the client rejects", () => {
    // The regression that prompted this test only appeared once a Bot spent a charge, which no
    // unit test reached, so this drives a real Race and validates every batch it produces.
    let race = createRace({
      track: WORKSHOP_TRACK,
      configuration: { laps: 3 },
      cars: [0, 1, 2, 3].map((index) => ({ id: `car-${index}`, profile: PROVISIONAL_CAR_PROFILE, lane: index as LaneIndex })),
      seed: 7,
    });
    const seen = new Set<string>();
    for (let tick = 0; tick < 30 * 200 && race.status === "racing"; tick += 1) {
      const inputs: Record<string, CarInput> = {};
      for (const car of race.cars) inputs[car.id] = botInput(race, car.id, BOT_DIFFICULTY_PROFILES.easy);
      const advanced = advanceRace(race, inputs);
      race = advanced.state;
      if (advanced.events.length > 0) {
        expect(() => parseServerMessage(wrap(advanced.events))).not.toThrow();
        for (const event of advanced.events) seen.add(event.type);
      }
    }
    // The Race must actually have exercised the events that used to break the connection.
    expect(seen.has("boost_activated")).toBe(true);
    expect(seen.has("power_up_collected")).toBe(true);
    expect(seen.has("crash")).toBe(true);
  });
});
