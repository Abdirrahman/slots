import { TICKS_PER_SECOND } from "./race";

export const SERVER_TICKS_PER_SECOND = TICKS_PER_SECOND;
export const SNAPSHOTS_PER_SECOND = 15;
export const SNAPSHOT_INTERVAL_TICKS = SERVER_TICKS_PER_SECOND / SNAPSHOTS_PER_SECOND;
export const COUNTDOWN_TICKS = SERVER_TICKS_PER_SECOND * 3;

// Provisional Milestone 4 tuning values, centralized for playtesting.
export const INPUT_LEASE_TICKS = SERVER_TICKS_PER_SECOND * 2;
/**
 * How long the Room holds a Lane edge that arrived while its Car was already changing Lane,
 * counted from the tick the edge arrived, as a multiple of that Car's own Lane-change time.
 *
 * A Racer lining up the next Lane change presses a few frames before the current one lands,
 * and dropping that press is what made Lane changing feel unresponsive. One Lane change is
 * exactly the longest a Car can still be busy with the transition that was running when the
 * edge arrived, so this window is the smallest one that never drops a press it could have
 * honoured — and the largest that never surprises a Racer by firing one a whole Lane change
 * after the opening they were aiming at. A Blocked return can outlast it, which is intended:
 * after a bump the Racer picks their line again.
 *
 * It scales with the profile because lane-change speed is a Car profile stat, so a fixed tick
 * count would be too tight for a slow-changing Car and too loose for a fast one.
 */
export const LANE_INPUT_BUFFER_LANE_CHANGES = 1;
/**
 * How long the client will render a Lane change the server has not yet acknowledged.
 *
 * The Room advances `lastProcessedInputSequence` only for inputs it accepts, so a rejected
 * Lane edge is never acknowledged and would otherwise leave the local Car predicted into a
 * Lane it never entered. This bounds that to half a second, which is far longer than a
 * private-room round trip and short enough to self-heal before a Racer reads it as a fault.
 */
export const LANE_PREDICTION_TIMEOUT_MS = 500;
export const POST_FINISH_TIMEOUT_TICKS = SERVER_TICKS_PER_SECOND * 30;
export const MAX_RACE_DURATION_TICKS = SERVER_TICKS_PER_SECOND * 60 * 8;

export const MAX_RACERS = 4;
export const MAX_CONFIGURED_BOTS = MAX_RACERS - 1;
export const MAX_SPECTATORS = 10;
export const MAX_ROOM_CONNECTIONS = MAX_RACERS + MAX_SPECTATORS;
export const EMPTY_ROOM_EXPIRATION_MS = 5 * 60 * 1_000;
export const RECONNECT_RESERVATION_MS = 5 * 60 * 1_000;
export const BOT_REACTION_TICKS = 6;
export const BOT_LOOKAHEAD_PROGRESS = 18;
export const MAX_MESSAGE_BYTES = 16_384;
export const MAX_EVENT_BATCH = 64;
export const MAX_GUEST_NAME_LENGTH = 24;
export const MIN_ROOM_CODE_LENGTH = 4;
export const MAX_ROOM_CODE_LENGTH = 8;
export const MAX_RACE_ID_LENGTH = 64;
export const RECONNECT_TOKEN_LENGTH = 43;
export const MAX_PLAYER_ID_LENGTH = 64;
export const MAX_CONNECTION_GENERATION = 1_000_000_000;
export const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
export const MAX_LAPS = 99;
/**
 * Default Race distance. A Workshop Bench Lap measures 21.0 s at the provisional profile, so
 * eight Laps is about 2 m 50 s: long enough to have a beginning, a middle and an end without
 * asking a Racer to read the same three obstacles seventeen times. See the pace amendment in
 * docs/game-design.md for why the stated 4-6 minute band is a Host setting rather than the
 * default (twelve Laps is 4 m 12 s, seventeen is 5 m 57 s).
 */
export const DEFAULT_RACE_LAPS = 8;

export type BotDifficulty = "easy" | "normal" | "hard";
export interface SoloRaceConfiguration {
  readonly botCount: number;
  readonly botDifficulty: BotDifficulty;
}

if (!Number.isInteger(SNAPSHOT_INTERVAL_TICKS)) {
  throw new Error("Snapshot rate must divide the server tick rate");
}
