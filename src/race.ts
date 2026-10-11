import { cyclePickups } from "./pickups";
export const TICKS_PER_SECOND = 30;
export const TICK_SECONDS = 1 / TICKS_PER_SECOND;

export type LaneIndex = 0 | 1 | 2 | 3;
export type LaneChangeDirection = -1 | 1;
export type CarResult = "racing" | "finished" | "dnf";
export type PowerUpEffect = "shield" | "boost" | "hazard";
export type HazardPhase = "warning" | "active";
export const CRASH_CAUSES = Object.freeze(["fixed_obstacle", "boosted_impact", "hazard", "deslot"] as const);
export type CrashCause = (typeof CRASH_CAUSES)[number];

export interface Lane { readonly index: LaneIndex }
export interface Checkpoint { readonly id: string; readonly progress: number }
export interface FixedObstacle { readonly id: string; readonly progress: number; readonly lane: LaneIndex }
export interface PowerUpOpportunity {
  readonly id: string;
  readonly progress: number;
  readonly allowedEffects: readonly PowerUpEffect[];
  /** Half-width of an authored safe spawn zone. */
  readonly spawnRadius?: number;
}
/**
 * A stretch of Track that punishes carrying too much speed, authored per Lane.
 *
 * This is simulation data, not presentation: the authoritative rules read these numbers and
 * never the path's height or bank (ADR 0006). These original progress-speed limits also
 * encode relative lane length. Club/Party/Trial use their normalized ratios for travel,
 * and reverse their order for physical grip limits: shorter inside lines need more braking.
 */
export interface TrackCorner {
  readonly id: string;
  readonly fromProgress: number;
  readonly toProgress: number;
  readonly laneSpeedLimits: readonly [number, number, number, number];
}
export interface HazardPlacementLocation {
  readonly id: string;
  readonly progress: number;
  readonly allowedLanes: readonly LaneIndex[];
}
export interface Track {
  readonly id: string;
  readonly version?: string;
  readonly length: number;
  readonly lanes: readonly [Lane, Lane, Lane, Lane];
  readonly startFinish: number;
  readonly checkpoints: readonly Checkpoint[];
  readonly fixedObstacles?: readonly FixedObstacle[];
  readonly powerUpOpportunities?: readonly PowerUpOpportunity[];
  readonly hazardPlacementLocations?: readonly HazardPlacementLocation[];
  readonly corners?: readonly TrackCorner[];
}

export interface CarProfile {
  readonly accelerationPerSecondSquared: number;
  readonly topSpeedPerSecond: number;
  /** Braking deceleration shared by human controls, assist and bots. */
  readonly brakingPerSecondSquared: number;
  readonly laneChangeDurationTicks: number;
}
export interface RaceConfiguration {
  readonly laps: number;
  readonly rules?: "club" | "party" | "trial";
  readonly assist?: boolean;
  readonly voltage?: 3 | 6 | 9;
}
export interface LaneTransition {
  readonly from: LaneIndex;
  readonly to: LaneIndex;
  readonly progress: number;
  readonly phase: "changing" | "returning";
}
export interface OrdinaryContact { readonly leadingCarId: string; readonly enteredAtTick: number }
export interface CarState {
  readonly id: string;
  readonly profile: CarProfile;
  readonly progress: number;
  readonly speed: number;
  readonly lane: LaneIndex;
  readonly laneTransition: LaneTransition | null;
  readonly ordinaryContact: OrdinaryContact | null;
  readonly nextCheckpointIndex: number;
  readonly completedLaps: number;
  readonly finishedAtSeconds: number | null;
  readonly result: CarResult;
  readonly crashRecoveryTicksRemaining: number;
  readonly ghost: boolean;
  readonly ghostMinimumTicksRemaining: number;
  readonly shieldTicksRemaining: number;
  readonly boostTicksRemaining: number;
  /** Unspent Boost pickups. Boost is a resource the Racer spends, not an instant effect. */
  readonly boostCharges: number;
  /** How close this Car is to de-slotting; zero unless it is over a corner's Lane limit. */
  readonly deslotPressure: number;
  /** True while a bounded slipstream bonus is being granted by a Car ahead. */
  readonly drafting: boolean;
  readonly respawnProgress: number;
  readonly shieldCharges?: number;
  readonly mineCharges?: number;
  readonly travelled?: number;
  readonly lastPickupTravel?: number;
  readonly lastPickupTick?: number;
  readonly bargeTicks?: number;
  readonly bargeCooldown?: number;
}
export interface PowerUpOpportunityState {
  readonly id: string;
  readonly lane: LaneIndex;
  readonly effect: PowerUpEffect;
  readonly collected: boolean;
  readonly progress?: number;
  readonly phase?: "cooldown" | "warning" | "active";
  readonly ticksRemaining?: number;
}
export interface HazardState {
  readonly id: string;
  readonly locationId: string;
  readonly progress: number;
  readonly lane: LaneIndex;
  readonly phase: HazardPhase;
  readonly ticksRemaining: number;
}
export interface RaceState {
  readonly tick: number;
  readonly status: "racing" | "finished";
  readonly track: Track;
  readonly configuration: RaceConfiguration;
  readonly cars: readonly CarState[];
  readonly seed: number;
  readonly randomState: number;
  readonly powerUpLap: number;
  readonly powerUpOpportunities: readonly PowerUpOpportunityState[];
  readonly hazards: readonly HazardState[];
  readonly nextHazardSequence: number;
}
export interface CarInput {
  readonly laneChange?: LaneChangeDirection;
  /** Spend one Boost charge on this tick. */
  readonly useBoost?: boolean;
  readonly throttle?: number;
  readonly brake?: boolean;
  readonly useShield?: boolean;
  readonly useMine?: boolean;
  readonly barge?: boolean;
}
export type RaceInputs = Readonly<Record<string, CarInput | undefined>>;

type TimedEvent = { readonly tick: number; readonly timeSeconds: number };
export type RaceEvent =
  | (TimedEvent & { readonly type: "checkpoint"; readonly carId: string; readonly checkpointId: string })
  | (TimedEvent & { readonly type: "lap"; readonly carId: string; readonly lap: number })
  | (TimedEvent & { readonly type: "finish"; readonly carId: string })
  | (TimedEvent & { readonly type: "ordinary_collision"; readonly carId: string; readonly leadingCarId: string })
  | (TimedEvent & { readonly type: "blocked_lane_change"; readonly carId: string })
  | (TimedEvent & { readonly type: "crash"; readonly carId: string; readonly cause: CrashCause; readonly sourceId: string })
  | (TimedEvent & { readonly type: "respawn"; readonly carId: string; readonly lane: LaneIndex })
  | (TimedEvent & { readonly type: "ghost_end"; readonly carId: string })
  | (TimedEvent & { readonly type: "power_up_collected"; readonly carId: string; readonly opportunityId: string; readonly effect: PowerUpEffect })
  | (TimedEvent & { readonly type: "shield_consumed"; readonly carId: string; readonly sourceId: string })
  | (TimedEvent & { readonly type: "boosted_impact"; readonly carId: string; readonly targetCarId: string })
  | (TimedEvent & { readonly type: "hazard_placed"; readonly carId: string; readonly hazardId: string; readonly locationId: string; readonly lane: LaneIndex })
  | (TimedEvent & { readonly type: "hazard_activated" | "hazard_removed"; readonly hazardId: string })
  | (TimedEvent & { readonly type: "hazard_consumed"; readonly carId: string; readonly hazardId: string })
  | (TimedEvent & { readonly type: "boost_activated"; readonly carId: string; readonly chargesRemaining: number })
  | (TimedEvent & { readonly type: "deslot_warning"; readonly carId: string; readonly cornerId: string });

export interface RaceCarStart {
  readonly id: string;
  readonly profile: CarProfile;
  readonly lane: LaneIndex;
  readonly progress?: number;
  readonly speed?: number;
}
export interface CreateRaceOptions {
  readonly track: Track;
  readonly configuration: RaceConfiguration;
  readonly cars: readonly RaceCarStart[];
  readonly seed?: number;
}

/**
 * Provisional pace. The previous 30-unit top speed finished a Workshop Bench Lap in about
 * 9.3 seconds, roughly ten Car lengths of bench every second, which read as a fast-forward
 * rather than as racing. Halving it puts a Car at about five lengths per second and leaves
 * room above it for Boost and slipstream without exceeding every corner limit at once.
 */
