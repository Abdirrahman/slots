import { describe, expect, test } from "bun:test";

import { WORKSHOP_TRACK } from "../src/authored-track";
import { parseServerMessage } from "../src/multiplayer-client";
import { PROTOCOL_VERSION } from "../src/protocol";
import { Room } from "../src/room";

/**
 * A whole Solo Race, every message of it, through the client's own parser.
 *
 * This exists because three separate defects shipped together and none of the unit tests could
 * have caught any of them: the client's event validator rejected `boost_activated` and
 * `deslot_warning`, its crash validator rejected the new `deslot` cause, and a Car that crashed
 * while drafting committed a state its own snapshot validator forbade. Each one tore the
 * connection down mid-Race, which reads to a player as "Solo does not work". The Race has to be
 * driven to completion to reach them, so this test drives it.
 */
function runSoloRace(raceId: string, botDifficulty: "easy" | "normal" | "hard"): Set<string> {
  const room = new Room({
    code: "AB12",
    hostId: "p1",
    hostName: "Solo",
    track: WORKSHOP_TRACK,
    configuration: { laps: 2 },
    soloConfiguration: { botCount: 3, botDifficulty },
    createReconnectToken: () => "t".repeat(43),
    createRaceId: () => raceId,
  });
  expect(room.startRace("p1")).toBe(raceId);

  const seen = new Set<string>();
  for (let tick = 0; tick < 30 * 400 && room.phase !== "results"; tick += 1) {
    const advanced = room.advance();
    const state = room.snapshot("p1");

    const snapshot = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, type: "snapshot", roomCode: "AB12",
      raceId: state.raceId, simulationTick: state.race?.tick ?? 0, stateVersion: state.stateVersion,
      lastProcessedInputSequence: state.lastProcessedInputSequence,
      localPlayerId: "p1", connectionGeneration: 1, state,
    });
    expect(() => parseServerMessage(snapshot)).not.toThrow();

    if (advanced.events.length === 0) continue;
    for (const event of advanced.events) seen.add(event.type);
    const events = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, type: "race_events", roomCode: "AB12",
      raceId: state.raceId,
      events: advanced.events.map((event, index) => ({ id: `${tick}-${index}`, event })),
    });
    expect(() => parseServerMessage(events)).not.toThrow();
  }
  expect(room.phase).toBe("results");
  return seen;
}

describe("a Solo Race stays on the wire from lights to results", () => {
  for (const difficulty of ["easy", "normal", "hard"] as const) {
    test(`${difficulty} Bots: every snapshot and event batch parses`, () => {
      const seen = runSoloRace("00000011-0000-4000-8000-000000000000", difficulty);
      expect(seen.has("finish")).toBe(true);
      expect(seen.has("lap")).toBe(true);
    });
  }

  test("the Race actually reaches the rules that used to break the connection", () => {
    const seen = new Set<string>();
    for (const seed of [2, 6, 11, 17]) {
      for (const value of runSoloRace(`${String(seed).padStart(8, "0")}-0000-4000-8000-000000000000`, "hard")) {
        seen.add(value);
      }
    }
    expect(seen.has("boost_activated")).toBe(true);
    expect(seen.has("crash")).toBe(true);
    expect(seen.has("power_up_collected")).toBe(true);
  });
});
