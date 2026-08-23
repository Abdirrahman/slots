import { afterEach, describe, expect, test } from "bun:test";
import WebSocket from "ws";
import { COUNTDOWN_TICKS, POST_FINISH_TIMEOUT_TICKS } from "../src/multiplayer-config";
import { PROTOCOL_VERSION } from "../src/protocol";
import type { CarProfile, Track } from "../src/race";
import { createGameServer, type GameServer } from "../src/server";

const track: Track = {
  id: "integration-track",
  length: 10,
  lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
  startFinish: 0,
  checkpoints: [
    { id: "one", progress: 2 },
    { id: "two", progress: 4 },
    { id: "three", progress: 6 },
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

class TestClient {
  readonly socket: WebSocket;
  readonly messages: Message[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;
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
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = this.messages.slice(after).find((message) => message.type === type);
      if (found !== undefined) return found;
      await Bun.sleep(2);
    }
    throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(this.messages)}`);
  }

  async waitForPhase(phase: string): Promise<Message> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const snapshot = this.messages.filter((message) => message.type === "snapshot").at(-1);
      if ((snapshot?.state as { phase?: string } | undefined)?.phase === phase) return snapshot!;
      await Bun.sleep(2);
    }
    throw new Error(`Timed out waiting for phase ${phase}`);
  }

  close(): void {
    this.socket.close();
  }
}

const servers: GameServer[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
});

async function setup(): Promise<{ server: GameServer; port: number; host: TestClient; guest: TestClient }> {
  const server = createGameServer({ automaticTick: false, serveDirectory: null, track, carProfile: profile, configuration: { laps: 1 } });
  servers.push(server);
  const port = await server.listen(0);
  const host = await TestClient.connect(port);
  const guest = await TestClient.connect(port);
  clients.push(host, guest);
  return { server, port, host, guest };
}

function latestSnapshot(client: TestClient): Message {
  return client.messages.filter((message) => message.type === "snapshot").at(-1)!;
}

describe("authoritative WebSocket tracer bullet", () => {
  test("creates, joins, starts, processes intent, finishes identically, and rematches with a fresh Race", async () => {
    const { server, host, guest } = await setup();

    host.send({ type: "create_room", seq: 0, name: "Host" });
    const created = await host.next("snapshot");
    const roomCode = created.roomCode as string;
    expect((created.state as { players: unknown[] }).players).toHaveLength(1);

    guest.send({ type: "join_room", seq: 0, name: "Guest", roomCode });
    await guest.next("snapshot");
    await Bun.sleep(2);
    expect((latestSnapshot(host).state as { players: unknown[] }).players).toHaveLength(2);

    guest.send({ type: "start_race", seq: 1 });
    expect((await guest.next("error")).code).toBe("command_rejected");
    host.send({ type: "start_race", seq: 1 });
    await Bun.sleep(2);
    const hostCountdown = latestSnapshot(host);
    const guestCountdown = latestSnapshot(guest);
    expect((hostCountdown.state as { phase: string }).phase).toBe("countdown");
    expect(hostCountdown.raceId).toBe(guestCountdown.raceId);
    const firstRaceId = hostCountdown.raceId as string;

    server.advance(COUNTDOWN_TICKS);
    await Bun.sleep(2);
    expect((latestSnapshot(host).state as { phase: string }).phase).toBe("racing");

    host.send({ type: "input", seq: 2, raceId: firstRaceId, laneChange: 1 });
    host.send({ type: "input", seq: 2, raceId: firstRaceId });
    guest.send({ type: "input", seq: 2, raceId: firstRaceId });
    expect((await host.next("error")).code).toBe("stale_sequence");
    await Bun.sleep(2);
    server.advance(2);
    await Bun.sleep(2);
    const movingRace = (latestSnapshot(host).state as { race: { cars: { id: string; progress: number }[] } }).race;
    expect(movingRace.cars.every((car) => car.progress > 0)).toBe(true);

    server.advance(6);
    await Bun.sleep(2);
    const hostResults = latestSnapshot(host);
    const guestResults = latestSnapshot(guest);
    expect((hostResults.state as { phase: string }).phase).toBe("results");
    const hostRace = (hostResults.state as { race: unknown }).race;
    const guestRace = (guestResults.state as { race: unknown }).race;
    expect(hostRace).toEqual(guestRace);
    expect((hostRace as { status: string }).status).toBe("finished");

    host.send({ type: "rematch", seq: 3, raceId: firstRaceId });
    await Bun.sleep(2);
    expect((latestSnapshot(host).state as { phase: string }).phase).toBe("open");
    expect(latestSnapshot(host).raceId).not.toBe(firstRaceId);
    host.send({ type: "input", seq: 4, raceId: firstRaceId });
    host.send({ type: "start_race", seq: 5 });
    await Bun.sleep(2);
    const rematch = latestSnapshot(host);
    expect(rematch.raceId).not.toBe(firstRaceId);
    expect((rematch.state as { lastProcessedInputSequence: number }).lastProcessedInputSequence).toBe(-1);

    server.advance(COUNTDOWN_TICKS + 2);
    await Bun.sleep(2);
    const hostId = rematch.localPlayerId as string;
    const rematchRace = (latestSnapshot(host).state as { race: { cars: { id: string; speed: number }[] } }).race;
    expect(rematchRace.cars.find((car) => car.id === hostId)!.speed).toBeGreaterThan(0);
  });

  test("batch-resolves exchange claims and publishes authoritative contact identically", async () => {
    const contactTrack: Track = {
      id: "contact-integration",
      length: 120,
      lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
      startFinish: 0,
      checkpoints: [{ id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 }],
    };
    const contactProfile: CarProfile = {
      accelerationPerSecondSquared: 300,
      topSpeedPerSecond: 300,
      brakingPerSecondSquared: 10_000,
      laneChangeDurationTicks: 4,
    };
    const server = createGameServer({ automaticTick: false, serveDirectory: null, track: contactTrack, carProfile: contactProfile, configuration: { laps: 99 } });
    servers.push(server);
    const port = await server.listen(0);
    const host = await TestClient.connect(port);
    const guest = await TestClient.connect(port);
    clients.push(host, guest);
    host.send({ type: "create_room", seq: 0, name: "Host" });
    const roomCode = (await host.next("snapshot")).roomCode as string;
    guest.send({ type: "join_room", seq: 0, name: "Guest", roomCode });
    await guest.next("snapshot");
    host.send({ type: "start_race", seq: 1 });
    await Bun.sleep(2);
    const raceId = latestSnapshot(host).raceId as string;
    server.advance(COUNTDOWN_TICKS + 1);
    await Bun.sleep(2);

    const hostId = latestSnapshot(host).localPlayerId as string;
    const guestId = latestSnapshot(guest).localPlayerId as string;
    const initialCars = (latestSnapshot(host).state as { race: { cars: { id: string; lane: number }[] } }).race.cars;
    const clientsById = new Map([[hostId, host], [guestId, guest]]);
    const sequences = new Map([[hostId, 2], [guestId, 1]]);
    const laneZero = initialCars.find((value) => value.lane === 0)!;
    const laneOne = initialCars.find((value) => value.lane === 1)!;
    clientsById.get(laneZero.id)!.send({ type: "input", seq: sequences.get(laneZero.id)!, raceId, laneChange: 1 });
    sequences.set(laneZero.id, sequences.get(laneZero.id)! + 1);
    clientsById.get(laneOne.id)!.send({ type: "input", seq: sequences.get(laneOne.id)!, raceId, laneChange: -1 });
    sequences.set(laneOne.id, sequences.get(laneOne.id)! + 1);
    await Bun.sleep(2);
    server.advance();
    await Bun.sleep(2);
    const exchangeRace = (latestSnapshot(host).state as { race: { cars: { laneTransition: { phase: string } | null }[] } }).race;
    expect(exchangeRace.cars.every((value) => value.laneTransition?.phase === "returning")).toBe(true);
    expect(exchangeRace).toEqual((latestSnapshot(guest).state as { race: typeof exchangeRace }).race);

  });

  test("disconnect clears input and bounded Results are canonical before rematch", async () => {
    const { server, port, host, guest } = await setup();
    const third = await TestClient.connect(port);
    clients.push(third);
    host.send({ type: "create_room", seq: 0, name: "Host" });
    const roomCode = (await host.next("snapshot")).roomCode as string;
    guest.send({ type: "join_room", seq: 0, name: "Guest", roomCode });
    third.send({ type: "join_room", seq: 0, name: "Third", roomCode });
    await third.next("snapshot");
    host.send({ type: "start_race", seq: 1 });
    await Bun.sleep(2);
    const raceId = latestSnapshot(host).raceId as string;
    server.advance(COUNTDOWN_TICKS);
    guest.send({ type: "input", seq: 1, raceId });
    guest.close();
    await Bun.sleep(5);
    host.send({ type: "input", seq: 2, raceId });
    await Bun.sleep(2);
    server.advance(10 + POST_FINISH_TIMEOUT_TICKS);
    const [hostResults, thirdResults] = await Promise.all([
      host.waitForPhase("results"),
      third.waitForPhase("results"),
    ]);
    expect((hostResults.state as { phase: string }).phase).toBe("results");
    expect((hostResults.state as { race: unknown }).race).toEqual((thirdResults.state as { race: unknown }).race);
    const results = (hostResults.state as { race: { cars: { result: string }[] } }).race.cars.map((value) => value.result);
    expect(results.every((result) => result === "finished")).toBe(true);

    host.send({ type: "rematch", seq: 3, raceId });
    const rematch = await host.waitForPhase("open");
    expect(rematch.raceId).not.toBe(raceId);
  });

  test("publishes canonical obstacle Crash, recovery, Respawn, and Ghost state", async () => {
    const mechanicTrack: Track = {
      id: "mechanic-integration",
      length: 120,
      lanes: [{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }],
      startFinish: 0,
      checkpoints: [{ id: "one", progress: 30 }, { id: "two", progress: 60 }, { id: "three", progress: 90 }],
      fixedObstacles: [0, 1, 2, 3].map((lane) => ({ id: `obstacle-${lane}`, progress: 2, lane: lane as 0 | 1 | 2 | 3 })),
      powerUpOpportunities: [],
      hazardPlacementLocations: [],
    };
    const mechanicProfile: CarProfile = {
      accelerationPerSecondSquared: 1_800,
      topSpeedPerSecond: 60,
      brakingPerSecondSquared: 10_000,
      laneChangeDurationTicks: 1,
    };
    const server = createGameServer({ automaticTick: false, serveDirectory: null, track: mechanicTrack, carProfile: mechanicProfile, configuration: { laps: 99 } });
    servers.push(server);
    const port = await server.listen(0);
    const host = await TestClient.connect(port);
    const guest = await TestClient.connect(port);
    clients.push(host, guest);
    host.send({ type: "create_room", seq: 0, name: "Host" });
    const roomCode = (await host.next("snapshot")).roomCode as string;
    guest.send({ type: "join_room", seq: 0, name: "Guest", roomCode });
    await guest.next("snapshot");
    host.send({ type: "start_race", seq: 1 });
    await Bun.sleep(2);
    const raceId = latestSnapshot(host).raceId as string;
    server.advance(COUNTDOWN_TICKS);
    host.send({ type: "input", seq: 2, raceId });
    guest.send({ type: "input", seq: 1, raceId });
    await Bun.sleep(2);
    server.advance(2);
    await Bun.sleep(2);

    const crashedHostRace = (latestSnapshot(host).state as { race: { cars: { crashRecoveryTicksRemaining: number }[] } }).race;
    const crashedGuestRace = (latestSnapshot(guest).state as { race: typeof crashedHostRace }).race;
    expect(crashedGuestRace).toEqual(crashedHostRace);
    expect(crashedHostRace.cars.every((car) => car.crashRecoveryTicksRemaining > 0)).toBe(true);

    server.advance(90);
    await Bun.sleep(2);
    const respawnedHostRace = (latestSnapshot(host).state as { race: { cars: { crashRecoveryTicksRemaining: number; ghost: boolean }[] } }).race;
    const respawnedGuestRace = (latestSnapshot(guest).state as { race: typeof respawnedHostRace }).race;
    expect(respawnedGuestRace).toEqual(respawnedHostRace);
    expect(respawnedHostRace.cars.every((car) => car.crashRecoveryTicksRemaining === 0 && car.ghost)).toBe(true);
  });

  test("rejects authoritative claims and closes protocol-incompatible connections clearly", async () => {
    const { host } = await setup();
    host.socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "input", seq: 0, raceId: "race-1", progress: 99 }));
    expect((await host.next("error")).code).toBe("invalid_command");

    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      host.socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    host.socket.send(JSON.stringify({ protocolVersion: 999, type: "start_race", seq: 1 }));
    expect(await closed).toEqual({ code: 1002, reason: "Unsupported protocol version" });
  });
});
