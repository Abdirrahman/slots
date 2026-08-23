import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import {
  COUNTDOWN_TICKS,
  EMPTY_ROOM_EXPIRATION_MS,
  INPUT_LEASE_TICKS,
} from "../src/multiplayer-config";
import { PROTOCOL_VERSION } from "../src/protocol";
import type { CarProfile, Track } from "../src/race";
import { createGameServer, type GameServer, type GameServerOptions } from "../src/server";

const track: Track = {
  id: "milestone-6-integration",
  length: 120,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  startFinish: 0,
  checkpoints: [
    { id: "one", progress: 30 },
    { id: "two", progress: 60 },
    { id: "three", progress: 90 },
  ],
};

const profile: CarProfile = {
  accelerationPerSecondSquared: 300,
  topSpeedPerSecond: 300,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 3,
};

interface Message {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface PlayerView {
  readonly id: string;
  readonly role: "racer" | "spectator";
  readonly raceSeatId: string | null;
  readonly controller: "human" | "bot" | "none";
  readonly reclaimPending: boolean;
  readonly isHost: boolean;
  readonly connected: boolean;
}

interface StateView {
  readonly roomCode: string;
  readonly phase: "open" | "countdown" | "racing" | "results";
  readonly raceId: string | null;
  readonly configuration: { readonly laps: number };
  readonly players: readonly PlayerView[];
  readonly race: null | {
    readonly tick: number;
    readonly cars: readonly { readonly id: string; readonly speed: number; readonly progress: number }[];
  };
  readonly lastProcessedInputSequence: number | null;
  readonly localRole: "racer" | "spectator" | null;
  readonly canControlRace: boolean;
  readonly canStartRace: boolean;
  readonly canRematch: boolean;
}

class TestClient {
  readonly messages: Message[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as Message));
  }

  static async connect(port: number): Promise<TestClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(command: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...command }));
  }

  async next(type: string, after = 0): Promise<Message> {
    return waitFor(
      () => this.messages.slice(after).find((message) => message.type === type),
      `${type}: ${JSON.stringify(this.messages)}`,
    );
  }

  async snapshot(after: number, predicate: (state: StateView, message: Message) => boolean): Promise<Message> {
    return waitFor(
      () => this.messages.slice(after).find((message) => message.type === "snapshot"
        && predicate(message.state as StateView, message)),
      `matching snapshot: ${JSON.stringify(this.messages)}`,
    );
  }

  async closeAndWait(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>((resolve) => this.socket.once("close", () => resolve()));
    this.socket.close();
    await Promise.race([closed, Bun.sleep(250).then(() => { throw new Error("Timed out closing WebSocket"); })]);
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close();
  }
}

const servers: GameServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(2);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function setup(overrides: GameServerOptions = {}): Promise<{ server: GameServer; port: number }> {
  const server = createGameServer({
    automaticTick: false,
    serveDirectory: null,
    track,
    carProfile: profile,
    configuration: { laps: 99 },
    ...overrides,
  });
  servers.push(server);
  const port = await server.listen(0);
  return { server, port };
}

async function connect(port: number): Promise<TestClient> {
  const client = await TestClient.connect(port);
  clients.push(client);
  return client;
}

function state(message: Message): StateView {
  return message.state as StateView;
}

function player(message: Message, playerId: string): PlayerView {
  return state(message).players.find((candidate) => candidate.id === playerId)!;
}

async function createAndJoin(port: number): Promise<{
  host: TestClient;
  guest: TestClient;
  roomCode: string;
  hostIdentity: Message;
  guestIdentity: Message;
}> {
  const host = await connect(port);
  const guest = await connect(port);
  host.send({ type: "create_room", seq: 0, name: "Host" });
  const hostIdentity = await host.next("identity");
  const roomCode = hostIdentity.roomCode as string;
  await host.next("snapshot");
  guest.send({ type: "join_room", seq: 0, name: "Guest", roomCode });
  const guestIdentity = await guest.next("identity");
  await guest.next("snapshot");
  return { host, guest, roomCode, hostIdentity, guestIdentity };
}

async function startRace(server: GameServer, host: TestClient): Promise<string> {
  const after = host.messages.length;
  host.send({ type: "start_race", seq: 1 });
  const countdown = await host.snapshot(after, (snapshot) => snapshot.phase === "countdown");
  const raceId = countdown.raceId as string;
  server.advance(COUNTDOWN_TICKS);
  await host.snapshot(after, (snapshot) => snapshot.phase === "racing");
  return raceId;
}