export const PROVISIONAL_CAR_PROFILE: CarProfile = Object.freeze({
  accelerationPerSecondSquared: 9,
  topSpeedPerSecond: 15,
  brakingPerSecondSquared: 14,
  // Six ticks is the 0.2 s the design document specifies. It had drifted to twelve, which is
  // 0.4 s: long enough that a Lane change read as the Car being steered rather than snapped
  // across, and long enough to swallow the next press. See "Controls and movement".
  laneChangeDurationTicks: 6,
});
export const PROVISIONAL_CONTACT = Object.freeze({
  minimumLongitudinalGap: 2,
  trailingSpeedRetainedOnEntry: 0.7,
});
export const PROVISIONAL_DURATIONS = Object.freeze({
  crashRecoveryTicks: 3 * TICKS_PER_SECOND,
  minimumGhostTicks: 1 * TICKS_PER_SECOND,
  shieldTicks: 10 * TICKS_PER_SECOND,
  boostTicks: 3 * TICKS_PER_SECOND,
  hazardWarningTicks: 1 * TICKS_PER_SECOND,
  hazardActiveTicks: 5 * TICKS_PER_SECOND,
});
export const PROVISIONAL_POWER_UPS = Object.freeze({
  boostSpeedMultiplier: 1.25,
  maximumBoostCharges: 3,
});

/**
 * De-slot tuning. Pressure accumulates in proportion to how far over a corner's Lane limit
 * a Car is, so a small overspeed survives a corner and a large one does not: holding Boost
 * through the tightest turn is about two thirds of a second from a warning to a Crash.
 */
export const PROVISIONAL_CORNERING = Object.freeze({
  brakingLookaheadProgress: 26,
  overspeedTolerance: 0.02,
  deslotThreshold: 0.45,
  deslotWarningFraction: 0.3,
  deslotRecoveryPerTick: 0.02,
});

/** Slipstream: a bounded top-speed bonus for running in the wake of a Car ahead. */
export const PROVISIONAL_SLIPSTREAM = Object.freeze({
  rangeProgress: 9,
  maximumBonus: 0.12,
});

export const SYNTHETIC_CIRCULAR_TRACK: Track = Object.freeze({
  id: "synthetic-circle-v1",
  length: 120,
  lanes: Object.freeze([
    Object.freeze({ index: 0 }), Object.freeze({ index: 1 }),
    Object.freeze({ index: 2 }), Object.freeze({ index: 3 }),
  ] as const),
  startFinish: 0,
  checkpoints: Object.freeze([
    Object.freeze({ id: "quarter", progress: 30 }),
    Object.freeze({ id: "half", progress: 60 }),
    Object.freeze({ id: "three-quarter", progress: 90 }),
  ]),
  fixedObstacles: Object.freeze([]),
  powerUpOpportunities: Object.freeze([]),
  hazardPlacementLocations: Object.freeze([]),
  corners: Object.freeze([]),
});

export const MILESTONE_5_TRACK: Track = Object.freeze({
  ...SYNTHETIC_CIRCULAR_TRACK,
  id: "synthetic-powerups-v1",
  fixedObstacles: Object.freeze([
    Object.freeze({ id: "toolbox", progress: 22, lane: 3 }),
    Object.freeze({ id: "paint-can", progress: 72, lane: 2 }),
  ]),
  powerUpOpportunities: Object.freeze([
    Object.freeze({ id: "power-a", progress: 15, allowedEffects: Object.freeze(["boost", "shield"] as const) }),
    Object.freeze({ id: "power-b", progress: 55, allowedEffects: Object.freeze(["boost", "shield", "hazard"] as const) }),
    Object.freeze({ id: "power-c", progress: 95, allowedEffects: Object.freeze(["hazard", "shield"] as const) }),
  ]),
  hazardPlacementLocations: Object.freeze([
    Object.freeze({ id: "hazard-a", progress: 5, allowedLanes: Object.freeze([0, 1, 2, 3] as const) }),
    Object.freeze({ id: "hazard-b", progress: 45, allowedLanes: Object.freeze([0, 1, 2, 3] as const) }),
    Object.freeze({ id: "hazard-c", progress: 85, allowedLanes: Object.freeze([0, 1, 2, 3] as const) }),
  ]),
});

export function createRace(options: CreateRaceOptions): RaceState {
  validateTrack(options.track);
  const track: Track = {
    ...options.track,
    fixedObstacles: [...(options.track.fixedObstacles ?? [])].sort(compareIdsById),
    powerUpOpportunities: [...(options.track.powerUpOpportunities ?? [])].sort(compareIdsById),
    hazardPlacementLocations: [...(options.track.hazardPlacementLocations ?? [])]
      .sort(compareIdsById)
      .map((location) => ({ ...location, allowedLanes: [...location.allowedLanes].sort((a, b) => a - b) })),
    corners: [...(options.track.corners ?? [])].sort(compareIdsById),
  };
  assertPositiveInteger(options.configuration.laps, "Race laps");
  if (options.cars.length === 0) throw new Error("A Race requires at least one Car");
  if (PROVISIONAL_CONTACT.minimumLongitudinalGap * options.cars.length >= track.length) {
    throw new Error("Track is too short for the provisional Car separation");
  }
  const seed = options.seed ?? 0;
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new Error("Race seed must be an unsigned 32-bit integer");
  }
  let randomState = seed >>> 0;
  const rolled = rollOpportunities(track, randomState);
  randomState = rolled.randomState;

  const ids = new Set<string>();
  const cars = options.cars.map((car): CarState => {
    if (!car.id || ids.has(car.id)) throw new Error(`Car id must be non-empty and unique: ${car.id}`);
    ids.add(car.id);
    validateProfile(car.profile);
    validateLane(car.lane);
    const speed = car.speed ?? 0;
    assertNonNegativeFinite(speed, "Car speed");
    return {
      id: car.id,
      profile: car.profile,
      progress: modulo(car.progress ?? track.startFinish, track.length),
      speed: Math.min(speed, car.profile.topSpeedPerSecond),
      lane: car.lane,
      laneTransition: null,
      ordinaryContact: null,
      nextCheckpointIndex: 0,
      completedLaps: 0,
      finishedAtSeconds: null,
      result: "racing",
      crashRecoveryTicksRemaining: 0,
      ghost: false,
      ghostMinimumTicksRemaining: 0,
      shieldTicksRemaining: 0,
      boostTicksRemaining: 0,
      boostCharges: 0,
      deslotPressure: 0,
      drafting: false,
      respawnProgress: track.startFinish,
      ...(options.configuration.rules === undefined ? {} : {
        shieldCharges: 0, mineCharges: 0, travelled: 0, lastPickupTravel: -track.length,
        lastPickupTick: -300, bargeTicks: 0, bargeCooldown: 0,
      }),
    };
  }).sort(compareCarIds);

  return {
    tick: 0, status: "racing", track, configuration: options.configuration, cars,
    seed, randomState, powerUpLap: 0, powerUpOpportunities: options.configuration.rules === "trial" ? []
      : options.configuration.rules === undefined ? rolled.opportunities
      : rolled.opportunities.map((opportunity, index) => ({ ...opportunity, collected: true,
        progress: track.powerUpOpportunities![index]!.progress, phase: "cooldown" as const, ticksRemaining: 30 + index * 30 })),
    hazards: [], nextHazardSequence: 0,
  };
}

interface CarProposal {
  readonly car: CarState;
  speed: number;
  distance: number;
  lane: LaneIndex;
  transition: LaneTransition | null;
  contact: OrdinaryContact | null;
  crashRecoveryTicksRemaining: number;
  ghost: boolean;
  ghostMinimumTicksRemaining: number;
  shieldTicksRemaining: number;
  boostTicksRemaining: number;
  boostCharges: number;
  deslotPressure: number;
  drafting: boolean;
  shieldCharges: number;
  mineCharges: number;
  lastPickupTravel: number;
  lastPickupTick: number;
  bargeTicks: number;
  bargeCooldown: number;
  activatedBoost: boolean;
  crashedThisTick: boolean;
}

type InteractionKind = "pickup" | "boosted_impact" | "fixed_obstacle" | "hazard";
interface InteractionCandidate {
  readonly fraction: number;
  readonly affectedCarId: string;
  readonly kind: InteractionKind;
  readonly sourceId: string;
  readonly carId: string;
  readonly distance: number;
  readonly targetCarId?: string;
}

