import { afterEach, expect, test } from "bun:test";
import WebSocket from "ws";
import { COUNTDOWN_TICKS } from "../src/multiplayer-config";
import { PROTOCOL_VERSION } from "../src/protocol";
import type { CarProfile, Track } from "../src/race";
import { createGameServer } from "../src/server";

const track: Track = {
  id: "event-delivery", version: "1.0.0", length: 20,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }], startFinish: 0,
  checkpoints: [{ id: "one", progress: 2 }, { id: "two", progress: 8 }, { id: "three", progress: 14 }],
  fixedObstacles: [], powerUpOpportunities: [], hazardPlacementLocations: [],
};
const profile: CarProfile = { accelerationPerSecondSquared: 3_600, topSpeedPerSecond: 120, brakingPerSecondSquared: 10_000, laneChangeDurationTicks: 3 };
const sockets: WebSocket[] = [];
let server: ReturnType<typeof createGameServer> | null = null;
afterEach(async () => { for (const socket of sockets) socket.close(); await server?.close(); server = null; });

async function client(port: number): Promise<{ socket: WebSocket; messages: Record<string, unknown>[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`); sockets.push(socket);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  return { socket, messages };
}
function send(socket: WebSocket, value: Record<string, unknown>): void { socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...value })); }
async function wait(read: () => Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) { const value = read(); if (value !== undefined) return value; await Bun.sleep(2); }
  throw new Error("Timed out waiting for event delivery");
}

test("real WebSocket Racers and Spectators receive canonical events but cannot claim them", async () => {
  server = createGameServer({ automaticTick: false, serveDirectory: null, track, carProfile: profile, configuration: { laps: 1 } });
  const port = await server.listen(0);
  const host = await client(port); const guest = await client(port);
  send(host.socket, { type: "create_room", seq: 0, name: "Host" });
  const created = await wait(() => host.messages.find((message) => message.type === "snapshot"));
  const roomCode = created.roomCode as string;
  send(guest.socket, { type: "join_room", seq: 0, name: "Guest", roomCode });
  await wait(() => guest.messages.find((message) => message.type === "snapshot"));
  send(host.socket, { type: "start_race", seq: 1 });
  const countdown = await wait(() => host.messages.find((message) => message.type === "snapshot" && (message.state as { phase: string }).phase === "countdown"));
  const raceId = countdown.raceId as string;
  server.advance(COUNTDOWN_TICKS);

  const spectator = await client(port);
  send(spectator.socket, { type: "join_room", seq: 0, name: "Spectator", roomCode });
  await wait(() => spectator.messages.find((message) => message.type === "snapshot"));
  send(spectator.socket, { type: "race_events", seq: 1, raceId, events: [] });
  expect((await wait(() => spectator.messages.find((message) => message.type === "error"))).code).toBe("invalid_command");

  send(host.socket, { type: "input", seq: 2, raceId });
  send(guest.socket, { type: "input", seq: 1, raceId });
  await Bun.sleep(2); server.advance(2);
  const hostEvents = await wait(() => host.messages.find((message) => message.type === "race_events"));
  const spectatorEvents = await wait(() => spectator.messages.find((message) => message.type === "race_events"));
  expect(spectatorEvents).toEqual(hostEvents);
  expect(hostEvents).toMatchObject({ protocolVersion: PROTOCOL_VERSION, roomCode, raceId });
  const events = hostEvents.events as { id: string; event: { type: string } }[];
  expect(events.some((value) => value.event.type === "checkpoint")).toBe(true);
  expect(new Set(events.map((value) => value.id)).size).toBe(events.length);

  const late = await client(port);
  send(late.socket, { type: "join_room", seq: 0, name: "Late", roomCode });
  await wait(() => late.messages.find((message) => message.type === "snapshot"));
  await Bun.sleep(4);
  expect(late.messages.some((message) => message.type === "race_events")).toBe(false);

  server.advance(3);
  await wait(() => host.messages.find((message) => message.type === "snapshot" && (message.state as { phase: string }).phase === "results"));
  const eventCount = host.messages.filter((message) => message.type === "race_events").length;
  send(host.socket, { type: "rematch", seq: 3, raceId });
  await wait(() => host.messages.find((message) => message.type === "snapshot" && (message.state as { phase: string }).phase === "open"));
  expect(host.messages.filter((message) => message.type === "race_events")).toHaveLength(eventCount);
});
