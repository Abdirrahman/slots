import { BOT_LOOKAHEAD_PROGRESS, BOT_REACTION_TICKS } from "./multiplayer-config";
import {
  PROVISIONAL_CONTACT,
  automaticSpeedTarget,
  PROVISIONAL_DURATIONS,
  PROVISIONAL_POWER_UPS,
  PROVISIONAL_SLIPSTREAM,
  TICKS_PER_SECOND,
  type CarInput,
  type CarState,
  type LaneIndex,
  type RaceState,
  type Track,
  type TrackCorner,
} from "./race";

const SOLID_PENALTY = 1_000;
const CAR_PENALTY = 100;
const PICKUP_BONUS = 5;
const DEFEND_BONUS = 6;
/** Sampling step for measuring how much corner a Boost would have to carry. */
const EXPOSURE_STEP = 2;

export interface BotDifficultyProfile {
  readonly reactionTicks: number;
  readonly lookaheadProgress: number;
  /**
   * How much a Bot values the quicker Lane through a corner. Zero drives the racing line by
   * accident only; higher values pick it on purpose.
   */
  readonly lineWeight: number;
  /** How much a Bot wants an uncollected pickup in a Lane. */
  readonly pickupWeight: number;
  /**
   * How much cornering a Bot will accept inside the run of a Boost charge, in progress units.
   *
   * Boost does not lift for a corner, so the cost of spending one is however much corner it
   * has to carry. Measuring that directly beats waiting for clear Track ahead: a three-second
   * Boost covers about 56 units and the Workshop Bench's longest straight is 44, so a Bot
   * that waits for room always ends its Boost deep inside the next corner. Spending on a
   * corner's exit, where the exposure is nearly over, is the safe moment.
   */
  readonly boostCornerExposureProgress: number;
  /** Whether the Bot holds its Lane against a Car closing on it from behind. */
  readonly defendsLane: boolean;
}

/**
 * Difficulty is racecraft, not speed: every Bot drives the same Car profile. An easy Bot
 * reacts late, looks a short way ahead, ignores the racing line and burns Boost as soon as
 * it has one, which is exactly how it loses a corner. A hard Bot reads the line, saves its
 * charge for a stretch with no corner in it, and defends the Lane it is holding.
 */
export const BOT_DIFFICULTY_PROFILES = Object.freeze({
  easy: Object.freeze({
    reactionTicks: 12, lookaheadProgress: 12, lineWeight: 0, pickupWeight: 5,
    boostCornerExposureProgress: Number.POSITIVE_INFINITY, defendsLane: false,
  }),
  normal: Object.freeze({
    reactionTicks: BOT_REACTION_TICKS, lookaheadProgress: BOT_LOOKAHEAD_PROGRESS,
    lineWeight: 8, pickupWeight: 9, boostCornerExposureProgress: 18, defendsLane: false,
  }),
  hard: Object.freeze({
    reactionTicks: 3, lookaheadProgress: 30, lineWeight: 20, pickupWeight: 24,
    boostCornerExposureProgress: 8, defendsLane: true,
  }),
} satisfies Record<"easy" | "normal" | "hard", BotDifficultyProfile>);

