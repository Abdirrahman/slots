import { WORKSHOP_PATH, WORKSHOP_TRACK } from "./authored-track";
import { DEFAULT_RACE_LAPS } from "./multiplayer-config";
import {
  PROVISIONAL_CAR_PROFILE,
  TICK_SECONDS,
  createRace,
  type CarState,
  type LaneTransition,
  type RaceState,
  type Track,
} from "./race";

export const LOCAL_CAR_ID = "local-car";
export const LOCAL_RACE_LAPS = DEFAULT_RACE_LAPS;

// Provisional presentation values, centralized for playtesting.
export const PROVISIONAL_PRESENTATION = Object.freeze({
  trackRadius: 18,
  laneSpacing: 1.35,
  roadEdgeLaneMargin: 0.7,
  /** Heights are measured from the sampled Track surface, which now rises and banks. */
  trackSurfaceY: 0.02,
  laneRibbonY: 0.035,
  laneRibbonWidth: 0.22,
  roadEdgeRibbonWidth: 0.14,
  maxFrameSeconds: 0.25,
  cameraBehind: 5.4,
  cameraHeight: 2.6,
  cameraLookAhead: 8.5,
  cameraTargetHeight: 0.45,
  cameraFollowSharpness: 10,
  cameraImpulseHeight: 0.7,
  /** The chase camera answers to Track height changes more slowly than to its climb rate. */
  cameraClimbSharpness: 6,
  /** Field of view at rest, and the widest it opens at Boost top speed. */
  cameraFovAtRest: 58,
  cameraFovAtBoost: 68,
  /** Peak camera shake, in world units, at Boost top speed. */
  cameraShake: 0.05,
  /**
   * Bench distance covered by one unit of Track progress on the authored Workshop circuit.
   * Presentation only: it drives wheel spin, never the authoritative simulation.
   */
  worldUnitsPerProgress: 0.73,
});

export interface FixedStepResult {
  readonly steps: number;
  readonly accumulatorSeconds: number;
  readonly alpha: number;
}

export interface TrackPose {
  readonly x: number;
  /** Height of the Track surface at this Lane position, including banking. */
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  /** Climb angle of the Track surface; positive rises along the direction of travel. */
  readonly pitch: number;
  /** Roll of the Track surface about its forward direction; positive raises the Lane 3 edge. */
  readonly bank: number;
  readonly lanePosition: number;
}

export interface RoadEdges {
  readonly left: TrackPose;
  readonly right: TrackPose;
}

export interface CameraPose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly targetX: number;
  readonly targetY: number;
  readonly targetZ: number;
}

export function createLocalRace(): RaceState {
  return createRace({
    track: WORKSHOP_TRACK,
    configuration: { laps: LOCAL_RACE_LAPS },
    cars: [{ id: LOCAL_CAR_ID, profile: PROVISIONAL_CAR_PROFILE, lane: 1 }],
  });
}

export function consumeFrameTime(
  accumulatorSeconds: number,
  frameSeconds: number,
  maxFrameSeconds = PROVISIONAL_PRESENTATION.maxFrameSeconds,
): FixedStepResult {
  const safeAccumulator = Number.isFinite(accumulatorSeconds) && accumulatorSeconds > 0
    ? accumulatorSeconds
    : 0;
  const safeFrame = Number.isFinite(frameSeconds) && frameSeconds > 0
    ? Math.min(frameSeconds, maxFrameSeconds)
    : 0;
  const total = safeAccumulator + safeFrame;
  const steps = Math.floor((total + Number.EPSILON) / TICK_SECONDS);
  const remainder = Math.max(0, total - steps * TICK_SECONDS);

  return {
    steps,
    accumulatorSeconds: remainder,
    alpha: Math.min(1, remainder / TICK_SECONDS),
  };
}

export function lanePosition(car: Pick<CarState, "lane" | "laneTransition">): number {
  const transition = car.laneTransition;
  if (transition === null) return car.lane;
  return interpolateTransition(transition);
}

export function sampleTrackPose(
  track: Pick<Track, "id" | "version" | "length">,
  progress: number,
  lane: number,
): TrackPose {
  if (track.id === WORKSHOP_TRACK.id && track.version === WORKSHOP_TRACK.version) {
    return sampleAuthoredPath(track.length, progress, lane);
  }
  const normalizedProgress = modulo(progress, track.length);
  const angle = (normalizedProgress / track.length) * Math.PI * 2 - Math.PI / 2;
  const radius = PROVISIONAL_PRESENTATION.trackRadius + (lane - 1.5) * PROVISIONAL_PRESENTATION.laneSpacing;
  return {
    x: Math.cos(angle) * radius,
    y: 0,
    z: Math.sin(angle) * radius,
    heading: -angle,
    pitch: 0,
    bank: 0,
    lanePosition: lane,
  };
}

