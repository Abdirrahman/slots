import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, parseClientCommand } from "../src/protocol";
import { Room } from "../src/room";
import { parseServerMessage } from "../src/multiplayer-client";

describe("car body selection", () => {
  test("allows only registered bodies in setup commands", () => {
    const base = { protocolVersion: PROTOCOL_VERSION, seq: 0, name: "Driver", carAssetId: "r2-car-gt" };
    for (const command of [
      { ...base, type: "create_room" },
      { ...base, type: "join_room", roomCode: "ABCD" },
      { ...base, type: "create_solo_race", botCount: 3, botDifficulty: "normal" },
    ] as const) {
      expect(parseClientCommand(JSON.stringify(command))).toEqual(command);
      for (const invalid of [null, 22, "unknown-car", "/assets/custom.glb"]) {
        expect(() => parseClientCommand(JSON.stringify({ ...command, carAssetId: invalid }))).toThrow("Car selection");
      }
    }
  });

  test("keeps individual selections through race start and reconnect, and validates them on the wire", () => {
    const room = new Room({ code: "ABCD", hostId: "host", hostName: "Host", hostCarAssetId: "r2-car-gt" });
    room.join("guest", "Guest", "r2-car-muscle");
    room.startRace("host");
    const identity = room.connectionIdentity("guest")!;
    room.disconnect("guest", identity.connectionGeneration);
    room.reconnect(identity.reconnectToken);
    const snapshot = room.snapshot("guest");
    expect(snapshot.players.find((player) => player.id === "host")!.carAssetId).toBe("r2-car-gt");
    expect(snapshot.players.find((player) => player.id === "guest")!.carAssetId).toBe("r2-car-muscle");
    const message = { protocolVersion: PROTOCOL_VERSION, type: "snapshot", roomCode: room.code,
      raceId: room.raceId, simulationTick: room.race!.tick, stateVersion: snapshot.stateVersion,
      lastProcessedInputSequence: snapshot.lastProcessedInputSequence, localPlayerId: "guest",
      connectionGeneration: snapshot.localConnectionGeneration, state: snapshot };
    expect(parseServerMessage(JSON.stringify(message)).type).toBe("snapshot");
    const invalid = structuredClone(message);
    (invalid.state.players[0] as { carAssetId: string }).carAssetId = "unknown-car";
    expect(() => parseServerMessage(JSON.stringify(invalid))).toThrow("Malformed server message");
    expect(() => new Room({ code: "ABCD", hostId: "host", hostName: "Host", hostCarAssetId: "unknown" }))
      .toThrow("Car selection");
  });
});
