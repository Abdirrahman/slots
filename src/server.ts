import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { DEFAULT_TRACK } from "./authored-track";
import { MAX_EVENT_BATCH, MAX_MESSAGE_BYTES, SERVER_TICKS_PER_SECOND } from "./multiplayer-config";
import { PROTOCOL_VERSION, ProtocolError, parseClientCommand, type ClientCommand } from "./protocol";
import type { CarProfile, RaceConfiguration, RaceEvent, Track } from "./race";
import { Room, type RoomConnectionIdentity } from "./room";

export interface GameServerOptions {
  readonly automaticTick?: boolean;
  readonly track?: Track;
  readonly carProfile?: CarProfile;
  readonly configuration?: RaceConfiguration;
  readonly serveDirectory?: string | null;
  readonly now?: () => number;
}

interface Connection {
  readonly socket: WebSocket;
  playerId: string | null;
  generation: number | null;
  room: Room | null;
  lastSequence: number;
}

export interface GameServer {
  readonly rooms: ReadonlyMap<string, Room>;
  listen(port?: number, host?: string): Promise<number>;
  advance(ticks?: number): void;
  close(): Promise<void>;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createGameServer(options: GameServerOptions = {}): GameServer {
  const rooms = new Map<string, Room>();
  const connections = new Set<Connection>();
  const serveDirectory = options.serveDirectory === undefined ? join(process.cwd(), "dist") : options.serveDirectory;
  const httpServer = createServer((request, response) => {
    if (serveDirectory === null) { response.writeHead(404).end(); return; }
    serveStatic(serveDirectory, request.url ?? "/", response);
  });
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  let interval: ReturnType<typeof setInterval> | null = null;

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") { socket.destroy(); return; }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit("connection", webSocket));
  });

  webSocketServer.on("connection", (socket) => {
    const connection: Connection = { socket, playerId: null, generation: null, room: null, lastSequence: -1 };
    connections.add(connection);
    socket.on("message", (data) => handleMessage(connection, rawDataBytes(data)));
    socket.on("close", () => {
      connections.delete(connection);
      if (connection.room !== null && connection.playerId !== null && connection.generation !== null
        && connection.room.disconnect(connection.playerId, connection.generation)) broadcast(connection.room);
    });
    socket.on("error", () => {});
  });

  function handleMessage(connection: Connection, data: Uint8Array): void {
    let command: ClientCommand;
    try {
      command = parseClientCommand(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid command";
      const reconnect = looksLikeReconnect(data);
      sendError(connection.socket, reconnect ? "command_rejected" : error instanceof ProtocolError ? "invalid_command" : "server_error",
        reconnect ? "Reconnect unavailable" : message);
      if (message === "Unsupported protocol version") connection.socket.close(1002, message);
      if (message === "Message exceeds byte limit") connection.socket.close(1009, message);
      return;
    }
    if (command.seq <= connection.lastSequence) {
      sendError(connection.socket, "stale_sequence", "Sequence must increase on this connection");
      return;
    }
    connection.lastSequence = command.seq;
    try { routeCommand(connection, command); }
    catch (error) { sendError(connection.socket, "command_rejected", error instanceof Error ? error.message : "Command rejected"); }
  }

  function routeCommand(connection: Connection, command: ClientCommand): void {
    if (command.type === "create_room" || command.type === "create_solo_race") {
      requireNoRoom(connection);
      const code = createUniqueRoomCode(rooms);
      const playerId = randomUUID();
      const room = new Room({
        code,
        hostId: playerId,
        hostName: command.name,
        ...(command.carAssetId === undefined ? {} : { hostCarAssetId: command.carAssetId }),
        track: options.track ?? DEFAULT_TRACK,
        ...(options.carProfile === undefined ? {} : { carProfile: options.carProfile }),
        ...((command.configuration ?? options.configuration) === undefined ? {} : { configuration: command.configuration ?? options.configuration }),
        ...(command.type === "create_solo_race" ? {
          soloConfiguration: { botCount: command.botCount, botDifficulty: command.botDifficulty },
        } : {}),
        createReconnectToken,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      rooms.set(code, room);
      bind(connection, room, room.connectionIdentity(playerId)!);
      if (command.type === "create_solo_race" && room.startRace(playerId) === null) {
        rooms.delete(code);
        throw new Error("Solo Race could not start");
      }
      sendIdentity(connection);
      broadcast(room);
      return;
    }
    if (command.type === "join_room") {
      requireNoRoom(connection);
      const room = rooms.get(command.roomCode);
      if (room === undefined) throw new Error("Room not found");
      const playerId = randomUUID();
      room.join(playerId, command.name, command.carAssetId);
      bind(connection, room, room.connectionIdentity(playerId)!);
      sendIdentity(connection);
      broadcast(room);
      return;
    }
    if (command.type === "reconnect") {
      requireNoRoom(connection);
      const room = rooms.get(command.roomCode);
      const identity = room?.reconnect(command.reconnectToken) ?? null;
      if (room === undefined || identity === null) throw new Error("Reconnect unavailable");
      const replaced = [...connections].filter((candidate) => candidate !== connection && candidate.room === room
        && candidate.playerId === identity.playerId && candidate.generation !== identity.connectionGeneration);
      bind(connection, room, identity);
      sendIdentity(connection);
      broadcast(room);
      for (const stale of replaced) stale.socket.close(4001, "Connection replaced");
      return;
    }

    const room = activeRoom(connection);
    const playerId = connection.playerId!;
    if (command.type === "start_race") {
      if (room.startRace(playerId) === null) throw new Error("Only the Host can start an Open Room");
      broadcast(room);
      return;
    }
    if (command.type === "input") {
      room.acceptInput(playerId, connection.generation!, command);
      return;
    }
    if (command.configuration !== undefined && command.configuration.rules !== room.snapshot(playerId).configuration.rules) throw new Error("Rematch must retain its rules preset");
    if (!room.rematch(playerId, command.raceId)) throw new Error("Only the Host can rematch current Results");
    if (command.configuration !== undefined) {
      const current = room.snapshot(playerId);
      if (command.configuration.rules !== current.configuration.rules) throw new Error("Rematch must retain its rules preset");
      room.configureRace(playerId, command.configuration);
    }
    const ready = room.snapshot(playerId);
    if (ready.soloConfiguration !== null && ready.configuration.rules !== undefined) room.startRace(playerId);
    broadcast(room);
  }

  function advance(ticks = 1): void {
    for (let tick = 0; tick < ticks; tick += 1) {
      for (const [code, room] of [...rooms]) {
        const before = room.phase;
        const advanced = room.advance();
        if (room.isExpired()) { rooms.delete(code); continue; }
        if (advanced.events.length > 0 && room.raceId !== null) broadcastRaceEvents(room, room.raceId, advanced.events);
        if (advanced.snapshotDue || before !== room.phase) broadcast(room);
      }
    }
  }

  function broadcastRaceEvents(room: Room, raceId: string, events: readonly RaceEvent[]): void {
    for (let offset = 0; offset < events.length; offset += MAX_EVENT_BATCH) {
      const batch = events.slice(offset, offset + MAX_EVENT_BATCH).map((event, index) => ({
        id: `${raceId}:${event.tick}:${offset + index}`,
        event,
      }));
      const message = JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "race_events", roomCode: room.code, raceId, events: batch });
      for (const connection of connections) {
        if (connection.room === room && connection.playerId !== null && connection.generation !== null
          && room.isActiveConnection(connection.playerId, connection.generation)
          && connection.socket.readyState === WebSocket.OPEN) connection.socket.send(message);
      }
    }
  }

  function broadcast(room: Room): void {
    for (const connection of connections) {
      if (connection.room !== room || connection.playerId === null || connection.generation === null
        || !room.isActiveConnection(connection.playerId, connection.generation)
        || connection.socket.readyState !== WebSocket.OPEN) continue;
      const snapshot = room.snapshot(connection.playerId);
      connection.socket.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        type: "snapshot",
        roomCode: snapshot.roomCode,
        raceId: snapshot.raceId,
        simulationTick: snapshot.race?.tick ?? 0,
        stateVersion: snapshot.stateVersion,
        lastProcessedInputSequence: snapshot.lastProcessedInputSequence,
        localPlayerId: connection.playerId,
        connectionGeneration: connection.generation,
        state: snapshot,
      }));
    }
  }

  function sendIdentity(connection: Connection): void {
    const identity = connection.room!.connectionIdentity(connection.playerId!)!;
    if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      type: "identity",
      roomCode: connection.room!.code,
      localPlayerId: identity.playerId,
      reconnectToken: identity.reconnectToken,
      connectionGeneration: identity.connectionGeneration,
    }));
  }

  return {
    rooms,
    listen(port = 3000, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.off("error", reject);
          const address = httpServer.address();
          if (address === null || typeof address === "string") return reject(new Error("Server has no TCP port"));
          if (options.automaticTick !== false) interval = setInterval(() => advance(), 1_000 / SERVER_TICKS_PER_SECOND);
          resolve(address.port);
        });
      });
    },
    advance,
    close() {
      if (interval !== null) clearInterval(interval);
      for (const connection of connections) connection.socket.terminate();
      webSocketServer.close();
      httpServer.close();
      httpServer.closeAllConnections();
      return Promise.resolve();
    },
  };
}

