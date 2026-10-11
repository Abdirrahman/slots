import {
  MAX_CONFIGURED_BOTS,
  MAX_GUEST_NAME_LENGTH,
  MAX_MESSAGE_BYTES,
  MAX_RACE_ID_LENGTH,
  MAX_ROOM_CODE_LENGTH,
  RECONNECT_TOKEN_LENGTH,
  MAX_SEQUENCE,
  MIN_ROOM_CODE_LENGTH,
  type BotDifficulty,
} from "./multiplayer-config";
import type { IdentifiedRaceEvent } from "./feedback";
import type { RaceConfiguration, LaneChangeDirection } from "./race";
import { isRacingCarAssetId } from "./racing-assets";

export const PROTOCOL_VERSION = 10 as const;

interface CommandBase {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly seq: number;
}

export interface CreateRoomCommand extends CommandBase {
  readonly type: "create_room";
  readonly name: string;
  readonly configuration?: RaceConfiguration;
  readonly carAssetId?: string;
}

export interface CreateSoloRaceCommand extends CommandBase {
  readonly type: "create_solo_race";
  readonly name: string;
  readonly configuration?: RaceConfiguration;
  readonly carAssetId?: string;
  readonly botCount: number;
  readonly botDifficulty: BotDifficulty;
}

export interface JoinRoomCommand extends CommandBase {
  readonly type: "join_room";
  readonly name: string;
  readonly carAssetId?: string;
  readonly roomCode: string;
}

export interface ReconnectCommand extends CommandBase {
  readonly type: "reconnect";
  readonly roomCode: string;
  readonly reconnectToken: string;
}

export interface StartRaceCommand extends CommandBase {
  readonly type: "start_race";
}

export interface InputCommand extends CommandBase {
  readonly type: "input";
  readonly raceId: string;
  readonly laneChange?: LaneChangeDirection;
  /** Spend one Boost charge. Present only when the Racer asked for it. */
  readonly useBoost?: true;
  readonly throttle?: number;
  readonly brake?: boolean;
  readonly useShield?: true;
  readonly useMine?: true;
  readonly barge?: true;
}

export interface RematchCommand extends CommandBase {
  readonly configuration?: RaceConfiguration;
  readonly type: "rematch";
  readonly raceId: string;
}

export type ClientCommand =
  | CreateRoomCommand
  | CreateSoloRaceCommand
  | JoinRoomCommand
  | ReconnectCommand
  | StartRaceCommand
  | InputCommand
  | RematchCommand;

export interface ServerSnapshotMessage<State = unknown> {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "snapshot";
  readonly roomCode: string;
  readonly raceId: string | null;
  readonly simulationTick: number;
  readonly stateVersion: number;
  readonly lastProcessedInputSequence: number | null;
  readonly localPlayerId: string;
  readonly connectionGeneration: number;
  readonly state: State;
}

export interface ServerRaceEventsMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "race_events";
  readonly roomCode: string;
  readonly raceId: string;
  readonly events: readonly IdentifiedRaceEvent[];
}

export interface ServerIdentityMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "identity";
  readonly roomCode: string;
  readonly localPlayerId: string;
  readonly reconnectToken: string;
  readonly connectionGeneration: number;
}

