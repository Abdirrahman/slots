import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { COUNTDOWN_TICKS } from "../src/multiplayer-config";
import { PROTOCOL_VERSION } from "../src/protocol";
import type { CarProfile, Track } from "../src/race";
import { createGameServer, type GameServer } from "../src/server";

const fastTrack: Track = {
  id: "solo-integration",
  version: "1.0.0",
  length: 10,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  startFinish: 0,
  checkpoints: [
    { id: "one", progress: 2 },
    { id: "two", progress: 4 },
    { id: "three", progress: 6 },
  ],
  fixedObstacles: [],
  powerUpOpportunities: [],
  hazardPlacementLocations: [],
};
const fastProfile: CarProfile = {
  accelerationPerSecondSquared: 300,
  topSpeedPerSecond: 300,
  brakingPerSecondSquared: 10_000,
  laneChangeDurationTicks: 3,
};

interface Message {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface SoloState {
  readonly phase: "open" | "countdown" | "racing" | "results";
  readonly raceId: string | null;
  readonly soloConfiguration: { readonly botCount: number; readonly botDifficulty: "easy" | "normal" | "hard" };
  readonly configuredBots: readonly { readonly id: string; readonly name: string }[];
  readonly players: readonly { readonly id: string; readonly name: string; readonly controller: string; readonly reclaimPending: boolean }[];
  readonly race: null | {
    readonly tick: number;
    readonly cars: readonly { readonly id: string; readonly speed: number; readonly progress: number; readonly result: string; readonly finishedAtSeconds: number | null }[];
  };
}

class Client {
  readonly messages: Message[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => this.messages.push(JSON.parse(data.toString()) as Message));
  }