export function botInput(
  state: RaceState,
  carId: string,
  profile: BotDifficultyProfile = BOT_DIFFICULTY_PROFILES.normal,
): CarInput {
  const car = state.cars.find((candidate) => candidate.id === carId);
  if (car === undefined || car.result !== "racing" || car.crashRecoveryTicksRemaining > 0) return {};
  const targetSpeed = automaticSpeedTarget(state.track, car, 0, state.configuration.rules !== undefined);
  const drive: CarInput = state.configuration.rules === undefined ? {} : {
    throttle: 1, brake: car.speed > targetSpeed * (profile === BOT_DIFFICULTY_PROFILES.easy ? 1.18 : profile === BOT_DIFFICULTY_PROFILES.hard ? 1.06 : 1.025),
    ...(car.shieldCharges && car.shieldTicksRemaining === 0 && state.hazards.some((hazard) => hazard.lane === car.lane && isAhead(state, car.progress, hazard.progress, 16)) ? { useShield: true } : {}),
    ...(car.mineCharges && isDefending(state, car) ? { useMine: true } : {}),
    ...(car.boostTicksRemaining > 0 && car.bargeCooldown === 0 && state.cars.some((other) => other.id !== car.id && other.lane === car.lane && isAhead(state, car.progress, other.progress, 5)) ? { barge: true } : {}),
  };
  if ((state.tick + stablePhase(carId, profile.reactionTicks)) % profile.reactionTicks !== 0) return drive;

  const useBoost = wantsBoost(state, car, profile);
  // A Bot waits for an active transition to finish before asking for another Lane change,
  // but spending a charge is independent of what its Lane is doing.
  if (car.laneTransition !== null) return { ...drive, ...(useBoost ? { useBoost: true } : {}) };

  const lanes = [car.lane, car.lane - 1, car.lane + 1]
    .filter((lane): lane is LaneIndex => lane >= 0 && lane <= 3)
    .sort((a, b) => scoreLane(state, car, b, profile) - scoreLane(state, car, a, profile) || a - b);
  const target = lanes[0] ?? car.lane;
  return {
    ...drive,
    ...(target === car.lane ? {} : { laneChange: target > car.lane ? 1 : -1 }),
    ...(useBoost ? { useBoost: true } : {}),
  };
}

/**
 * Boost is spent when the Track it will cover is cheap enough to carry it.
 *
 * An easy Bot fires the moment it has a charge. Harder Bots look along the run of the Boost
 * and add up how much of it falls inside a corner, refusing the spend when that is more than
 * they are willing to survive.
 */
function wantsBoost(state: RaceState, car: CarState, profile: BotDifficultyProfile): boolean {
  if (car.boostCharges === 0 || car.boostTicksRemaining > 0 || car.ghost) return false;
  if (!Number.isFinite(profile.boostCornerExposureProgress)) return true;
  return cornerExposure(state.track, car.progress, boostRunProgress(car))
    <= profile.boostCornerExposureProgress;
}

/** Roughly how far a charge carries this Car, used only to judge where to spend it. */
function boostRunProgress(car: CarState): number {
  return car.profile.topSpeedPerSecond
    * PROVISIONAL_POWER_UPS.boostSpeedMultiplier
    * (PROVISIONAL_DURATIONS.boostTicks / TICKS_PER_SECOND);
}

/** How much of the next `distance` of Track lies inside a corner. */
function cornerExposure(track: Track, progress: number, distance: number): number {
  const corners = track.corners ?? [];
  if (corners.length === 0) return 0;
  let exposed = 0;
  for (let step = 0; step < distance; step += EXPOSURE_STEP) {
    const at = (progress + step) % track.length;
    if (activeCorner(track, at) !== null) exposed += Math.min(EXPOSURE_STEP, distance - step);
  }
  return exposed;
}

/** The first corner starting within `distance` ahead of a Car that is not already in one. */
function cornerWithin(track: Track, progress: number, distance: number): TrackCorner | null {
  let nearest: TrackCorner | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const corner of track.corners ?? []) {
    const ahead = forwardDistance(progress, corner.fromProgress, track.length);
    if (ahead <= distance && ahead < nearestDistance) {
      nearest = corner;
      nearestDistance = ahead;
    }
  }
  return nearest;
}

function activeCorner(track: Track, progress: number): TrackCorner | null {
  for (const corner of track.corners ?? []) {
    const span = forwardDistance(corner.fromProgress, corner.toProgress, track.length);
    if (forwardDistance(corner.fromProgress, progress, track.length) < span) return corner;
  }
  return null;
}