export function advanceRace(state: RaceState, inputs: RaceInputs): { readonly state: RaceState; readonly events: readonly RaceEvent[] } {
  if (state.status === "finished") return { state, events: [] };
  const events: RaceEvent[] = [];
  let hazards = advanceHazards(state, events);
  const slipstream = slipstreamBonuses(state);
  const proposals = state.cars.map((car) => proposeCar(state, car, inputs[car.id], slipstream.get(car.id) ?? 0));
  emitBoostActivations(state, proposals, events);
  respawnCars(state, proposals, hazards, events);
  resolveDeslots(state, proposals, events);
  const laneResolved = resolveLaneClaims(state, proposals, events);
  resolveTransitionSeparation(state.track.length, laneResolved);

  // A held mine is spent only if a safe, nearby, trailing placement exists.
  let itemRandom = state.randomState;
  let itemSequence = state.nextHazardSequence;
  for (const motion of laneResolved) {
    if (!isInteractive(motion) || isGhost(motion) || !inputs[motion.car.id]?.useMine || motion.mineCharges === 0) continue;
    const placed = placeHazard(state, motion.car.progress, 0, laneResolved, hazards, itemRandom, itemSequence);
    itemRandom = placed.randomState;
    if (placed.hazard === null) continue;
    motion.mineCharges -= 1;
    hazards.push(placed.hazard);
    itemSequence += 1;
    events.push({ type: "hazard_placed", carId: motion.car.id, hazardId: placed.hazard.id,
      locationId: placed.hazard.locationId, lane: placed.hazard.lane, tick: state.tick, timeSeconds: state.tick * TICK_SECONDS });
  }
  const interactionResult = resolveInteractions({ ...state, randomState: itemRandom, nextHazardSequence: itemSequence }, laneResolved, hazards, events);
  hazards = interactionResult.hazards;
  resolveLongitudinalContact(state, laneResolved, events);
  let cars = laneResolved.map((motion) => commitCar(state, motion, events)).sort(compareCarIds);
  endEligibleGhosts(state, cars, hazards, events);

  let randomState = interactionResult.randomState;
  let powerUpLap = state.powerUpLap;
  let powerUpOpportunities = interactionResult.opportunities;
  const reachedLap = cars.reduce((maximum, car) => Math.max(maximum, car.completedLaps), powerUpLap);
  while (state.configuration.rules === undefined && powerUpLap < reachedLap) {
    const rolled = rollOpportunities(state.track, randomState);
    randomState = rolled.randomState;
    powerUpOpportunities = rolled.opportunities;
    powerUpLap += 1;
  }
  if (state.configuration.rules !== undefined && state.configuration.rules !== "trial") {
    const cycled = cyclePickups({ ...state, cars, hazards, powerUpOpportunities, randomState });
    powerUpOpportunities = cycled.opportunities;
    randomState = cycled.randomState;
  }
  const status = cars.every((car) => car.result !== "racing") ? "finished" : "racing";
  events.sort(compareEvents);
  return {
    state: {
      ...state, tick: state.tick + 1, status, cars, hazards: [...hazards].sort(compareIdsById),
      randomState, powerUpLap, powerUpOpportunities,
      nextHazardSequence: interactionResult.nextHazardSequence,
    },
    events,
  };
}

export function finishRaceWithDnfs(state: RaceState): RaceState {
  if (state.status === "finished") return state;
  return {
    ...state,
    status: "finished",
    cars: state.cars.map((car) => car.result === "racing"
      ? { ...car, speed: 0, laneTransition: null, ordinaryContact: null, drafting: false, result: "dnf" as const }
      : car),
  };
}

function proposeCar(race: RaceState, car: CarState, input: CarInput | undefined, slipstream: number): CarProposal {
  let shieldTicksRemaining = Math.max(0, car.shieldTicksRemaining - 1);
  let shieldCharges = car.shieldCharges ?? 0;
  const mineCharges = car.mineCharges ?? 0;
  const bargeCooldown = Math.max(0, (car.bargeCooldown ?? 0) - 1);
  let bargeTicks = Math.max(0, (car.bargeTicks ?? 0) - 1);
  let boostTicksRemaining = Math.max(0, car.boostTicksRemaining - 1);
  let boostCharges = car.boostCharges;
  const idle = car.result !== "racing" || car.crashRecoveryTicksRemaining > 0;
  // Boost is spent, not triggered by collection, and it cannot be stacked on itself: the
  // decision is which straight or corner to spend the charge on.
  const activatedBoost = !idle && !car.ghost && input?.useBoost === true
    && boostCharges > 0 && boostTicksRemaining === 0;
  if (activatedBoost) {
    boostCharges -= 1;
    boostTicksRemaining = PROVISIONAL_DURATIONS.boostTicks;
  }
  if (!idle && !car.ghost && input?.useShield && shieldCharges > 0 && shieldTicksRemaining === 0) {
    shieldCharges -= 1;
    shieldTicksRemaining = PROVISIONAL_DURATIONS.shieldTicks;
  }
  const activatedBarge = !idle && !car.ghost && input?.barge === true && boostTicksRemaining > 0 && bargeCooldown === 0;
  if (activatedBarge) bargeTicks = 12;
  const inventory = { shieldCharges, mineCharges, lastPickupTravel: car.lastPickupTravel ?? -race.track.length,
    lastPickupTick: car.lastPickupTick ?? -300, bargeTicks, bargeCooldown: activatedBarge ? 90 : bargeCooldown };
  if (idle) {
    return {
      ...inventory, car, speed: 0, distance: 0, lane: car.lane, transition: null, contact: null,
      crashRecoveryTicksRemaining: Math.max(0, car.crashRecoveryTicksRemaining - 1),
      ghost: car.ghost,
      ghostMinimumTicksRemaining: car.ghostMinimumTicksRemaining,
      shieldTicksRemaining, boostTicksRemaining, boostCharges,
      deslotPressure: Math.max(0, car.deslotPressure - PROVISIONAL_CORNERING.deslotRecoveryPerTick),
      drafting: false, activatedBoost, crashedThisTick: false,
    };
  }
  const boosting = boostTicksRemaining > 0;
  const unrestricted = car.profile.topSpeedPerSecond
    * (boosting ? PROVISIONAL_POWER_UPS.boostSpeedMultiplier : 1)
    * (1 + slipstream);
  // The automatic throttle lifts for a corner it is about to enter. Boost deliberately does
  // not lift, which is what turns a Boost charge into a decision instead of free speed.
  const assisted = race.configuration.rules === undefined || race.configuration.assist === true;
  const throttle = assisted ? 1 : clamp(input?.throttle ?? 0, 0, 1);
  const target = input?.brake ? 0 : assisted && !boosting
    ? Math.min(unrestricted, corneringTarget(race.track, car, race.configuration.rules !== undefined))
    : unrestricted * throttle;

  const speed = car.speed < target
    ? Math.min(target, car.speed + car.profile.accelerationPerSecondSquared * TICK_SECONDS)
    : Math.max(target, car.speed - (input?.brake || assisted ? car.profile.brakingPerSecondSquared : 3) * TICK_SECONDS);
  let transition = car.laneTransition;
  if (transition?.phase === "returning") {
    const progress = Math.max(0, transition.progress - 1 / car.profile.laneChangeDurationTicks);
    transition = progress === 0 ? null : { ...transition, progress };
  } else {
    if (transition === null && (input?.laneChange === -1 || input?.laneChange === 1)) {
      const target = car.lane + input.laneChange;
      if (target >= 0 && target <= 3) transition = { from: car.lane, to: target as LaneIndex, progress: 0, phase: "changing" };
    }
    if (transition?.phase === "changing") {
      transition = { ...transition, progress: Math.min(1, transition.progress + 1 / car.profile.laneChangeDurationTicks) };
    }
  }
  return {
    ...inventory, car, speed, distance: speed * TICK_SECONDS * lanePaceFactor(race, car), lane: car.lane, transition, contact: null,
    crashRecoveryTicksRemaining: 0,
    ghost: car.ghost,
    ghostMinimumTicksRemaining: car.ghostMinimumTicksRemaining,
    shieldTicksRemaining, boostTicksRemaining, boostCharges,
    deslotPressure: nextDeslotPressure(race.track, car, speed, race.configuration.rules !== undefined),
    drafting: slipstream > 0, activatedBoost, crashedThisTick: false,
  };
}

/**
 * The speed the automatic throttle is aiming at, given the corners the Car is in or about
 * to enter. A corner still ahead contributes the speed the Car can arrive at it from, so
 * the lift starts at the braking point rather than at the corner's mouth.
 */
export function automaticSpeedTarget(track: Track, car: CarState, slipstreamBonus = car.drafting ? PROVISIONAL_SLIPSTREAM.maximumBonus : 0, manualRules = false): number {
  const unrestricted = car.profile.topSpeedPerSecond
    * (car.boostTicksRemaining > 0 ? PROVISIONAL_POWER_UPS.boostSpeedMultiplier : 1)
    * (1 + slipstreamBonus);
  return car.boostTicksRemaining > 0 ? unrestricted : Math.min(unrestricted, corneringTarget(track, car, manualRules));
}