function sampleAuthoredPath(length: number, progress: number, lane: number): TrackPose {
  const normalized = modulo(progress, length);
  const count = WORKSHOP_PATH.length;
  let segment = count - 1;
  for (let index = 0; index < count; index += 1) {
    const nextProgress = index + 1 === count ? length : WORKSHOP_PATH[index + 1]!.progress;
    if (normalized >= WORKSHOP_PATH[index]!.progress && normalized < nextProgress) {
      segment = index;
      break;
    }
  }

  const previous = WORKSHOP_PATH[modulo(segment - 1, count)]!;
  const from = WORKSHOP_PATH[segment]!;
  const to = WORKSHOP_PATH[(segment + 1) % count]!;
  const following = WORKSHOP_PATH[(segment + 2) % count]!;
  const toProgress = segment + 1 === count ? length : to.progress;
  const amount = (normalized - from.progress) / (toProgress - from.progress);
  const x = catmullRom(previous.x, from.x, to.x, following.x, amount);
  const y = catmullRom(previous.y, from.y, to.y, following.y, amount);
  const z = catmullRom(previous.z, from.z, to.z, following.z, amount);
  const bank = catmullRom(previous.bank, from.bank, to.bank, following.bank, amount);
  const dx = catmullRomTangent(previous.x, from.x, to.x, following.x, amount);
  const dy = catmullRomTangent(previous.y, from.y, to.y, following.y, amount);
  const dz = catmullRomTangent(previous.z, from.z, to.z, following.z, amount);
  const magnitude = Math.hypot(dx, dz) || 1;
  // The Lane offset rotates with the banked surface, so a banked turn lifts its outside Lane.
  const offset = (lane - 1.5) * PROVISIONAL_PRESENTATION.laneSpacing;
  const lateral = offset * Math.cos(bank);
  return {
    x: x - dz / magnitude * lateral,
    y: y + offset * Math.sin(bank),
    z: z + dx / magnitude * lateral,
    heading: Math.atan2(dx, dz),
    pitch: Math.atan2(dy, magnitude),
    bank,
    lanePosition: lane,
  };
}

function catmullRom(previous: number, from: number, to: number, following: number, amount: number): number {
  const squared = amount * amount;
  const cubed = squared * amount;
  return 0.5 * (2 * from
    + (-previous + to) * amount
    + (2 * previous - 5 * from + 4 * to - following) * squared
    + (-previous + 3 * from - 3 * to + following) * cubed);
}

function catmullRomTangent(previous: number, from: number, to: number, following: number, amount: number): number {
  const squared = amount * amount;
  return 0.5 * ((-previous + to)
    + 2 * (2 * previous - 5 * from + 4 * to - following) * amount
    + 3 * (-previous + 3 * from - 3 * to + following) * squared);
}

export function sampleTrackRibbon(
  track: Pick<Track, "id" | "version" | "length">,
  progress: number,
  lane: number,
  width: number,
): RoadEdges {
  const halfLaneWidth = width / PROVISIONAL_PRESENTATION.laneSpacing / 2;
  return {
    left: sampleTrackPose(track, progress, lane - halfLaneWidth),
    right: sampleTrackPose(track, progress, lane + halfLaneWidth),
  };
}

export function sampleLaneRibbon(
  track: Pick<Track, "id" | "version" | "length">,
  progress: number,
  lane: number,
): RoadEdges {
  return sampleTrackRibbon(track, progress, lane, PROVISIONAL_PRESENTATION.laneRibbonWidth);
}

export function sampleRoadEdges(
  track: Pick<Track, "id" | "version" | "length">,
  progress: number,
): RoadEdges {
  return {
    left: sampleTrackPose(track, progress, -PROVISIONAL_PRESENTATION.roadEdgeLaneMargin),
    right: sampleTrackPose(track, progress, 3 + PROVISIONAL_PRESENTATION.roadEdgeLaneMargin),
  };
}

export interface RaceStanding {
  readonly carId: string;
  readonly position: number;
  /** Track progress travelled since the start line, across every completed Lap. */
  readonly distance: number;
  /** Progress units back to the Car one position ahead, or null for the leader. */
  readonly gapToAhead: number | null;
  readonly gapToLeader: number | null;
}

/**
 * Race order from authoritative state alone.
 *
 * Finished Cars hold their finishing order ahead of everyone still running, and DNF Cars
 * fall behind them. Ties break on stable Car id so two Cars abreast never swap places on
 * consecutive frames.
 */