  static async connect(port: number): Promise<Client> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    return new Client(socket);
  }

  send(command: Record<string, unknown>): void {
    this.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...command }));
  }

  async next(type: string, after = 0): Promise<Message> {
    return waitFor(() => this.messages.slice(after).find((message) => message.type === type), type);
  }

  async snapshot(after: number, predicate: (state: SoloState) => boolean): Promise<Message> {
    return waitFor(
      () => this.messages.slice(after).find((message) => message.type === "snapshot" && predicate(message.state as SoloState)),
      "matching Solo snapshot",
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
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(2);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connect(port: number): Promise<Client> {
  const client = await Client.connect(port);
  clients.push(client);
  return client;
}

function state(message: Message): SoloState {
  return message.state as SoloState;
}

describe("authoritative Solo Quick Race WebSocket flow", () => {
  test("creates and starts a canonical Solo Race for each valid Bot count", async () => {
    const server = createGameServer({
      automaticTick: false,
      serveDirectory: null,
      track: fastTrack,
      carProfile: fastProfile,
      configuration: { laps: 1 },
    });
    servers.push(server);
    const port = await server.listen(0);

    for (const botCount of [1, 2, 3]) {
      const client = await connect(port);
      client.send({ type: "create_solo_race", seq: 0, name: `Human ${botCount}`, botCount, botDifficulty: "hard" });
      const identity = await client.next("identity");
      const countdown = await client.snapshot(0, (snapshot) => snapshot.phase === "countdown");
      const countdownState = state(countdown);
      expect(countdownState.players).toHaveLength(1);
      expect(countdownState.configuredBots).toHaveLength(botCount);
      expect(countdownState.race!.cars).toHaveLength(1 + botCount);
      expect(countdownState.soloConfiguration).toEqual({ botCount, botDifficulty: "hard" });
      expect(countdown.raceId).toBeString();

      server.advance(COUNTDOWN_TICKS + 2);
      const racing = await client.snapshot(client.messages.indexOf(countdown), (snapshot) => snapshot.phase === "racing" && snapshot.race!.tick >= 1);
      expect(state(racing).race!.cars.every((car) => car.speed > 0 && car.progress > 0)).toBe(true);
      expect(state(racing).race).toEqual(server.rooms.get(identity.roomCode as string)!.snapshot().race);

      server.advance(60);
      const results = await client.snapshot(client.messages.indexOf(racing), (snapshot) => snapshot.phase === "results");
      expect(state(results).race!.cars.every((car) => car.result === "finished" && car.finishedAtSeconds !== null)).toBe(true);
      expect(new Map([
        ...state(results).players.map((player) => [player.id, player.name] as const),
        ...state(results).configuredBots.map((bot) => [bot.id, bot.name] as const),
      ])).toEqual(new Map(state(results).race!.cars.map((car) => [
        car.id,
        car.id.startsWith("configured-bot-") ? `Bot ${car.id.at(-1)}` : `Human ${botCount}`,
      ] as const)));
    }
  });

  test("rejects new joins to a Solo Room", async () => {
    const server = createGameServer({ automaticTick: false, serveDirectory: null, track: fastTrack, carProfile: fastProfile });
    servers.push(server);
    const port = await server.listen(0);
    const host = await connect(port);
    host.send({ type: "create_solo_race", seq: 0, name: "Human", botCount: 1, botDifficulty: "easy" });
    const identity = await host.next("identity");
    await host.next("snapshot");

    const joining = await connect(port);
    joining.send({ type: "join_room", seq: 0, name: "Intruder", roomCode: identity.roomCode });
    expect(await joining.next("error")).toMatchObject({ code: "command_rejected", message: "Solo Rooms do not accept joins" });
  });

  test("reconnects the same human seat while configured Bots continue and reclaim remains authoritative", async () => {
    const server = createGameServer({
      automaticTick: false,
      serveDirectory: null,
      track: { ...fastTrack, length: 120, checkpoints: [
        { id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 },
      ] },
      carProfile: { ...fastProfile, accelerationPerSecondSquared: 900, topSpeedPerSecond: 90 },
      configuration: { laps: 99 },
    });
    servers.push(server);
    const port = await server.listen(0);
    const original = await connect(port);
    original.send({ type: "create_solo_race", seq: 0, name: "Human", botCount: 2, botDifficulty: "normal" });
    const firstIdentity = await original.next("identity");
    const countdown = await original.next("snapshot");
    server.advance(COUNTDOWN_TICKS + 4);
    const before = await original.snapshot(original.messages.indexOf(countdown), (snapshot) => snapshot.phase === "racing" && snapshot.race!.tick >= 4);
    const humanId = firstIdentity.localPlayerId as string;
    const botIds = state(before).configuredBots.map((bot) => bot.id);

    await original.closeAndWait();
    await waitFor(
      () => server.rooms.get(firstIdentity.roomCode as string)?.snapshot().players[0]?.connected === false || undefined,
      "Solo disconnect",
    );
    server.advance(6);

    const replacement = await connect(port);
    replacement.send({ type: "reconnect", seq: 0, roomCode: firstIdentity.roomCode, reconnectToken: firstIdentity.reconnectToken });
    const secondIdentity = await replacement.next("identity");
    const restored = await replacement.next("snapshot");
    expect(secondIdentity.localPlayerId).toBe(humanId);
    expect(state(restored).players[0]).toMatchObject({ id: humanId, controller: "bot", reclaimPending: true });
    expect(state(restored).race!.tick).toBeGreaterThan(state(before).race!.tick);
    expect(state(restored).configuredBots.map((bot) => bot.id)).toEqual(botIds);
    expect(botIds.every((id) => state(restored).race!.cars.some((car) => car.id === id && car.progress > 0))).toBe(true);

    const after = replacement.messages.length;
    server.advance(40);
    const reclaimed = await replacement.snapshot(after, (snapshot) => snapshot.players[0]?.controller === "human");
    expect(state(reclaimed).players[0]).toMatchObject({ id: humanId, reclaimPending: false });
    expect(state(reclaimed).configuredBots.map((bot) => bot.id)).toEqual(botIds);
  });

  test("rematches with a fresh Race id and the same Solo options", async () => {
    const server = createGameServer({ automaticTick: false, serveDirectory: null, track: fastTrack, carProfile: fastProfile, configuration: { laps: 1 } });
    servers.push(server);
    const port = await server.listen(0);
    const client = await connect(port);
    client.send({ type: "create_solo_race", seq: 0, name: "Human", botCount: 3, botDifficulty: "hard" });
    const countdown = await client.next("snapshot");
    const firstRaceId = countdown.raceId as string;
    server.advance(COUNTDOWN_TICKS + 60);
    const results = await client.snapshot(client.messages.indexOf(countdown), (snapshot) => snapshot.phase === "results");

    client.send({ type: "rematch", seq: 1, raceId: firstRaceId });
    const open = await client.snapshot(client.messages.indexOf(results), (snapshot) => snapshot.phase === "open");
    expect(open.raceId).not.toBe(firstRaceId);
    expect(state(open).soloConfiguration).toEqual({ botCount: 3, botDifficulty: "hard" });
    expect(state(open).configuredBots.map((bot) => bot.name)).toEqual(["Bot 1", "Bot 2", "Bot 3"]);

    client.send({ type: "start_race", seq: 2 });
    const rematch = await client.snapshot(client.messages.indexOf(open), (snapshot) => snapshot.phase === "countdown");
    expect(rematch.raceId).toBe(open.raceId);
    expect(state(rematch).race!.cars).toHaveLength(4);
  });
});

test("manual Time Trial inputs and one-click voltage rematches survive the real websocket contract", async () => {
  const server = createGameServer({ automaticTick: false, serveDirectory: null, track: { ...fastTrack, length: 120,
    checkpoints: [{ id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 }] } });
  servers.push(server);
  const port = await server.listen(0);
  const client = await connect(port);
  client.send({ type: "create_solo_race", seq: 0, name: "Human", botCount: 0, botDifficulty: "normal",
    configuration: { laps: 1, rules: "trial", assist: false, voltage: 3 } });
  const identity = await client.next("identity");
  const countdown = await client.next("snapshot");
  const room = server.rooms.get(identity.roomCode as string)!;
  const id = identity.localPlayerId as string;
  const firstRaceId = room.raceId!;
  server.advance(COUNTDOWN_TICKS + 30);
  expect(room.race!.cars[0]!.speed).toBe(0);
  expect(room.race!.powerUpOpportunities).toEqual([]);
  let seq = 0;
  const input = async (throttle: number, brake: boolean) => {
    const sent = ++seq;
    client.send({ type: "input", seq: sent, raceId: firstRaceId, throttle, brake });
    await waitFor(() => room.snapshot(id).lastProcessedInputSequence === sent || undefined, "continuous drive input");
  };
  await input(1, false); server.advance(30);
  expect(room.race!.cars[0]!.speed).toBeGreaterThan(0);
  await input(0, true); server.advance(30);
  expect(room.race!.cars[0]!.speed).toBe(0);
  for (let batch = 0; batch < 30 && room.phase === "racing"; batch += 1) { await input(1, false); server.advance(30); }
  const results = await client.snapshot(client.messages.indexOf(countdown), (snapshot) => snapshot.phase === "results");
  expect(room.snapshot(id).players[0]!.bestTimeEligible).toBe(true);
  client.send({ type: "rematch", seq: ++seq, raceId: firstRaceId,
    configuration: { laps: 1, rules: "trial", assist: true, voltage: 6 } });
  const rematch = await client.snapshot(client.messages.indexOf(results), (snapshot) => snapshot.phase === "countdown");
  expect(rematch.raceId).not.toBe(firstRaceId);
  expect(room.race!.configuration).toEqual({ laps: 1, rules: "trial", assist: true, voltage: 6 });
  expect(room.race!.cars[0]!.profile.topSpeedPerSecond).toBe(18);
});