function corneringTarget(track: Track, car: CarState, manualRules = false): number {
  let target = Infinity;
  for (const corner of track.corners ?? []) {
    const limit = cornerLaneLimit(corner, occupiedLanes(car), manualRules);
    const into = forwardDistance(corner.fromProgress, car.progress, track.length);
    if (into < cornerSpan(corner, track.length)) {
      target = Math.min(target, limit);
      continue;
    }
    const ahead = forwardDistance(car.progress, corner.fromProgress, track.length);
    if (ahead > PROVISIONAL_CORNERING.brakingLookaheadProgress) continue;
    target = Math.min(target, Math.sqrt(limit * limit + 2 * car.profile.brakingPerSecondSquared * ahead));
  }
  return target;
}

/** The corner a Car is inside, or null. Lower stable id wins if corners overlap. */
function activeCorner(track: Track, car: Pick<CarState, "progress">): TrackCorner | null {
  for (const corner of track.corners ?? []) {
    if (forwardDistance(corner.fromProgress, car.progress, track.length) < cornerSpan(corner, track.length)) return corner;
  }
  return null;
}

function cornerSpan(corner: TrackCorner, length: number): number {
  return forwardDistance(corner.fromProgress, corner.toProgress, length);
}

/** A Car straddling two Lanes is held to the tighter of the two limits. */
function cornerLaneLimit(corner: TrackCorner, lanes: readonly LaneIndex[], manualRules = false): number {
  const sum = Math.max(...corner.laneSpeedLimits) + Math.min(...corner.laneSpeedLimits);
  return Math.min(...lanes.map((lane) => manualRules ? sum - corner.laneSpeedLimits[lane]! : corner.laneSpeedLimits[lane]!));
}

function nextDeslotPressure(track: Track, car: CarState, speed: number, manualRules = false): number {
  const corner = activeCorner(track, car);
  if (corner === null) return Math.max(0, car.deslotPressure - PROVISIONAL_CORNERING.deslotRecoveryPerTick);
  const limit = cornerLaneLimit(corner, occupiedLanes(car), manualRules);
  if (speed <= limit * (1 + PROVISIONAL_CORNERING.overspeedTolerance)) {
    return Math.max(0, car.deslotPressure - PROVISIONAL_CORNERING.deslotRecoveryPerTick);
  }
  return car.deslotPressure + (speed / limit - 1) * TICK_SECONDS;
}

/**
 * Crashes every Car whose de-slot pressure has run out, and warns the ones that have just
 * started to build it. The warning is a rising edge so a Racer hears it once, in time to
 * change Lane or let the corner come back to them.
 */
function resolveDeslots(race: RaceState, motions: readonly CarProposal[], events: RaceEvent[]): void {
  const warning = PROVISIONAL_CORNERING.deslotThreshold * PROVISIONAL_CORNERING.deslotWarningFraction;
  for (const motion of [...motions].sort((a, b) => compareCarIds(a.car, b.car))) {
    if (!isInteractive(motion) || isGhost(motion)) continue;
    const corner = activeCorner(race.track, motion.car);
    if (corner === null) continue;
    if (motion.deslotPressure >= PROVISIONAL_CORNERING.deslotThreshold) {
      motion.deslotPressure = 0;
      crashCar(motion, 0, "deslot", corner.id, race, 0, events);
      continue;
    }
    if (motion.deslotPressure >= warning && motion.car.deslotPressure < warning) {
      events.push({ type: "deslot_warning", carId: motion.car.id, cornerId: corner.id, tick: race.tick, timeSeconds: race.tick * TICK_SECONDS });
    }
  }
}

function emitBoostActivations(race: RaceState, motions: readonly CarProposal[], events: RaceEvent[]): void {
  for (const motion of [...motions].sort((a, b) => compareCarIds(a.car, b.car))) {
    if (!motion.activatedBoost) continue;
    events.push({ type: "boost_activated", carId: motion.car.id, chargesRemaining: motion.boostCharges, tick: race.tick, timeSeconds: race.tick * TICK_SECONDS });
  }
}

/**
 * Slipstream, resolved from the pre-tick state so every Car in the batch sees the same
 * positions and no bonus depends on Car storage order. The bonus fades to nothing at the
 * edge of the wake and is capped, so a draft closes a gap without overtaking on its own.
 */
function slipstreamBonuses(race: RaceState): Map<string, number> {
  const bonuses = new Map<string, number>();
  const minimum = PROVISIONAL_CONTACT.minimumLongitudinalGap;
  const range = PROVISIONAL_SLIPSTREAM.rangeProgress;
  for (const car of race.cars) {
    if (!isDrafter(car)) continue;
    const lanes = occupiedLanes(car);
    let best = 0;
    for (const other of race.cars) {
      if (other.id === car.id || !isDrafter(other)) continue;
      if (!occupiedLanes(other).some((lane) => lanes.includes(lane))) continue;
      const gap = forwardDistance(car.progress, other.progress, race.track.length);
      if (gap <= minimum || gap > range) continue;
      best = Math.max(best, (1 - (gap - minimum) / (range - minimum)) * PROVISIONAL_SLIPSTREAM.maximumBonus);
    }
    if (best > 0) bonuses.set(car.id, best);
  }
  return bonuses;
}

function isDrafter(car: CarState): boolean {
  return car.result === "racing" && car.crashRecoveryTicksRemaining === 0 && !car.ghost;
}

function respawnCars(race: RaceState, motions: CarProposal[], hazards: readonly HazardState[], events: RaceEvent[]): void {
  for (const motion of motions) {
    if (motion.car.crashRecoveryTicksRemaining === 0 || motion.crashRecoveryTicksRemaining > 0) continue;
    const lane = safestLane(race, motion.car, motions, hazards);
    motion.lane = lane;
    motion.speed = motion.car.profile.topSpeedPerSecond;
    motion.distance = 0;
    motion.transition = null;
    motion.contact = null;
    motion.ghost = true;
    motion.ghostMinimumTicksRemaining = PROVISIONAL_DURATIONS.minimumGhostTicks;
    events.push({ type: "respawn", carId: motion.car.id, lane, tick: race.tick, timeSeconds: race.tick * TICK_SECONDS });
  }
}

function safestLane(race: RaceState, respawning: CarState, motions: readonly CarProposal[], hazards: readonly HazardState[]): LaneIndex {
  let best: LaneIndex = 0;
  let bestClearance = -1;
  for (const lane of race.track.lanes) {
    const clearances: number[] = [];
    for (const other of motions) {
      if (other.car.id !== respawning.id && other.car.crashRecoveryTicksRemaining === 0 && occupiedLanes(other).includes(lane.index)) {
        clearances.push(cyclicClearance(respawning.respawnProgress, other.car.progress, race.track.length));
      }
    }
    for (const obstacle of race.track.fixedObstacles ?? []) {
      if (obstacle.lane === lane.index) clearances.push(cyclicClearance(respawning.respawnProgress, obstacle.progress, race.track.length));
    }
    for (const hazard of hazards) {
      if (hazard.phase === "active" && hazard.lane === lane.index) clearances.push(cyclicClearance(respawning.respawnProgress, hazard.progress, race.track.length));
    }
    const clearance = clearances.length === 0 ? Infinity : Math.min(...clearances);
    if (clearance > bestClearance) { best = lane.index; bestClearance = clearance; }
  }
  return best;
}

function resolveLaneClaims(race: RaceState, proposals: readonly CarProposal[], events: RaceEvent[]): CarProposal[] {
  const blocked = new Set<string>();
  const claims = proposals.filter((proposal) => proposal.transition?.phase === "changing" && isInteractive(proposal));
  for (const claim of claims) {
    const transition = claim.transition!;
    for (const other of proposals) {
      if (other.car.id === claim.car.id || !isInteractive(other)) continue;
      const otherTransition = other.transition;
      const exchange = otherTransition?.phase === "changing" && transition.from === otherTransition.to && transition.to === otherTransition.from;
      const occupiesDestination = occupiedLanes(other).includes(transition.to);
      if (!exchange && (!occupiesDestination || !sweptPathsConflict(race.track.length, claim, other))) continue;
      blocked.add(claim.car.id);
      if (otherTransition?.phase === "changing") blocked.add(other.car.id);
    }
  }
  return proposals.map((proposal) => {
    if (proposal.transition?.phase === "changing" && blocked.has(proposal.car.id)) {
      proposal.transition = { ...proposal.transition, phase: "returning" };
      events.push({ type: "blocked_lane_change", carId: proposal.car.id, tick: race.tick, timeSeconds: race.tick * TICK_SECONDS });
    } else if (proposal.transition?.phase === "changing" && proposal.transition.progress >= 1) {
      proposal.lane = proposal.transition.to;
      proposal.transition = null;
    }
    return proposal;
  });
}

