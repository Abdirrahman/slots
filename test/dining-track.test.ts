import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import WebSocket from "ws";
import rawDiningTrack from "../src/dining-track.json";
import {
  DEFAULT_TRACK,
  DINING_CONTENT,
  DINING_TRACK,
  WORKSHOP_CONTENT,
  WORKSHOP_TRACK,
  resolveAuthoredTrack,
  validateAuthoredTrack,
} from "../src/authored-track";
import { parseServerMessage, type ServerSnapshotMessage } from "../src/multiplayer-client";
import { PROVISIONAL_PRESENTATION, sampleTrackPose } from "../src/presentation";
import { PROTOCOL_VERSION } from "../src/protocol";
import { createGameServer } from "../src/server";

describe("authored Dining Table Run", () => {
  test("registers the validated baked route without replacing the Workshop content", () => {
    expect(validateAuthoredTrack(rawDiningTrack)).toEqual(DINING_CONTENT);
    expect(DINING_TRACK.id).toBe("dining-table-run");
    expect(DINING_TRACK.version).toBe("1.0.0");
    expect(DINING_TRACK.lanes.map((lane) => lane.index)).toEqual([0, 1, 2, 3]);
    expect(DEFAULT_TRACK).toBe(DINING_TRACK);
    expect(resolveAuthoredTrack(DINING_TRACK)).toBe(DINING_CONTENT);
    expect(resolveAuthoredTrack(WORKSHOP_TRACK)).toBe(WORKSHOP_CONTENT);
  });

  test("samples the exported route knots and keeps all four lanes continuous through the seam", () => {
    const epsilon = 0.000_001;
    for (const point of DINING_CONTENT.path) {
      const center = sampleTrackPose(DINING_TRACK, point.progress, 1.5);
      expect(center.x).toBeCloseTo(point.x, 10);
      expect(center.y).toBeCloseTo(point.y, 10);
      expect(center.z).toBeCloseTo(point.z, 10);
      expect(center.bank).toBeCloseTo(point.bank, 10);
      for (const lane of DINING_TRACK.lanes) {
        const before = sampleTrackPose(DINING_TRACK, point.progress - epsilon, lane.index);
        const after = sampleTrackPose(DINING_TRACK, point.progress + epsilon, lane.index);
        expect(Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z)).toBeLessThan(0.001);
        expect(Math.abs(Math.atan2(Math.sin(after.heading - before.heading), Math.cos(after.heading - before.heading))))
          .toBeLessThan(0.001);
        expect(Math.abs(after.pitch - before.pitch)).toBeLessThan(0.001);
        expect(Math.abs(after.bank - before.bank)).toBeLessThan(0.001);
      }
    }
    expect(sampleTrackPose(DINING_TRACK, DINING_TRACK.length, 1))
      .toEqual(sampleTrackPose(DINING_TRACK, 0, 1));
    expect(sampleTrackPose(DINING_TRACK, -1, 1))
      .toEqual(sampleTrackPose(DINING_TRACK, DINING_TRACK.length - 1, 1));
  });

  test("preserves lane spacing across climbs and banking with a distinct raised dining route", () => {
    let minimumHeight = Infinity;
    let maximumHeight = -Infinity;
    let maximumPitch = 0;
    let maximumBank = 0;
    for (let index = 0; index < 720; index += 1) {
      const progress = index / 720 * DINING_TRACK.length;
      const center = sampleTrackPose(DINING_TRACK, progress, 1.5);
      expect(Object.values(center).every(Number.isFinite)).toBe(true);
      minimumHeight = Math.min(minimumHeight, center.y);
      maximumHeight = Math.max(maximumHeight, center.y);
      maximumPitch = Math.max(maximumPitch, Math.abs(center.pitch));
      maximumBank = Math.max(maximumBank, Math.abs(center.bank));
      for (let lane = 1; lane < 4; lane += 1) {
        const previous = sampleTrackPose(DINING_TRACK, progress, lane - 1);
        const current = sampleTrackPose(DINING_TRACK, progress, lane);
        expect(Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z))
          .toBeCloseTo(PROVISIONAL_PRESENTATION.laneSpacing, 10);
      }
    }
    expect(minimumHeight).toBeGreaterThanOrEqual(0);
    expect(maximumHeight - minimumHeight).toBeGreaterThan(3);
    expect(maximumPitch).toBeGreaterThan(0.05);
    expect(maximumBank).toBeGreaterThan(0.05);
    expect(sampleTrackPose(DINING_TRACK, 0, 1.5)).not.toEqual(sampleTrackPose(WORKSHOP_TRACK, 0, 1.5));
  });

  test("rejects incompatible authored geometry instead of silently drawing a synthetic circle", () => {
    for (const track of [DINING_TRACK, WORKSHOP_TRACK]) {
      expect(() => sampleTrackPose({ ...track, version: "99.0.0" }, 0, 1)).toThrow("identity mismatch");
      expect(() => sampleTrackPose({ id: track.id, length: track.length }, 0, 1)).toThrow("identity mismatch");
      expect(() => sampleTrackPose({ ...track, length: track.length + 1 }, 0, 1)).toThrow("identity mismatch");
    }
    const synthetic = { id: "test-circle", length: 100 };
    expect(resolveAuthoredTrack(synthetic)).toBeUndefined();
    expect(sampleTrackPose(synthetic, 0, 1).y).toBe(0);
  });

  test("the shipped Blender road edges agree with runtime poses through climbs, banking and the seam", () => {
    const glb = readFileSync(new URL("../public/assets/maps/dining-table-run.glb", import.meta.url));
    expect(glb.readUInt32LE(0)).toBe(0x46546c67);
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    expect(glb.readUInt32LE(16)).toBe(0x4e4f534a);
    const jsonLength = glb.readUInt32LE(12);
    const binaryChunk = 20 + jsonLength;
    expect(glb.readUInt32LE(binaryChunk + 4)).toBe(0x004e4942);
    const binaryStart = binaryChunk + 8;
    const gltf = JSON.parse(glb.toString("utf8", 20, 20 + jsonLength)) as {
      nodes: { name?: string; mesh?: number; children?: number[]; matrix?: number[];
        translation?: number[]; rotation?: number[]; scale?: number[] }[];
      meshes: { primitives: { attributes: { POSITION: number } }[] }[];
      accessors: { bufferView: number; componentType: number; count: number; type: string; byteOffset?: number }[];
      bufferViews: { buffer: number; byteOffset?: number; byteStride?: number }[];
    };
    const nodeIndex = gltf.nodes.findIndex((node) => node.name === "track-surface");
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    const road = gltf.nodes[nodeIndex]!;
    const parents = new Map<number, number>();
    gltf.nodes.forEach((node, index) => node.children?.forEach((child) => parents.set(child, index)));
    const chain = [];
    for (let index: number | undefined = nodeIndex; index !== undefined; index = parents.get(index)) {
      chain.push(gltf.nodes[index]!);
    }
    const vertices: number[][] = [];
    for (const primitive of gltf.meshes[road.mesh!]!.primitives) {
      const accessor = gltf.accessors[primitive.attributes.POSITION]!;
      expect(accessor.componentType).toBe(5126);
      expect(accessor.type).toBe("VEC3");
      const view = gltf.bufferViews[accessor.bufferView]!;
      expect(view.buffer).toBe(0);
      const start = binaryStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      for (let vertex = 0; vertex < accessor.count; vertex += 1) {
        const offset = start + vertex * (view.byteStride ?? 12);
        let x = glb.readFloatLE(offset), y = glb.readFloatLE(offset + 4), z = glb.readFloatLE(offset + 8);
        // glTF POSITION is already Y-up game space. Apply the entire node ancestry,
        // rather than assuming the authoring/export root stays at its current identity.
        for (const node of chain) {
          const m = node.matrix;
          if (m !== undefined) {
            [x, y, z] = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
              m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
              m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
          } else {
            x *= node.scale?.[0] ?? 1; y *= node.scale?.[1] ?? 1; z *= node.scale?.[2] ?? 1;
            const [qx = 0, qy = 0, qz = 0, qw = 1] = node.rotation ?? [];
            const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
            [x, y, z] = [x + qw * tx + qy * tz - qz * ty,
              y + qw * ty + qz * tx - qx * tz, z + qw * tz + qx * ty - qy * tx];
            x += node.translation?.[0] ?? 0; y += node.translation?.[1] ?? 0; z += node.translation?.[2] ?? 0;
          }
        }
        vertices.push([x, y, z]);
      }
    }
    // Blender exports 1,024 road rows. glTF can reorder/split vertices by material,
    // so identify each expected edge geometrically instead of trusting accessor order.
    for (const row of [0, 1, 37, 128, 256, 333, 384, 512, 640, 777, 896, 1023]) {
      for (const lane of [-PROVISIONAL_PRESENTATION.roadEdgeLaneMargin, 3 + PROVISIONAL_PRESENTATION.roadEdgeLaneMargin]) {
        const expected = sampleTrackPose(DINING_TRACK, DINING_TRACK.length * row / 1024, lane);
        let nearest = Infinity;
        for (const vertex of vertices) {
          nearest = Math.min(nearest, Math.hypot(vertex[0]! - expected.x, vertex[1]! - expected.y, vertex[2]! - expected.z));
        }
        expect(nearest).toBeLessThan(0.000_05);
      }
    }
  });

  test("the default server publishes the same Dining identity and route used by the renderer", async () => {
    const server = createGameServer({ automaticTick: false, serveDirectory: null });
    let socket: WebSocket | undefined;
    try {
      const port = await server.listen(0);
      socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      await new Promise<void>((resolve, reject) => {
        socket!.once("open", resolve);
        socket!.once("error", reject);
      });
      const snapshot = new Promise<ServerSnapshotMessage>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Default Dining snapshot timed out")), 1_000);
        socket!.on("message", (data) => {
          try {
            const message = parseServerMessage(data.toString());
            if (message.type !== "snapshot") return;
            clearTimeout(timeout);
            resolve(message);
          } catch (error) {
            clearTimeout(timeout);
            reject(error);
          }
        });
      });
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "create_solo_race", seq: 0,
        name: "Dining test", botCount: 1, botDifficulty: "normal" }));
      const race = (await snapshot).state.race!;
      expect(race.track.id).toBe(DINING_TRACK.id);
      expect(race.track.version).toBe(DINING_TRACK.version);
      expect(resolveAuthoredTrack(race.track)).toBe(DINING_CONTENT);
      const car = race.cars[0]!;
      expect(sampleTrackPose(race.track, car.progress, car.lane))
        .toEqual(sampleTrackPose(DINING_TRACK, car.progress, car.lane));
    } finally {
      socket?.terminate();
      await server.close();
    }
  });
});