function bind(connection: Connection, room: Room, identity: RoomConnectionIdentity): void {
  connection.room = room;
  connection.playerId = identity.playerId;
  connection.generation = identity.connectionGeneration;
  connection.lastSequence = -1;
}

function activeRoom(connection: Connection): Room {
  if (connection.room === null || connection.playerId === null || connection.generation === null) {
    throw new Error("Create, join, or reconnect to a Room first");
  }
  if (!connection.room.isActiveConnection(connection.playerId, connection.generation)) throw new Error("Connection replaced");
  return connection.room;
}

function requireNoRoom(connection: Connection): void {
  if (connection.room !== null) throw new Error("Connection already belongs to a Room");
}

function createReconnectToken(): string { return randomBytes(32).toString("base64url"); }

function createUniqueRoomCode(rooms: ReadonlyMap<string, Room>): string {
  for (;;) {
    const bytes = randomBytes(5);
    let code = "";
    for (const byte of bytes) code += ROOM_CODE_ALPHABET[byte! % ROOM_CODE_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
}

function looksLikeReconnect(data: Uint8Array): boolean {
  try {
    const value = JSON.parse(new TextDecoder().decode(data)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && (value as Record<string, unknown>).type === "reconnect";
  } catch {
    return false;
  }
}

function rawDataBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

function sendError(socket: WebSocket, code: string, message: string): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: "error", code, message }));
}

function serveStatic(directory: string, requestUrl: string, response: import("node:http").ServerResponse): void {
  const url = new URL(requestUrl, "http://localhost");
  const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^[/\\]+/u, "");
  const file = join(directory, relative);
  if (!file.startsWith(`${normalize(directory)}/`) || !existsSync(file)) { response.writeHead(404).end("Not found"); return; }
  const types: Record<string, string> = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".map": "application/json" };
  response.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
  createReadStream(file).pipe(response);
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === normalize(entry)) {
  const server = createGameServer();
  const port = await server.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
  console.log(`Slots Racing server listening on http://localhost:${port}`);
}