function resolveTransitionSeparation(trackLength: number, motions: CarProposal[]): void {
  const ordered = [...motions].sort((a, b) => compareCarIds(a.car, b.car));
  for (let pass = 0; pass < ordered.length; pass += 1) {
    for (let first = 0; first < ordered.length; first += 1) for (let second = first + 1; second < ordered.length; second += 1) {
      const a = ordered[first]!; const b = ordered[second]!;
      if (!isInteractive(a) || !isInteractive(b)) continue;
      if (a.transition?.phase !== "returning" && b.transition?.phase !== "returning") continue;
      if (!occupiedLanes(a).some((lane) => occupiedLanes(b).includes(lane))) continue;
      const gapAtoB = forwardDistance(a.car.progress, b.car.progress, trackLength);
      const gapBtoA = forwardDistance(b.car.progress, a.car.progress, trackLength);
      const aCatch = catchFraction(a, b, gapAtoB); const bCatch = catchFraction(b, a, gapBtoA);
      if (aCatch === null && bCatch === null) continue;
      const aTrails = bCatch === null || (aCatch !== null && (aCatch < bCatch || (aCatch === bCatch && compareCarIds(b.car, a.car) < 0)));
      const trailing = aTrails ? a : b; const leading = aTrails ? b : a; const gap = aTrails ? gapAtoB : gapBtoA;
      trailing.distance = Math.min(trailing.distance, gap + leading.distance - PROVISIONAL_CONTACT.minimumLongitudinalGap);
    }
  }
}

function resolveInteractions(
  race: RaceState,
  motions: CarProposal[],
  initialHazards: readonly HazardState[],
  events: RaceEvent[],
): { opportunities: PowerUpOpportunityState[]; hazards: HazardState[]; randomState: number; nextHazardSequence: number } {
  const opportunities = race.powerUpOpportunities.map((value) => ({ ...value }));
  const hazards = initialHazards.map((value) => ({ ...value }));
  let randomState = race.randomState;
  let nextHazardSequence = race.nextHazardSequence;
  const candidates: InteractionCandidate[] = [];
  const opportunityById = new Map((race.track.powerUpOpportunities ?? []).map((value) => [value.id, value]));

  for (const motion of motions) {
    if (!isInteractive(motion) || isGhost(motion)) continue;
    for (const opportunity of opportunities) {
      if (opportunity.collected || (opportunity.phase !== undefined && opportunity.phase !== "active")
        || !occupiedLanes(motion).includes(opportunity.lane)) continue;
      const authored = opportunityById.get(opportunity.id)!;
      addSweptCandidate(candidates, motion, opportunity.progress ?? authored.progress, "pickup", opportunity.id, motion.car.id, race.track.length);
    }
    for (const obstacle of race.track.fixedObstacles ?? []) {
      if (occupiedLanes(motion).includes(obstacle.lane)) addSweptCandidate(candidates, motion, obstacle.progress, "fixed_obstacle", obstacle.id, motion.car.id, race.track.length);
    }
    for (const hazard of hazards) {
      if (hazard.phase === "active" && occupiedLanes(motion).includes(hazard.lane)) {
        addSweptCandidate(candidates, motion, hazard.progress, "hazard", hazard.id, motion.car.id, race.track.length);
      }
    }
  }
  for (const attacker of motions) for (const target of motions) {
    if (attacker.car.id === target.car.id || !isInteractive(attacker) || !isInteractive(target) || isGhost(attacker) || isGhost(target)) continue;
    if (attacker.transition !== null || target.transition !== null || attacker.lane !== target.lane) continue;
    const gap = forwardDistance(attacker.car.progress, target.car.progress, race.track.length);
    const fraction = catchFraction(attacker, target, gap);
    if (fraction === null) continue;
    candidates.push({
      fraction, affectedCarId: target.car.id, kind: "boosted_impact", sourceId: attacker.car.id,
      carId: attacker.car.id, targetCarId: target.car.id, distance: target.distance * fraction,
    });
  }
  candidates.sort(compareCandidates);

  for (const candidate of candidates) {
    const motion = findMotion(motions, candidate.carId);
    const target = candidate.targetCarId === undefined ? motion : findMotion(motions, candidate.targetCarId);
    if (!isInteractive(motion) || !isInteractive(target)) continue;
    const timeSeconds = (race.tick + candidate.fraction) * TICK_SECONDS;
    if (candidate.kind === "pickup") {
      if (isGhost(motion)) continue;
      const opportunity = opportunities.find((value) => value.id === candidate.sourceId)!;
      if (opportunity.collected) continue;
      const dynamic = race.configuration.rules !== undefined;
      if (dynamic && ((motion.car.travelled ?? 0) - motion.lastPickupTravel < race.track.length * 0.18
        || race.tick - motion.lastPickupTick < 120
        || motion.boostCharges + motion.shieldCharges + motion.mineCharges >= 3)) continue;
      if (dynamic && ((opportunity.effect === "boost" && motion.boostCharges >= 2)
        || (opportunity.effect === "shield" && motion.shieldCharges >= 1)
        || (opportunity.effect === "hazard" && motion.mineCharges >= 1))) continue;
      opportunity.collected = true;
      if (dynamic) {
        opportunity.phase = "cooldown";
        const next = nextRandom(randomState); randomState = next.state;
        opportunity.ticksRemaining = 180 + ((next.value >>> 8) % 121);
        motion.lastPickupTravel = motion.car.travelled ?? 0;
        motion.lastPickupTick = race.tick;
        // Party's recovery aid changes only a collected item's type, never car performance.
        const leader = Math.max(...race.cars.map((car) => car.completedLaps * race.track.length + car.progress));
        const deficit = leader - (motion.car.completedLaps * race.track.length + motion.car.progress);
        if (race.configuration.rules === "party" && deficit > race.track.length * 0.15 && opportunity.effect === "hazard") {
          const alternative = motion.boostCharges < 2 ? "boost" : "shield";
          if (opportunityById.get(opportunity.id)!.allowedEffects.includes(alternative)) opportunity.effect = alternative;
        }
        if (opportunity.effect === "shield") motion.shieldCharges = Math.min(1, motion.shieldCharges + 1);
        if (opportunity.effect === "hazard") motion.mineCharges = Math.min(1, motion.mineCharges + 1);
      } else if (opportunity.effect === "shield") motion.shieldTicksRemaining = PROVISIONAL_DURATIONS.shieldTicks;
      if (opportunity.effect === "boost") motion.boostCharges = Math.min(dynamic ? 2 : PROVISIONAL_POWER_UPS.maximumBoostCharges, motion.boostCharges + 1);
      events.push({ type: "power_up_collected", carId: motion.car.id, opportunityId: opportunity.id, effect: opportunity.effect, tick: race.tick, timeSeconds });
      if (!dynamic && opportunity.effect === "hazard") {
        const placement = placeHazard(race, authoredProgress(race.track, opportunity.id), candidate.fraction, motions, hazards, randomState, nextHazardSequence);
        randomState = placement.randomState;
        if (placement.hazard !== null) {
          hazards.push(placement.hazard);
          nextHazardSequence += 1;
          events.push({ type: "hazard_placed", carId: motion.car.id, hazardId: placement.hazard.id, locationId: placement.hazard.locationId, lane: placement.hazard.lane, tick: race.tick, timeSeconds });
        }
      }
      continue;
    }
    if (candidate.kind === "boosted_impact") {
      if (motion.boostTicksRemaining === 0 || (race.configuration.rules !== undefined && (motion.bargeTicks === 0 || motion.bargeTicks > 6)) || isGhost(motion) || isGhost(target)) continue;
      events.push({ type: "boosted_impact", carId: motion.car.id, targetCarId: target.car.id, tick: race.tick, timeSeconds });
      if (consumeShield(target, candidate.sourceId, race, candidate.fraction, events)) {
        motion.speed *= PROVISIONAL_CONTACT.trailingSpeedRetainedOnEntry;
        const gap = forwardDistance(motion.car.progress, target.car.progress, race.track.length);
        motion.distance = Math.min(motion.distance, gap + target.distance - PROVISIONAL_CONTACT.minimumLongitudinalGap);
        motion.contact = { leadingCarId: target.car.id, enteredAtTick: race.tick };
      } else crashCar(target, candidate.distance, "boosted_impact", candidate.sourceId, race, candidate.fraction, events);
      continue;
    }
    if (candidate.kind === "fixed_obstacle") {
      if (isGhost(motion)) continue;
      if (!consumeShield(motion, candidate.sourceId, race, candidate.fraction, events)) {
        crashCar(motion, candidate.distance, "fixed_obstacle", candidate.sourceId, race, candidate.fraction, events);
      }
      continue;
    }
    const hazardIndex = hazards.findIndex((value) => value.id === candidate.sourceId && value.phase === "active");
    if (hazardIndex < 0 || isGhost(motion)) continue;
    if (!consumeShield(motion, candidate.sourceId, race, candidate.fraction, events)) {
      crashCar(motion, candidate.distance, "hazard", candidate.sourceId, race, candidate.fraction, events);
    }
    hazards.splice(hazardIndex, 1);
    events.push({ type: "hazard_consumed", carId: motion.car.id, hazardId: candidate.sourceId, tick: race.tick, timeSeconds });
  }
  return { opportunities, hazards, randomState, nextHazardSequence };
}