describe("Milestone 6 resilient Room WebSocket integration", () => {
  test("targets private identities while create, join, and Host start publish shared snapshots", async () => {
    const { port } = await setup();
    const host = await connect(port);
    const guest = await connect(port);

    host.send({ type: "create_room", seq: 0, name: "Host" });
    const hostIdentity = await host.next("identity");
    const hostSnapshot = await host.next("snapshot");
    expect(guest.messages).toEqual([]);
    expect(hostIdentity.reconnectToken).toBeString();
    expect((hostIdentity.reconnectToken as string)).toHaveLength(43);
    expect(hostIdentity.reconnectToken).not.toBe(hostIdentity.roomCode);
    expect(JSON.stringify(hostSnapshot)).not.toContain(hostIdentity.reconnectToken as string);

    const hostMessageCount = host.messages.length;
    guest.send({ type: "join_room", seq: 0, name: "Guest", roomCode: hostIdentity.roomCode });
    const guestIdentity = await guest.next("identity");
    const guestSnapshot = await guest.next("snapshot");
    const hostJoined = await host.snapshot(hostMessageCount, (snapshot) => snapshot.players.length === 2);
    expect(host.messages.slice(hostMessageCount).some((message) => message.type === "identity")).toBe(false);
    expect(JSON.stringify(host.messages.slice(hostMessageCount))).not.toContain(guestIdentity.reconnectToken as string);
    expect(JSON.stringify(guestSnapshot)).not.toContain(guestIdentity.reconnectToken as string);
    expect(state(hostJoined).players).toHaveLength(2);

    const startIndex = guest.messages.length;
    host.send({ type: "start_race", seq: 1 });
    const hostCountdown = await host.snapshot(host.messages.length - 1, (snapshot) => snapshot.phase === "countdown");
    const guestCountdown = await guest.snapshot(startIndex, (snapshot) => snapshot.phase === "countdown");
    expect(hostCountdown.raceId).toBe(guestCountdown.raceId);
    expect(state(hostCountdown).race).toEqual(state(guestCountdown).race);
    expect(state(hostCountdown).canStartRace).toBe(false);
  });

  test("keeps one Car across Bot takeover and rotated reconnect generations, then reclaims after a full snapshot checkpoint", async () => {
    const { server, port } = await setup();
    const { host, guest, roomCode, hostIdentity } = await createAndJoin(port);
    const hostId = hostIdentity.localPlayerId as string;
    const firstToken = hostIdentity.reconnectToken as string;
    const raceId = await startRace(server, host);
    const carBefore = state(host.messages.filter((message) => message.type === "snapshot").at(-1)!).race!.cars
      .find((car) => car.id === hostId)!;

    const guestBeforeDisconnect = guest.messages.length;
    await host.closeAndWait();
    await guest.snapshot(guestBeforeDisconnect, (snapshot) => playerFrom(snapshot, hostId)?.connected === false);
    server.advance(2);
    const takeover = await guest.snapshot(guestBeforeDisconnect, (snapshot) => playerFrom(snapshot, hostId)?.controller === "bot");
    expect(player(takeover, hostId)).toMatchObject({
      connected: false,
      controller: "bot",
      raceSeatId: hostId,
    });
    expect(state(takeover).race!.cars.find((car) => car.id === hostId)).toMatchObject({ id: carBefore.id });
    expect(player(takeover, guestIdentityId(guest))).toMatchObject({ isHost: true, connected: true });

    const reconnected = await connect(port);
    reconnected.send({ type: "reconnect", seq: 0, roomCode, reconnectToken: firstToken });
    const secondIdentity = await reconnected.next("identity");
    const secondIdentityIndex = reconnected.messages.indexOf(secondIdentity);
    const preReclaim = await reconnected.snapshot(secondIdentityIndex + 1, (snapshot) => snapshot.phase === "racing");
    expect(secondIdentity.localPlayerId).toBe(hostId);
    expect(secondIdentity.connectionGeneration).toBe((hostIdentity.connectionGeneration as number) + 1);
    expect(secondIdentity.reconnectToken).not.toBe(firstToken);
    expect(reconnected.messages[secondIdentityIndex + 1]?.type).toBe("snapshot");
    expect(state(preReclaim)).toMatchObject({
      roomCode,
      phase: "racing",
      raceId,
      configuration: { laps: 99 },
      canControlRace: false,
    });
    expect(player(preReclaim, hostId)).toMatchObject({ controller: "bot", reclaimPending: true, connected: true });
    expect(state(preReclaim).race!.cars.some((car) => car.id === hostId)).toBe(true);

    const replacedClose = new Promise<{ code: number; reason: string }>((resolve) => {
      reconnected.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    const replacement = await connect(port);
    replacement.send({
      type: "reconnect",
      seq: 0,
      roomCode,
      reconnectToken: secondIdentity.reconnectToken,
    });
    const thirdIdentity = await replacement.next("identity");
    const replacementSnapshot = await replacement.next("snapshot");
    expect(thirdIdentity).toMatchObject({
      localPlayerId: hostId,
      connectionGeneration: (secondIdentity.connectionGeneration as number) + 1,
    });
    expect(thirdIdentity.reconnectToken).not.toBe(secondIdentity.reconnectToken);
    expect(await replacedClose).toEqual({ code: 4001, reason: "Connection replaced" });
    await Bun.sleep(4);
    expect(player(guest.messages.filter((message) => message.type === "snapshot").at(-1)!, hostId).connected).toBe(true);
    expect(player(replacementSnapshot, hostId)).toMatchObject({ controller: "bot", reclaimPending: true });

    const rejectedOldToken = await connect(port);
    rejectedOldToken.send({ type: "reconnect", seq: 0, roomCode, reconnectToken: firstToken });
    expect((await rejectedOldToken.next("error")).code).toBe("command_rejected");

    const beforeCheckpoint = replacement.messages.length;
    server.advance(24);
    const reclaimed = await replacement.snapshot(beforeCheckpoint, (snapshot) => playerFrom(snapshot, hostId)?.controller === "human");
    expect(player(reclaimed, hostId)).toMatchObject({ reclaimPending: false, raceSeatId: hostId, connected: true });
    expect(state(reclaimed).canControlRace).toBe(true);
    expect(state(reclaimed).race!.cars.some((car) => car.id === hostId)).toBe(true);
    expect(player(reclaimed, hostId).isHost).toBe(false);
  });

  test("gives late joiners Spectator snapshots and rejects capabilities while half-open Racers lease to Bots", async () => {
    const { server, port } = await setup();
    const { host, guest, roomCode, hostIdentity } = await createAndJoin(port);
    const hostId = hostIdentity.localPlayerId as string;
    const raceId = await startRace(server, host);

    const spectator = await connect(port);
    spectator.send({ type: "join_room", seq: 0, name: "Late", roomCode });
    await spectator.next("identity");
    const spectatorSnapshot = await spectator.next("snapshot");
    expect(state(spectatorSnapshot)).toMatchObject({
      phase: "racing",
      localRole: "spectator",
      canControlRace: false,
      canStartRace: false,
      canRematch: false,
    });
    expect(state(spectatorSnapshot).race).toEqual(state(host.messages.filter((message) => message.type === "snapshot").at(-1)!).race);
    const spectatorId = spectatorSnapshot.localPlayerId as string;
    expect(player(spectatorSnapshot, spectatorId)).toMatchObject({ role: "spectator", raceSeatId: null, controller: "none" });

    spectator.send({ type: "start_race", seq: 1 });
    expect((await spectator.next("error")).code).toBe("command_rejected");
    const errorCount = spectator.messages.length;
    spectator.send({ type: "rematch", seq: 2, raceId });
    expect((await spectator.next("error", errorCount)).code).toBe("command_rejected");
    spectator.send({ type: "input", seq: 3, raceId });

    host.send({ type: "input", seq: 2, raceId });
    await Bun.sleep(2);
    const beforeLease = guest.messages.length;
    server.advance(INPUT_LEASE_TICKS - 1);
    const stillHuman = await guest.snapshot(beforeLease, (snapshot) => playerFrom(snapshot, hostId)?.controller === "human");
    expect(player(stillHuman, hostId).connected).toBe(true);
    server.advance(1);
    const leased = await guest.snapshot(beforeLease, (snapshot) => playerFrom(snapshot, hostId)?.controller === "bot");
    expect(player(leased, hostId)).toMatchObject({ connected: true, controller: "bot", raceSeatId: hostId });
    const spectatorAfterLease = await spectator.snapshot(errorCount, (snapshot) => playerFrom(snapshot, hostId)?.controller === "bot");
    expect(state(spectatorAfterLease).race).toEqual(state(leased).race);
    expect(state(spectatorAfterLease).lastProcessedInputSequence).toBeNull();
  });

  test("rematches to a fresh Race and old-Race commands cannot affect it", async () => {
    const fastTrack: Track = {
      ...track,
      id: "milestone-6-rematch",
      length: 10,
      checkpoints: [
        { id: "one", progress: 2 },
        { id: "two", progress: 4 },
        { id: "three", progress: 6 },
      ],
    };
    const { server, port } = await setup({ track: fastTrack, configuration: { laps: 1 } });
    const { host, guest } = await createAndJoin(port);
    const firstRaceId = await startRace(server, host);
    host.send({ type: "input", seq: 2, raceId: firstRaceId });
    guest.send({ type: "input", seq: 1, raceId: firstRaceId });
    await Bun.sleep(2);
    server.advance(8);
    const results = await host.snapshot(0, (snapshot) => snapshot.phase === "results");

    const rematchIndex = host.messages.length;
    host.send({ type: "rematch", seq: 3, raceId: firstRaceId });
    const open = await host.snapshot(rematchIndex, (snapshot) => snapshot.phase === "open");
    const secondRaceId = open.raceId as string;
    expect(secondRaceId).not.toBe(firstRaceId);
    expect(state(open).race).toBeNull();
    expect(state(results).race).not.toBeNull();

    host.send({ type: "input", seq: 4, raceId: firstRaceId });
    host.send({ type: "start_race", seq: 5 });
    const secondCountdown = await host.snapshot(rematchIndex, (snapshot) => snapshot.phase === "countdown");
    expect(secondCountdown.raceId).toBe(secondRaceId);
    expect(state(secondCountdown).lastProcessedInputSequence).toBe(-1);
    server.advance(COUNTDOWN_TICKS + 2);
    const secondRacing = await host.snapshot(rematchIndex, (snapshot) => snapshot.phase === "racing" && snapshot.race!.tick >= 1);
    const hostId = secondRacing.localPlayerId as string;
    expect(state(secondRacing).race!.cars.find((car) => car.id === hostId)!.speed).toBeGreaterThan(0);
  });

  test("uses one non-enumerating rejection for malformed and unknown reconnect tokens", async () => {
    const { port } = await setup();
    const malformed = await connect(port);
    malformed.send({ type: "reconnect", seq: 0, roomCode: "AB12", reconnectToken: "short" });
    expect(await malformed.next("error")).toMatchObject({ code: "command_rejected", message: "Reconnect unavailable" });

    const unknown = await connect(port);
    unknown.send({ type: "reconnect", seq: 0, roomCode: "AB12", reconnectToken: "a".repeat(43) });
    expect(await unknown.next("error")).toMatchObject({ code: "command_rejected", message: "Reconnect unavailable" });
  });

  test("removes an empty Room on the injected clock deadline and rejects reconnect", async () => {
    let now = 1_000;
    const { server, port } = await setup({ now: () => now });
    const host = await connect(port);
    host.send({ type: "create_room", seq: 0, name: "Host" });
    const identity = await host.next("identity");
    await host.next("snapshot");
    const roomCode = identity.roomCode as string;
    await host.closeAndWait();
    await waitFor(
      () => server.rooms.get(roomCode)?.snapshot().players.every((candidate) => !candidate.connected) || undefined,
      "server-side disconnect",
    );

    now += EMPTY_ROOM_EXPIRATION_MS - 1;
    server.advance();
    expect(server.rooms.has(roomCode)).toBe(true);
    now += 1;
    server.advance();
    expect(server.rooms.has(roomCode)).toBe(false);

    const reconnect = await connect(port);
    reconnect.send({ type: "reconnect", seq: 0, roomCode, reconnectToken: identity.reconnectToken });
    const error = await reconnect.next("error");
    expect(error).toMatchObject({ code: "command_rejected", message: "Reconnect unavailable" });
  });
});

function playerFrom(snapshot: StateView, playerId: string): PlayerView | undefined {
  return snapshot.players.find((candidate) => candidate.id === playerId);
}

function guestIdentityId(guest: TestClient): string {
  return guest.messages.find((message) => message.type === "identity")!.localPlayerId as string;
}
