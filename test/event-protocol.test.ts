import { describe, expect, test } from "bun:test";
import { MAX_EVENT_BATCH } from "../src/multiplayer-config";
import { parseServerMessage } from "../src/multiplayer-client";
import { PROTOCOL_VERSION } from "../src/protocol";

const event = { type: "checkpoint" as const, carId: "car-a", checkpointId: "checkpoint-a", tick: 1, timeSeconds: 0.04 };
const message = { protocolVersion: PROTOCOL_VERSION, type: "race_events" as const, roomCode: "AB12", raceId: "race-1", events: [{ id: "race-1:1:0", event }] };

describe("bounded authoritative Race-event protocol", () => {
  test("accepts a canonical server-only batch", () => expect(parseServerMessage(JSON.stringify(message))).toEqual(message));

  test("strictly rejects missing, extra, wrong-type, enum, range, combination, and oversized event batches", () => {
    const rejected = [
      { ...message, raceId: null },
      { ...message, events: [] },
      { ...message, events: Array.from({ length: MAX_EVENT_BATCH + 1 }, (_, index) => ({ id: `race-1:1:${index}`, event })) },
      { ...message, extra: true },
      { ...message, events: [{ id: "bad id", event }] },
      { ...message, events: [{ id: "race-1:1:0", event: { ...event, tick: -1 } }] },
      { ...message, events: [{ id: "race-1:1:0", event: { ...event, type: "warp" } }] },
      { ...message, events: [{ id: "race-1:1:0", event: { ...event, extra: true } }] },
      { ...message, events: [{ id: "race-1:1:0", event: { type: "respawn", carId: "car-a", lane: 4, tick: 1, timeSeconds: 0.04 } }] },
      { ...message, events: [{ id: "race-1:1:0", event: { type: "crash", carId: "car-a", cause: "warp", sourceId: "x", tick: 1, timeSeconds: 0.04 } }] },
    ];
    for (const value of rejected) expect(() => parseServerMessage(JSON.stringify(value))).toThrow("Malformed server message");
  });
});