function addSweptCandidate(candidates: InteractionCandidate[], motion: CarProposal, progress: number, kind: InteractionKind, sourceId: string, affectedCarId: string, length: number): void {
  const distance = forwardDistance(motion.car.progress, progress, length);
  if (distance === 0 || distance > motion.distance) return;
  candidates.push({ fraction: distance / motion.distance, affectedCarId, kind, sourceId, carId: motion.car.id, distance });
}

function compareCandidates(a: InteractionCandidate, b: InteractionCandidate): number {
  return a.fraction - b.fraction
    || compareIds(a.affectedCarId, b.affectedCarId)
    || interactionOrder(a.kind) - interactionOrder(b.kind)
    || compareIds(a.sourceId, b.sourceId);
}
function interactionOrder(kind: InteractionKind): number {
  return kind === "pickup" ? 0 : kind === "boosted_impact" ? 1 : kind === "fixed_obstacle" ? 2 : 3;
}

function consumeShield(motion: CarProposal, sourceId: string, race: RaceState, fraction: number, events: RaceEvent[]): boolean {
  if (motion.shieldTicksRemaining === 0) return false;
  motion.shieldTicksRemaining = 0;
  events.push({ type: "shield_consumed", carId: motion.car.id, sourceId, tick: race.tick, timeSeconds: (race.tick + fraction) * TICK_SECONDS });
  return true;
}
function crashCar(motion: CarProposal, distance: number, cause: CrashCause, sourceId: string, race: RaceState, fraction: number, events: RaceEvent[]): void {
  if (!isInteractive(motion)) return;
  motion.distance = Math.min(motion.distance, distance);
  motion.speed = 0;
  motion.transition = null;
  motion.contact = null;
  motion.crashRecoveryTicksRemaining = race.configuration.rules === undefined ? PROVISIONAL_DURATIONS.crashRecoveryTicks : 36;
  motion.deslotPressure = 0;
  motion.drafting = false;
  motion.ghost = false;
  motion.ghostMinimumTicksRemaining = 0;
  motion.crashedThisTick = true;
  events.push({ type: "crash", carId: motion.car.id, cause, sourceId, tick: race.tick, timeSeconds: (race.tick + fraction) * TICK_SECONDS });
}

function placeHazard(race: RaceState, collectorProgress: number, placementFraction: number, motions: readonly CarProposal[], hazards: readonly HazardState[], randomState: number, sequence: number): { hazard: HazardState | null; randomState: number } {
  const valid: { location: HazardPlacementLocation; lane: LaneIndex }[] = [];
  for (const location of [...(race.track.hazardPlacementLocations ?? [])].sort(compareIdsById)) {
    const behind = forwardDistance(location.progress, collectorProgress, race.track.length);
    if (behind === 0 || behind > (race.configuration.rules === undefined ? race.track.length / 2 : 35)) continue;
    for (const lane of [...location.allowedLanes].sort((a, b) => a - b)) {
      const occupiedByCar = motions.some((motion) => isInteractive(motion) && !isGhost(motion) && occupiedLanes(motion).includes(lane)
        && cyclicClearance(
          location.progress,
          modulo(motion.car.progress + motion.distance * placementFraction, race.track.length),
          race.track.length,
        ) <= (race.configuration.rules === undefined ? PROVISIONAL_CONTACT.minimumLongitudinalGap : 8));
      const occupied = occupiedByCar
        || (race.track.fixedObstacles ?? []).some((obstacle) => obstacle.lane === lane && obstacle.progress === location.progress)
        || hazards.some((hazard) => hazard.lane === lane && hazard.progress === location.progress);
      if (occupied) continue;
      const viableOtherLane = race.track.lanes.some((candidate) => candidate.index !== lane
        && !(race.track.fixedObstacles ?? []).some((obstacle) => obstacle.lane === candidate.index && obstacle.progress === location.progress)
        && !hazards.some((hazard) => hazard.phase === "active" && hazard.lane === candidate.index && hazard.progress === location.progress));
      if (viableOtherLane) valid.push({ location, lane });
    }
  }
  if (valid.length === 0) return { hazard: null, randomState };
  const next = nextRandom(randomState);
  const selected = valid[next.value % valid.length]!;
  return {
    randomState: next.state,
    hazard: {
      id: `hazard-${sequence}`, locationId: selected.location.id, progress: selected.location.progress,
      lane: selected.lane, phase: "warning", ticksRemaining: PROVISIONAL_DURATIONS.hazardWarningTicks,
    },
  };
}

function advanceHazards(race: RaceState, events: RaceEvent[]): HazardState[] {
  const hazards: HazardState[] = [];
  for (const hazard of [...race.hazards].sort(compareIdsById)) {
    if (hazard.ticksRemaining > 1) { hazards.push({ ...hazard, ticksRemaining: hazard.ticksRemaining - 1 }); continue; }
    if (hazard.phase === "warning") {
      hazards.push({ ...hazard, phase: "active", ticksRemaining: PROVISIONAL_DURATIONS.hazardActiveTicks });
      events.push({ type: "hazard_activated", hazardId: hazard.id, tick: race.tick, timeSeconds: race.tick * TICK_SECONDS });
    } else {
      events.push({ type: "hazard_removed", hazardId: hazard.id, tick: race.tick, timeSeconds: race.tick * TICK_SECONDS });
    }
  }
  return hazards;
}

function resolveLongitudinalContact(race: RaceState, motions: CarProposal[], events: RaceEvent[]): void {
  for (const lane of race.track.lanes) {
    const settled = motions.filter((motion) => isInteractive(motion) && !isGhost(motion) && motion.transition === null && motion.lane === lane.index).sort(compareCyclicPosition);
    if (settled.length < 2) continue;
    const gaps = settled.map((motion, index) => ({ trailIndex: index, gap: forwardDistance(motion.car.progress, settled[(index + 1) % settled.length]!.car.progress, race.track.length) }));
    const rawContact = (edge: { trailIndex: number; gap: number }): boolean => {
      const trail = settled[edge.trailIndex]!; const lead = settled[(edge.trailIndex + 1) % settled.length]!;
      return edge.gap <= PROVISIONAL_CONTACT.minimumLongitudinalGap || trail.distance - lead.distance >= edge.gap - PROVISIONAL_CONTACT.minimumLongitudinalGap;
    };
    const openEdges = gaps.filter((edge) => !rawContact(edge));
    const cut = (openEdges.length > 0 ? openEdges : gaps).sort((a, b) => b.gap - a.gap || compareCarIds(settled[a.trailIndex]!.car, settled[b.trailIndex]!.car))[0]!;
    const leaderFirst: CarProposal[] = [];
    for (let offset = 0; offset < settled.length; offset += 1) leaderFirst.push(settled[modulo(cut.trailIndex - offset, settled.length)]!);
    for (let index = 1; index < leaderFirst.length; index += 1) resolveFollowingPair(race, leaderFirst[index]!, leaderFirst[index - 1]!, events);
  }
}

function resolveFollowingPair(race: RaceState, trailing: CarProposal, leading: CarProposal, events: RaceEvent[]): void {
  const gap = forwardDistance(trailing.car.progress, leading.car.progress, race.track.length);
  const requiredTravel = gap + leading.distance - PROVISIONAL_CONTACT.minimumLongitudinalGap;
  if (trailing.distance < requiredTravel) return;
  if (trailing.boostTicksRemaining > 0 && (race.configuration.rules === undefined || trailing.bargeTicks > 0 && trailing.bargeTicks <= 6)) return;
  const previous = trailing.car.ordinaryContact;
  const entering = previous?.leadingCarId !== leading.car.id;
  const proposedTrailingDistance = trailing.distance;
  trailing.distance = Math.min(trailing.distance, requiredTravel);
  trailing.contact = { leadingCarId: leading.car.id, enteredAtTick: entering ? race.tick : previous.enteredAtTick };
  if (!entering) return;
  const relativeDistance = proposedTrailingDistance - leading.distance;
  const contactDistance = Math.max(0, gap - PROVISIONAL_CONTACT.minimumLongitudinalGap);
  const fraction = relativeDistance > 0 ? clamp(contactDistance / relativeDistance, 0, 1) : 0;
  trailing.speed *= PROVISIONAL_CONTACT.trailingSpeedRetainedOnEntry;
  events.push({ type: "ordinary_collision", carId: trailing.car.id, leadingCarId: leading.car.id, tick: race.tick, timeSeconds: (race.tick + fraction) * TICK_SECONDS });
}