export interface ServerErrorMessage {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

export function parseClientCommand(data: string | Uint8Array): ClientCommand {
  const byteLength = typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
  if (byteLength > MAX_MESSAGE_BYTES) throw new ProtocolError("Message exceeds byte limit");

  let text: string;
  try {
    text = typeof data === "string" ? data : decoder.decode(data);
  } catch {
    throw new ProtocolError("Message is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("Message is not valid JSON");
  }

  if (!isObject(value)) throw new ProtocolError("Command must be a JSON object");
  requireVersionAndSequence(value);

  switch (value.type) {
    case "create_room":
      requireExactKeys(value, ["protocolVersion", "type", "seq", "name", ...configurationKeys(value), ...carSelectionKeys(value)]);
      requireGuestName(value.name);
      if (isObject(value.configuration) && value.configuration.rules === "trial") fail("Time Trial must be created as a solo race");
      return value as unknown as CreateRoomCommand;
    case "create_solo_race":
      requireExactKeys(value, ["protocolVersion", "type", "seq", "name", "botCount", "botDifficulty", ...configurationKeys(value), ...carSelectionKeys(value)]);
      requireGuestName(value.name);
      if (!Number.isInteger(value.botCount) || (value.botCount as number) < (isObject(value.configuration) && value.configuration.rules === "trial" ? 0 : 1) || (value.botCount as number) > MAX_CONFIGURED_BOTS) {
        fail(`Bot count must be an integer from 1 to ${MAX_CONFIGURED_BOTS}`);
      }
      if (isObject(value.configuration) && value.configuration.rules === "trial" && value.botCount !== 0) fail("Time Trial requires zero bots");
      requireBotDifficulty(value.botDifficulty);
      return value as unknown as CreateSoloRaceCommand;
    case "join_room":
      requireExactKeys(value, ["protocolVersion", "type", "seq", "name", "roomCode", ...carSelectionKeys(value)]);
      requireGuestName(value.name);
      requireRoomCode(value.roomCode);
      return value as unknown as JoinRoomCommand;
    case "reconnect":
      requireExactKeys(value, ["protocolVersion", "type", "seq", "roomCode", "reconnectToken"]);
      requireRoomCode(value.roomCode);
      requireReconnectToken(value.reconnectToken);
      return value as unknown as ReconnectCommand;
    case "start_race":
      requireExactKeys(value, ["protocolVersion", "type", "seq"]);
      return value as unknown as StartRaceCommand;
    case "input":
      requireExactKeys(value, [
        "protocolVersion", "type", "seq", "raceId",
        ...(value.laneChange === undefined ? [] : ["laneChange"]),
        ...(value.useBoost === undefined ? [] : ["useBoost"]),
        ...["throttle", "brake", "useShield", "useMine", "barge"].filter((key) => value[key] !== undefined),
      ]);
      requireRaceId(value.raceId);
      if (value.laneChange !== undefined && value.laneChange !== -1 && value.laneChange !== 1) {
        fail("Lane change must be -1 or 1");
      }
      // Only the affirmative is on the wire, so an absent intent cannot be spelled two ways.
      // An input carrying no intent at all is the heartbeat that holds the human input lease.
      if (value.useBoost !== undefined && value.useBoost !== true) fail("Boost intent must be true when present");
      if (value.throttle !== undefined && (typeof value.throttle !== "number" || !Number.isFinite(value.throttle) || value.throttle < 0 || value.throttle > 1)) fail("Throttle must be between zero and one");
      if (value.brake !== undefined && typeof value.brake !== "boolean") fail("Brake must be a boolean");
      for (const key of ["useShield", "useMine", "barge"]) if (value[key] !== undefined && value[key] !== true) fail("Item intent must be true");
      return value as unknown as InputCommand;
    case "rematch":
      requireExactKeys(value, ["protocolVersion", "type", "seq", "raceId", ...configurationKeys(value)]);
      requireRaceId(value.raceId);
      return value as unknown as RematchCommand;
    default:
      throw new ProtocolError("Unknown command type");
  }
}

function requireVersionAndSequence(value: Record<string, unknown>): void {
  if (value.protocolVersion !== PROTOCOL_VERSION) fail("Unsupported protocol version");
  if (!Number.isSafeInteger(value.seq) || (value.seq as number) < 0 || (value.seq as number) > MAX_SEQUENCE) {
    fail("Sequence is out of range");
  }
  if (typeof value.type !== "string") fail("Command type must be a string");
}

function carSelectionKeys(value: Record<string, unknown>): string[] {
  if (value.carAssetId === undefined) return [];
  if (!isRacingCarAssetId(value.carAssetId)) fail("Car selection is invalid");
  return ["carAssetId"];
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) {
    fail("Command has missing or extra fields");
  }
}

function requireGuestName(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_GUEST_NAME_LENGTH
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("Guest name is invalid");
  }
}

function requireBotDifficulty(value: unknown): asserts value is BotDifficulty {
  if (value !== "easy" && value !== "normal" && value !== "hard") fail("Bot difficulty is invalid");
}

function requireRoomCode(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length < MIN_ROOM_CODE_LENGTH
    || value.length > MAX_ROOM_CODE_LENGTH
    || !/^[A-Z0-9]+$/u.test(value)
  ) {
    fail("Room code is invalid");
  }
}

function requireReconnectToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length !== RECONNECT_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    fail("Reconnect token is invalid");
  }
}

function requireRaceId(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RACE_ID_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    fail("Race id is invalid");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ProtocolError(message);
}

export function validRaceConfiguration(value: unknown): value is RaceConfiguration {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => ["laps", "rules", "assist", "voltage"].includes(key))
    && Number.isSafeInteger(value.laps) && (value.laps as number) >= 1 && (value.laps as number) <= 99
    && (value.rules === undefined || ["club", "party", "trial"].includes(String(value.rules)))
    && (value.assist === undefined || typeof value.assist === "boolean")
    && (value.voltage === undefined || [3, 6, 9].includes(value.voltage as number));
}
function configurationKeys(value: Record<string, unknown>): string[] {
  if (value.configuration === undefined) return [];
  if (!validRaceConfiguration(value.configuration)) fail("Race configuration is invalid");
  return ["configuration"];
}
