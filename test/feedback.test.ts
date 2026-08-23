import { describe, expect, test } from "bun:test";
import { EventFeedbackConsumer, feedbackForEvent, resultTransitionFeedback, type IdentifiedRaceEvent } from "../src/feedback";
import type { RaceEvent } from "../src/race";

const timed = { tick: 7, timeSeconds: 0.25 };
const events: RaceEvent[] = [
  { ...timed, type: "checkpoint", carId: "car-a", checkpointId: "checkpoint-a" },
  { ...timed, type: "lap", carId: "car-a", lap: 1 },
  { ...timed, type: "finish", carId: "car-a" },
  { ...timed, type: "ordinary_collision", carId: "car-a", leadingCarId: "car-b" },
  { ...timed, type: "blocked_lane_change", carId: "car-a" },
  { ...timed, type: "crash", carId: "car-a", cause: "fixed_obstacle", sourceId: "obstacle-a" },
  { ...timed, type: "respawn", carId: "car-a", lane: 2 },
  { ...timed, type: "ghost_end", carId: "car-a" },
  { ...timed, type: "power_up_collected", carId: "car-a", opportunityId: "pickup-a", effect: "boost" },
  { ...timed, type: "shield_consumed", carId: "car-a", sourceId: "obstacle-a" },
  { ...timed, type: "boosted_impact", carId: "car-a", targetCarId: "car-b" },
  { ...timed, type: "hazard_placed", carId: "car-a", hazardId: "hazard-0", locationId: "hazard-a", lane: 1 },
  { ...timed, type: "hazard_activated", hazardId: "hazard-0" },
  { ...timed, type: "hazard_consumed", carId: "car-a", hazardId: "hazard-0" },
  { ...timed, type: "hazard_removed", hazardId: "hazard-0" },
];
const identified: IdentifiedRaceEvent[] = events.map((event, index) => ({ id: `race-1:7:${index}`, event }));

describe("authoritative event feedback", () => {
  test("maps every RaceEvent type to deterministic camera, audio, effect, and legible feedback", () => {
    const before = structuredClone(identified);
    const feedback = identified.map((event) => feedbackForEvent(event, false));
    expect(feedback).toHaveLength(events.length);
    expect(new Set(feedback.map((item) => item.audio)).size).toBe(events.length);
    expect(feedback.every((item) => item.announcement.length > 0 && item.effect.length > 0 && item.cameraImpulse >= 0)).toBe(true);
    expect(identified).toEqual(before);
  });

  test("consumes event IDs once regardless of render schedule and resets only for a new Race", () => {
    const consumer = new EventFeedbackConsumer();
    expect(consumer.consume("race-1", identified, false)).toHaveLength(identified.length);
    expect(consumer.consume("race-1", identified, false)).toEqual([]);
    expect(consumer.consume("race-1", [identified[0]!], false)).toEqual([]);
    expect(consumer.consume("race-2", [identified[0]!], false)).toHaveLength(1);
  });

  test("reduced motion deterministically removes camera movement without muting feedback", () => {
    const regular = identified.map((event) => feedbackForEvent(event, false));
    const reduced = identified.map((event) => feedbackForEvent(event, true));
    expect(reduced.every((item) => item.cameraImpulse === 0)).toBe(true);
    expect(reduced.map((item) => [item.audio, item.effect, item.announcement])).toEqual(regular.map((item) => [item.audio, item.effect, item.announcement]));
  });

  test("maps authoritative finish and DNF snapshot transitions without repeated announcements", () => {
    expect(resultTransitionFeedback("racing", "finished")).toBe("Official finish recorded");
    expect(resultTransitionFeedback("racing", "dnf")).toBe("Did not finish");
    expect(resultTransitionFeedback("dnf", "dnf")).toBeNull();
  });
});