function commitCar(race: RaceState, motion: CarProposal, events: RaceEvent[]): CarState {
  const car = motion.car;
  if (car.result !== "racing") return car;
  if (car.crashRecoveryTicksRemaining > 0 && motion.crashRecoveryTicksRemaining > 0) {
    return {
      ...car, speed: 0, laneTransition: null, ordinaryContact: null,
      crashRecoveryTicksRemaining: motion.crashRecoveryTicksRemaining, ghost: motion.ghost,
      shieldTicksRemaining: motion.shieldTicksRemaining, boostTicksRemaining: motion.boostTicksRemaining,
      boostCharges: motion.boostCharges, deslotPressure: motion.deslotPressure, drafting: false,
      ...(race.configuration.rules === undefined ? {} : { bargeTicks: motion.bargeTicks, bargeCooldown: motion.bargeCooldown }),
    };
  }
  const respawned = car.crashRecoveryTicksRemaining > 0 && motion.crashRecoveryTicksRemaining === 0;
  let nextCheckpointIndex = car.nextCheckpointIndex;
  let completedLaps = car.completedLaps;
  let finishedAtSeconds = car.finishedAtSeconds;
  let result: CarResult = car.result;
  let respawnProgress = race.configuration.rules !== undefined && motion.crashedThisTick
    ? modulo(car.progress + Math.max(0, motion.distance), race.track.length) : car.respawnProgress;
  const startProgress = respawned ? car.respawnProgress : car.progress;
  const forwardTravel = Math.max(0, motion.distance);
  for (const crossing of crossedMarkers(race.track, startProgress, forwardTravel)) {
    if (race.configuration.rules === undefined && motion.crashedThisTick && crossing.distance >= forwardTravel) continue;
    if (finishedAtSeconds !== null) break;
    const timeSeconds = (race.tick + crossing.distance / forwardTravel) * TICK_SECONDS;
    if (crossing.kind === "checkpoint") {
      if (crossing.index === nextCheckpointIndex) {
        nextCheckpointIndex += 1;
        respawnProgress = race.track.checkpoints[crossing.index]!.progress;
        events.push({ type: "checkpoint", carId: car.id, checkpointId: race.track.checkpoints[crossing.index]!.id, tick: race.tick, timeSeconds });
      }
      continue;
    }
    if (nextCheckpointIndex === race.track.checkpoints.length) {
      completedLaps += 1; nextCheckpointIndex = 0; respawnProgress = race.track.startFinish;
      events.push({ type: "lap", carId: car.id, lap: completedLaps, tick: race.tick, timeSeconds });
      if (completedLaps >= race.configuration.laps) {
        finishedAtSeconds = timeSeconds; result = "finished";
        events.push({ type: "finish", carId: car.id, tick: race.tick, timeSeconds });
      }
    } else nextCheckpointIndex = 0;
  }
  return {
    ...car,
    progress: modulo(startProgress + forwardTravel, race.track.length),
    speed: result === "racing" ? motion.speed : 0,
    lane: motion.lane,
    laneTransition: result === "racing" ? motion.transition : null,
    ordinaryContact: result === "racing" ? motion.contact : null,
    nextCheckpointIndex, completedLaps, finishedAtSeconds, result,
    respawnProgress: race.configuration.rules !== undefined && motion.crashedThisTick
      ? modulo(car.progress + forwardTravel, race.track.length) : respawnProgress,
    ...(race.configuration.rules === undefined ? {} : {
      shieldCharges: motion.shieldCharges, mineCharges: motion.mineCharges,
      travelled: (car.travelled ?? 0) + forwardTravel,
      lastPickupTravel: motion.lastPickupTravel, lastPickupTick: motion.lastPickupTick,
      bargeTicks: motion.bargeTicks, bargeCooldown: motion.bargeCooldown,
    }),
    crashRecoveryTicksRemaining: motion.crashRecoveryTicksRemaining,
    ghost: motion.ghost,
    ghostMinimumTicksRemaining: respawned
      ? motion.ghostMinimumTicksRemaining
      : Math.max(0, motion.ghostMinimumTicksRemaining - 1),
    shieldTicksRemaining: motion.shieldTicksRemaining,
    boostTicksRemaining: motion.boostTicksRemaining,
    boostCharges: motion.boostCharges,
    deslotPressure: motion.deslotPressure,
    drafting: result === "racing" && motion.crashRecoveryTicksRemaining === 0 && motion.drafting,
  };
}

function endEligibleGhosts(race: RaceState, cars: CarState[], hazards: readonly HazardState[], events: RaceEvent[]): void {
  for (let index = 0; index < cars.length; index += 1) {
    const car = cars[index]!;
    if (!car.ghost || car.ghostMinimumTicksRemaining > 0 || car.crashRecoveryTicksRemaining > 0) continue;
    if (!ghostIsClear(race, car, cars, hazards)) continue;
    cars[index] = { ...car, ghost: false, ghostMinimumTicksRemaining: 0 };
    events.push({ type: "ghost_end", carId: car.id, tick: race.tick, timeSeconds: (race.tick + 1) * TICK_SECONDS });
  }
}
function ghostIsClear(race: RaceState, ghost: CarState, cars: readonly CarState[], hazards: readonly HazardState[]): boolean {
  const lanes = occupiedLanes(ghost);
  for (const car of cars) {
    if (car.id !== ghost.id && car.crashRecoveryTicksRemaining === 0 && !car.ghost
      && lanes.some((lane) => occupiedLanes(car).includes(lane))
      && cyclicClearance(ghost.progress, car.progress, race.track.length) <= PROVISIONAL_CONTACT.minimumLongitudinalGap) return false;
  }
  if ((race.track.fixedObstacles ?? []).some((obstacle) => lanes.includes(obstacle.lane) && cyclicClearance(ghost.progress, obstacle.progress, race.track.length) <= PROVISIONAL_CONTACT.minimumLongitudinalGap)) return false;
  return !hazards.some((hazard) => hazard.phase === "active" && lanes.includes(hazard.lane) && cyclicClearance(ghost.progress, hazard.progress, race.track.length) <= PROVISIONAL_CONTACT.minimumLongitudinalGap);
}

function rollOpportunities(track: Track, randomState: number): { opportunities: PowerUpOpportunityState[]; randomState: number } {
  const opportunities: PowerUpOpportunityState[] = [];
  for (const opportunity of [...(track.powerUpOpportunities ?? [])].sort(compareIdsById)) {
    let random = nextRandom(randomState); randomState = random.state;
    const lane = (random.value % 4) as LaneIndex;
    random = nextRandom(randomState); randomState = random.state;
    opportunities.push({ id: opportunity.id, lane, effect: opportunity.allowedEffects[random.value % opportunity.allowedEffects.length]!, collected: false });
  }
  return { opportunities, randomState };
}
function authoredProgress(track: Track, opportunityId: string): number {
  return track.powerUpOpportunities!.find((value) => value.id === opportunityId)!.progress;
}
function nextRandom(state: number): { state: number; value: number } {
  const next = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  return { state: next, value: next };
}

function catchFraction(trailing: CarProposal, leading: CarProposal, gap: number): number | null {
  if (gap <= PROVISIONAL_CONTACT.minimumLongitudinalGap) return 0;
  const relativeDistance = trailing.distance - leading.distance;
  if (relativeDistance < gap - PROVISIONAL_CONTACT.minimumLongitudinalGap) return null;
  return (gap - PROVISIONAL_CONTACT.minimumLongitudinalGap) / relativeDistance;
}
function isInteractive(motion: CarProposal): boolean { return motion.car.result === "racing" && motion.crashRecoveryTicksRemaining === 0 && !motion.crashedThisTick; }
function isGhost(value: Pick<CarState, "ghost"> | Pick<CarProposal, "ghost">): boolean { return value.ghost; }
function findMotion(motions: readonly CarProposal[], id: string): CarProposal { return motions.find((motion) => motion.car.id === id)!; }
function occupiedLanes(value: Pick<CarProposal, "lane" | "transition"> | Pick<CarState, "lane" | "laneTransition">): readonly LaneIndex[] {
  const transition = "transition" in value ? value.transition : value.laneTransition;
  return transition === null ? [value.lane] : [transition.from, transition.to];
}
function sweptPathsConflict(trackLength: number, a: CarProposal, b: CarProposal): boolean {
  const start = b.car.progress - a.car.progress; const end = start + b.distance - a.distance;
  const low = Math.min(start, end) - PROVISIONAL_CONTACT.minimumLongitudinalGap;
  const high = Math.max(start, end) + PROVISIONAL_CONTACT.minimumLongitudinalGap;
  return Math.ceil(low / trackLength) <= Math.floor(high / trackLength);
}

