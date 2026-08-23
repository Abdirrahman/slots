import { describe, expect, test } from "bun:test";
import {
  MAX_GUEST_NAME_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_RACE_ID_LENGTH,
  RECONNECT_TOKEN_LENGTH,
} from "../src/multiplayer-config";
import { PROTOCOL_VERSION, ProtocolError, parseClientCommand } from "../src/protocol";

function json(value: unknown): string {
  return JSON.stringify(value);
}

const base = { protocolVersion: PROTOCOL_VERSION, seq: 0 };

describe("parseClientCommand", () => {
  test("strictly parses valid Solo Race configuration", () => {
    for (const botCount of [1, 2, 3]) {
      for (const botDifficulty of ["easy", "normal", "hard"] as const) {
        expect(parseClientCommand(json({
          ...base, type: "create_solo_race", name: "Ada", botCount, botDifficulty,
        }))).toEqual({
          ...base, type: "create_solo_race", name: "Ada", botCount, botDifficulty,
        });
      }
    }
  });

  test("rejects missing, extra, malformed, and authoritative Solo fields", () => {
    const canonical = { ...base, type: "create_solo_race", name: "Ada", botCount: 2, botDifficulty: "normal" };
    const rejected = [
      { ...canonical, botCount: 0 },
      { ...canonical, botCount: 4 },
      { ...canonical, botCount: 1.5 },
      { ...canonical, botCount: "2" },
      { ...canonical, botCount: null },
      { ...canonical, botCount: undefined },
      { ...canonical, botDifficulty: "unknown" },
      { ...canonical, botDifficulty: "Normal" },
      { ...canonical, botDifficulty: 1 },
      { ...canonical, botDifficulty: null },
      { ...canonical, botDifficulty: undefined },
      { ...canonical, extra: true },
      { ...canonical, progress: 10 },
      { ...canonical, speed: 10 },
      { ...canonical, result: "finished" },
      { ...canonical, bots: [] },
      { ...canonical, botState: {} },
    ];
    for (const command of rejected) expect(() => parseClientCommand(json(command))).toThrow(ProtocolError);

    const missingCount = { ...canonical } as Record<string, unknown>;
    delete missingCount.botCount;
    const missingDifficulty = { ...canonical } as Record<string, unknown>;
    delete missingDifficulty.botDifficulty;
    expect(() => parseClientCommand(json(missingCount))).toThrow(ProtocolError);
    expect(() => parseClientCommand(json(missingDifficulty))).toThrow(ProtocolError);
  });

  test("parses heartbeat and optional edge-triggered Lane input", () => {
    expect(parseClientCommand(json({ ...base, type: "create_room", name: "Ada" }))).toEqual({
      ...base,
      type: "create_room",
      name: "Ada",
    });
    expect(parseClientCommand(json({ ...base, type: "join_room", name: "Lin", roomCode: "AB12" }))).toEqual({
      ...base,
      type: "join_room",
      name: "Lin",
      roomCode: "AB12",
    });
    const reconnectToken = "a".repeat(RECONNECT_TOKEN_LENGTH);
    expect(parseClientCommand(json({ ...base, type: "reconnect", roomCode: "AB12", reconnectToken }))).toEqual({
      ...base,
      type: "reconnect",
      roomCode: "AB12",
      reconnectToken,
    });
    expect(parseClientCommand(json({ ...base, type: "start_race" }))).toEqual({ ...base, type: "start_race" });
    expect(parseClientCommand(json({ ...base, type: "input", raceId: "race-1" }))).toEqual({
      ...base,
      type: "input",
      raceId: "race-1",
    });
    expect(parseClientCommand(json({ ...base, type: "input", raceId: "race-1", laneChange: -1 }))).toEqual({
      ...base,
      type: "input",
      raceId: "race-1",
      laneChange: -1,
    });
    expect(parseClientCommand(json({ ...base, type: "rematch", raceId: "race-1" }))).toEqual({
      ...base,
      type: "rematch",
      raceId: "race-1",
    });
  });

  test("accepts valid UTF-8 bytes and rejects malformed JSON, UTF-8, and oversized bytes", () => {
    const encoded = new TextEncoder().encode(json({ ...base, type: "create_room", name: "Zoë" }));
    expect(parseClientCommand(encoded).type).toBe("create_room");
    expect(() => parseClientCommand("{")) .toThrow(ProtocolError);
    expect(() => parseClientCommand(Uint8Array.of(0xff))).toThrow(ProtocolError);
    expect(() => parseClientCommand(`{"padding":"${"x".repeat(MAX_MESSAGE_BYTES)}"}`)).toThrow(ProtocolError);
  });

  test("rejects unsupported versions, unknown commands, missing keys, extra keys, and authoritative claims", () => {
    const rejected = [
      { ...base, protocolVersion: 999, type: "start_race" },
      { ...base, type: "teleport" },
      { protocolVersion: 1, type: "start_race" },
      { ...base, type: "start_race", extra: true },
      { ...base, type: "input", raceId: "race-1", throttle: 1 },
      { ...base, type: "input", raceId: "race-1", progress: 99 },
      { ...base, type: "input", raceId: "race-1", speed: 99 },
      { ...base, type: "input", raceId: "race-1", finishedAtSeconds: 0 },
      { ...base, type: "input", raceId: "race-1", ordinaryContact: null },
      { ...base, type: "input", raceId: "race-1", laneTransition: null },
      { ...base, type: "input", raceId: "race-1", result: "dnf" },
      { ...base, type: "input", raceId: "race-1", completedLaps: 3 },
      { ...base, type: "input", raceId: "race-1", crashRecoveryTicksRemaining: 1 },
      { ...base, type: "input", raceId: "race-1", ghost: true },
      { ...base, type: "input", raceId: "race-1", shieldTicksRemaining: 10 },
      { ...base, type: "input", raceId: "race-1", boostTicksRemaining: 10 },
      { ...base, type: "input", raceId: "race-1", hazards: [] },
      { ...base, type: "input", raceId: "race-1", powerUpOpportunities: [] },
      { ...base, type: "reconnect", roomCode: "AB12", reconnectToken: "a".repeat(RECONNECT_TOKEN_LENGTH), playerId: "claimed" },
      { ...base, type: "start_race", connectionGeneration: 2 },
      { ...base, type: "start_race", isHost: true },
      { ...base, type: "start_race", role: "racer" },
      { ...base, type: "start_race", controller: "human" },
    ];

    for (const command of rejected) {
      expect(() => parseClientCommand(json(command))).toThrow(ProtocolError);
    }
  });

  test("rejects malformed and out-of-range names, Room codes, sequences, Race ids, and controls", () => {
    const rejected = [
      { ...base, type: "create_room", name: "" },
      { ...base, type: "create_room", name: " Ada" },
      { ...base, type: "create_room", name: "x".repeat(MAX_GUEST_NAME_LENGTH + 1) },
      { ...base, type: "join_room", name: "Ada", roomCode: "abc1" },
      { ...base, type: "join_room", name: "Ada", roomCode: "A!12" },
      { ...base, type: "reconnect", roomCode: "AB12", reconnectToken: "short" },
      { ...base, type: "reconnect", roomCode: "AB12", reconnectToken: "!".repeat(RECONNECT_TOKEN_LENGTH) },
      { ...base, seq: -1, type: "start_race" },
      { ...base, seq: 1.5, type: "start_race" },
      { ...base, seq: 1e400, type: "start_race" },
      { ...base, type: "input", raceId: "" },
      { ...base, type: "input", raceId: "x".repeat(MAX_RACE_ID_LENGTH + 1) },
      { ...base, type: "input", raceId: "bad id" },
      { ...base, type: "input", raceId: "race-1", laneChange: 0 },
    ];

    for (const command of rejected) {
      expect(() => parseClientCommand(json(command))).toThrow(ProtocolError);
    }
  });

  test("rejects non-object JSON values", () => {
    for (const value of [null, [], "start_race", 1, true]) {
      expect(() => parseClientCommand(json(value))).toThrow(ProtocolError);
    }
  });
});