function scoreLane(state: RaceState, car: CarState, lane: LaneIndex, profile: BotDifficultyProfile): number {
  let score = 0;
  for (const obstacle of state.track.fixedObstacles ?? []) {
    if (obstacle.lane === lane && isAhead(state, car.progress, obstacle.progress, profile.lookaheadProgress)) score -= SOLID_PENALTY;
  }
  for (const hazard of state.hazards) {
    if (hazard.phase === "active" && hazard.lane === lane && isAhead(state, car.progress, hazard.progress, profile.lookaheadProgress)) {
      score -= SOLID_PENALTY;
    }
  }
  for (const other of [...state.cars].sort((a, b) => compareIds(a.id, b.id))) {
    if (other.id === car.id || other.result !== "racing" || other.ghost || other.crashRecoveryTicksRemaining > 0) continue;
    if (occupiedLanes(other).includes(lane) && isAhead(state, car.progress, other.progress, profile.lookaheadProgress)) {
      // A Car directly ahead in the same Lane is a wall, but its wake is worth something, so
      // a Bot that cannot get past will at least sit in the tow rather than lift early.
      score -= CAR_PENALTY;
      if (lane === car.lane && withinWake(state, car.progress, other.progress)) score += PICKUP_BONUS;
    }
  }
  for (const opportunity of state.powerUpOpportunities) {
    if (opportunity.collected || opportunity.lane !== lane) continue;
    const authored = (state.track.powerUpOpportunities ?? []).find((candidate) => candidate.id === opportunity.id);
    if (authored !== undefined && isAhead(state, car.progress, opportunity.progress ?? authored.progress, profile.lookaheadProgress)) score += profile.pickupWeight;
  }
  score += lineScore(state, car, lane, profile);
  // Defending is worth about what the racing line is worth, never enough to sit in front of
  // an obstacle or to give up a pickup the Bot was already going to take.
  if (profile.defendsLane && lane === car.lane && isDefending(state, car)) score += DEFEND_BONUS;
  return score;
}

/**
 * The racing line, taken before the corner rather than in it.
 *
 * Inside Lanes carry the higher limit, so a Bot that reads the line moves toward the quicker
 * Lane of the corner it is about to meet. Doing that *inside* the corner is a mistake and
 * used to make hard Bots the slowest in the field: a Car mid-change occupies both Lanes and
 * is held to the tighter of the two limits, so it gives away speed for the whole transition.
 * Once committed, the Bot holds its Lane unless something solid is in it.
 */
function lineScore(state: RaceState, car: CarState, lane: LaneIndex, profile: BotDifficultyProfile): number {
  if (profile.lineWeight === 0) return 0;
  const inside = activeCorner(state.track, car.progress);
  if (inside !== null) return lane === car.lane ? profile.lineWeight : 0;

  const approaching = cornerWithin(state.track, car.progress, profile.lookaheadProgress);
  if (approaching === null) return 0;
  const limits = approaching.laneSpeedLimits;
  const slowest = Math.min(...limits);
  const fastest = Math.max(...limits);
  if (fastest <= slowest) return 0;
  return profile.lineWeight * ((limits[lane]! - slowest) / (fastest - slowest));
}

/** True when a non-Ghost Car is closing from behind in this Bot's own Lane. */
function isDefending(state: RaceState, car: CarState): boolean {
  return state.cars.some((other) =>
    other.id !== car.id && other.result === "racing" && !other.ghost && other.crashRecoveryTicksRemaining === 0
    && occupiedLanes(other).includes(car.lane)
    && withinWake(state, other.progress, car.progress));
}

function withinWake(state: RaceState, trailing: number, leading: number): boolean {
  const gap = forwardDistance(trailing, leading, state.track.length);
  return gap > PROVISIONAL_CONTACT.minimumLongitudinalGap && gap <= PROVISIONAL_SLIPSTREAM.rangeProgress;
}

function isAhead(state: RaceState, from: number, to: number, lookaheadProgress: number): boolean {
  const distance = forwardDistance(from, to, state.track.length);
  return distance > 0 && distance <= lookaheadProgress;
}

function forwardDistance(from: number, to: number, length: number): number {
  return ((to - from) % length + length) % length;
}

function occupiedLanes(car: CarState): readonly LaneIndex[] {
  return car.laneTransition === null ? [car.lane] : [car.laneTransition.from, car.laneTransition.to];
}

function stablePhase(id: string, reactionTicks: number): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (Math.imul(hash, 31) + id.charCodeAt(index)) >>> 0;
  return hash % reactionTicks;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