type MarkerCrossing = { readonly kind: "checkpoint"; readonly index: number; readonly distance: number } | { readonly kind: "finish"; readonly distance: number };
function crossedMarkers(track: Track, from: number, distance: number): MarkerCrossing[] {
  if (distance <= 0) return [];
  const markers: MarkerCrossing[] = [];
  for (let index = 0; index < track.checkpoints.length; index += 1) addCrossings(markers, "checkpoint", index, track.checkpoints[index]!.progress, track, from, distance);
  addCrossings(markers, "finish", undefined, track.startFinish, track, from, distance);
  markers.sort((a, b) => a.distance - b.distance);
  return markers;
}
function addCrossings(crossings: MarkerCrossing[], kind: MarkerCrossing["kind"], index: number | undefined, markerProgress: number, track: Track, from: number, distance: number): void {
  let crossingDistance = modulo(markerProgress - from, track.length);
  if (crossingDistance === 0) crossingDistance = track.length;
  while (crossingDistance <= distance) {
    crossings.push(kind === "checkpoint" ? { kind, index: index!, distance: crossingDistance } : { kind, distance: crossingDistance });
    crossingDistance += track.length;
  }
}

function compareEvents(a: RaceEvent, b: RaceEvent): number {
  return a.timeSeconds - b.timeSeconds
    || compareIds("carId" in a ? a.carId : "", "carId" in b ? b.carId : "")
    || eventOrder(a.type) - eventOrder(b.type)
    || compareIds(eventSourceId(a), eventSourceId(b));
}
function eventOrder(type: RaceEvent["type"]): number {
  if (type === "power_up_collected") return 0;
  if (type === "boosted_impact") return 1;
  if (type === "crash" || type === "shield_consumed" || type === "hazard_consumed") return 2;
  if (type === "ordinary_collision" || type === "blocked_lane_change") return 3;
  if (type === "checkpoint") return 4;
  if (type === "lap") return 5;
  return 6;
}
function eventSourceId(event: RaceEvent): string {
  if ("sourceId" in event) return event.sourceId;
  if ("hazardId" in event) return event.hazardId;
  if ("opportunityId" in event) return event.opportunityId;
  if ("checkpointId" in event) return event.checkpointId;
  return "";
}
function compareCyclicPosition(a: CarProposal, b: CarProposal): number { return a.car.progress - b.car.progress || -compareCarIds(a.car, b.car); }
function compareCarIds(a: Pick<CarState, "id">, b: Pick<CarState, "id">): number { return compareIds(a.id, b.id); }
function compareIdsById(a: { readonly id: string }, b: { readonly id: string }): number { return compareIds(a.id, b.id); }
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function forwardDistance(from: number, to: number, length: number): number { return modulo(to - from, length); }
function cyclicClearance(a: number, b: number, length: number): number { return Math.min(forwardDistance(a, b, length), forwardDistance(b, a, length)); }

function validateTrack(track: Track): void {
  assertPositiveFinite(track.length, "Track length");
  if (track.lanes.length !== 4 || track.lanes.some((lane, index) => lane.index !== index)) throw new Error("Track must contain exactly four Lanes indexed 0 through 3");
  assertTrackProgress(track.startFinish, track.length, "Track start/finish");
  const ids = new Set<string>();
  let previousDistance = 0;
  for (const checkpoint of track.checkpoints) {
    validateStableId(checkpoint.id, ids, "Checkpoint");
    assertTrackProgress(checkpoint.progress, track.length, `Checkpoint ${checkpoint.id}`);
    const distance = modulo(checkpoint.progress - track.startFinish, track.length);
    if (distance === 0 || distance <= previousDistance) throw new Error("Checkpoints must be strictly ordered after the start/finish in Track direction");
    previousDistance = distance;
  }
  validateAuthored(track.fixedObstacles ?? [], track.length, "Fixed obstacle", ids, (value) => validateLane(value.lane));
  validateAuthored(track.powerUpOpportunities ?? [], track.length, "Power-up opportunity", ids, (value) => {
    if (value.allowedEffects.length === 0 || new Set(value.allowedEffects).size !== value.allowedEffects.length
      || value.allowedEffects.some((effect) => effect !== "shield" && effect !== "boost" && effect !== "hazard")) throw new Error(`Power-up opportunity ${value.id} must have unique allowed effects`);
  });
  for (const corner of track.corners ?? []) {
    validateStableId(corner.id, ids, "Track corner");
    assertTrackProgress(corner.fromProgress, track.length, "Track corner start");
    assertTrackProgress(corner.toProgress, track.length, "Track corner end");
    const span = modulo(corner.toProgress - corner.fromProgress, track.length);
    if (span <= 0) throw new Error("Track corner must cover a non-empty span of Track progress");
    if (corner.laneSpeedLimits.length !== 4) throw new Error("Track corner must carry one speed limit per Lane");
    for (const limit of corner.laneSpeedLimits) assertPositiveFinite(limit, "Track corner Lane speed limit");
  }
  validateAuthored(track.hazardPlacementLocations ?? [], track.length, "Hazard placement location", ids, (value) => {
    if (value.allowedLanes.length === 0 || new Set(value.allowedLanes).size !== value.allowedLanes.length) throw new Error(`Hazard placement location ${value.id} must have unique allowed Lanes`);
    value.allowedLanes.forEach(validateLane);
  });
}
function validateAuthored<T extends { readonly id: string; readonly progress: number }>(values: readonly T[], length: number, label: string, ids: Set<string>, extra: (value: T) => void): void {
  for (const value of values) { validateStableId(value.id, ids, label); assertTrackProgress(value.progress, length, `${label} ${value.id}`); extra(value); }
}
function validateStableId(id: string, ids: Set<string>, label: string): void {
  if (!id || ids.has(id)) throw new Error(`${label} id must be non-empty and unique across Track authored data: ${id}`);
  ids.add(id);
}
function validateProfile(profile: CarProfile): void {
  assertNonNegativeFinite(profile.accelerationPerSecondSquared, "Car acceleration");
  assertNonNegativeFinite(profile.topSpeedPerSecond, "Car top speed");
  assertPositiveFinite(profile.brakingPerSecondSquared, "Car braking");
  assertPositiveInteger(profile.laneChangeDurationTicks, "Lane-change duration");
}
function validateLane(lane: number): asserts lane is LaneIndex { if (!Number.isInteger(lane) || lane < 0 || lane > 3) throw new Error(`Invalid Lane index: ${lane}`); }
function assertTrackProgress(value: number, length: number, label: string): void { if (!Number.isFinite(value) || value < 0 || value >= length) throw new Error(`${label} must be within Track progress [0, ${length})`); }
function assertPositiveInteger(value: number, label: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); }
function assertPositiveFinite(value: number, label: string): void { if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive and finite`); }
function assertNonNegativeFinite(value: number, label: string): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative and finite`); }
function modulo(value: number, modulus: number): number { return ((value % modulus) + modulus) % modulus; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }

/** Inner lanes shorten the route but tolerate less physical speed. */
function lanePaceFactor(race: RaceState, car: CarState): number {
  if (race.configuration.rules === undefined) return 1;
  const corner = activeCorner(race.track, car);
  if (corner === null) return 1;
  const mean = corner.laneSpeedLimits.reduce((sum, limit) => sum + limit, 0) / 4;
  return Math.min(...occupiedLanes(car).map((lane) => corner.laneSpeedLimits[lane]! / mean));
}

export function gripLimit(race: RaceState, car: CarState): number {
  const corner = activeCorner(race.track, car);
  return corner === null ? Infinity : cornerLaneLimit(corner, occupiedLanes(car), race.configuration.rules !== undefined);
}

export function raceCarProfile(assetId: string, voltage: 3 | 6 | 9 = 6): CarProfile {
  const profiles: Record<string, readonly [number, number, number, number]> = {
    "r2-car-club": [9, 18, 17, 6], "r2-car-muscle": [7.5, 19, 14, 8],
    "r2-car-prototype": [10, 17.5, 17, 5], "r2-car-gt": [8.5, 18.5, 19, 6],
  };
  const [acceleration, speed, braking, laneTicks] = profiles[assetId] ?? profiles["r2-car-club"]!;
  const scale = voltage === 3 ? 0.78 : voltage === 9 ? 1.22 : 1;
  return { accelerationPerSecondSquared: acceleration * scale, topSpeedPerSecond: speed * scale,
    brakingPerSecondSquared: braking, laneChangeDurationTicks: laneTicks };
}