export function raceStandings(
  track: Pick<Track, "length" | "startFinish">,
  cars: readonly Pick<CarState, "id" | "progress" | "completedLaps" | "result" | "finishedAtSeconds">[],
): readonly RaceStanding[] {
  const measured = cars.map((car) => ({
    car,
    distance: car.completedLaps * track.length + modulo(car.progress - track.startFinish, track.length),
  }));
  const rank = (result: CarState["result"]): number => (result === "finished" ? 0 : result === "racing" ? 1 : 2);
  const ordered = [...measured].sort((a, b) =>
    rank(a.car.result) - rank(b.car.result)
    || (a.car.finishedAtSeconds ?? 0) - (b.car.finishedAtSeconds ?? 0)
    || b.distance - a.distance
    || (a.car.id < b.car.id ? -1 : a.car.id > b.car.id ? 1 : 0));

  const leader = ordered[0];
  return ordered.map((entry, index) => ({
    carId: entry.car.id,
    position: index + 1,
    distance: entry.distance,
    gapToAhead: index === 0 ? null : ordered[index - 1]!.distance - entry.distance,
    gapToLeader: index === 0 ? null : leader!.distance - entry.distance,
  }));
}

/**
 * Field of view opens with speed so Boost is felt rather than only read on the HUD.
 *
 * It is bounded and eased, and reduced motion pins it at rest: a Racer still has to see the
 * next four Lanes, so the effect may never cost readability.
 */
export function speedCameraFov(speed: number, topSpeed: number, reducedMotion: boolean): number {
  const rest = PROVISIONAL_PRESENTATION.cameraFovAtRest;
  if (reducedMotion || !Number.isFinite(speed) || !Number.isFinite(topSpeed) || topSpeed <= 0) return rest;
  const amount = clamp((speed - topSpeed) / (topSpeed * 0.25), 0, 1);
  return rest + (PROVISIONAL_PRESENTATION.cameraFovAtBoost - rest) * amount;
}

export function selectCameraCarId(
  cars: readonly Pick<CarState, "id" | "result">[],
  localCarId: string | null,
): string | null {
  if (localCarId !== null && cars.some((car) => car.id === localCarId)) return localCarId;
  const racing = cars.filter((car) => car.result === "racing").map((car) => car.id).sort();
  return racing[0] ?? cars.map((car) => car.id).sort()[0] ?? null;
}

export function chaseCameraPose(
  followed: TrackPose,
  previous: CameraPose | null,
  frameSeconds: number,
  cameraImpulse: number,
  reducedMotion: boolean,
): CameraPose {
  const forwardX = Math.sin(followed.heading);
  const forwardZ = Math.cos(followed.heading);
  const impulseHeight = reducedMotion || !Number.isFinite(cameraImpulse)
    ? 0
    : Math.max(0, cameraImpulse) * PROVISIONAL_PRESENTATION.cameraImpulseHeight;
  // The camera sits behind the Car in Track space, so climbs, dips, and the flyover keep
  // the same framing instead of sinking into the Track or floating away from it.
  const behind = PROVISIONAL_PRESENTATION.cameraBehind;
  const ahead = PROVISIONAL_PRESENTATION.cameraLookAhead;
  const climb = Math.sin(followed.pitch);
  const desired: CameraPose = {
    x: followed.x - forwardX * behind,
    y: followed.y - climb * behind + PROVISIONAL_PRESENTATION.cameraHeight + impulseHeight,
    z: followed.z - forwardZ * behind,
    targetX: followed.x + forwardX * ahead,
    targetY: followed.y + climb * ahead + PROVISIONAL_PRESENTATION.cameraTargetHeight,
    targetZ: followed.z + forwardZ * ahead,
  };
  if (previous === null || reducedMotion) return desired;

  const seconds = clamp(frameSeconds, 0, 0.1);
  const amount = 1 - Math.exp(-PROVISIONAL_PRESENTATION.cameraFollowSharpness * seconds);
  const climbAmount = 1 - Math.exp(-PROVISIONAL_PRESENTATION.cameraClimbSharpness * seconds);
  return {
    x: lerp(previous.x, desired.x, amount),
    y: lerp(previous.y, desired.y, climbAmount),
    z: lerp(previous.z, desired.z, amount),
    targetX: lerp(previous.targetX, desired.targetX, amount),
    targetY: lerp(previous.targetY, desired.targetY, climbAmount),
    targetZ: lerp(previous.targetZ, desired.targetZ, amount),
  };
}

export function interpolateCarPose(
  track: Pick<Track, "id" | "version" | "length">,
  previous: CarState,
  current: CarState,
  alpha: number,
): TrackPose {
  const amount = clamp(alpha, 0, 1);
  const progressDelta = modulo(current.progress - previous.progress, track.length);
  const progress = modulo(previous.progress + progressDelta * amount, track.length);
  const lane = lerp(lanePosition(previous), lanePosition(current), amount);
  return sampleTrackPose(track, progress, lane);
}

function interpolateTransition(transition: LaneTransition): number {
  return lerp(transition.from, transition.to, clamp(transition.progress, 0, 1));
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
