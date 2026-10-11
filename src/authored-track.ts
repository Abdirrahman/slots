import rawWorkshopTrack from "./workshop-track.json";
import rawDiningTrack from "./dining-track.json";
import type {
  Checkpoint,
  FixedObstacle,
  HazardPlacementLocation,
  Lane,
  LaneIndex,
  PowerUpEffect,
  PowerUpOpportunity,
  Track,
  TrackCorner,
} from "./race";

export interface AuthoredPathPoint {
  readonly progress: number;
  readonly x: number;
  /** Height of the Track surface above the bench, so flyovers and climbs are authored data. */
  readonly y: number;
  readonly z: number;
  /** Roll of the Track surface about its forward direction; positive raises the Lane 3 edge. */
  readonly bank: number;
}

export interface VersionedTrack extends Track { readonly version: string }
export interface AuthoredTrackContent {
  readonly track: VersionedTrack;
  readonly path: readonly AuthoredPathPoint[];
}

/** Banking beyond this angle would let a Car read as leaving the Track surface. */
const MAX_AUTHORED_BANK = Math.PI / 4;

const ROOT_KEYS = ["schemaVersion", "id", "version", "length", "lanes", "startFinish", "checkpoints", "fixedObstacles", "powerUpOpportunities", "hazardPlacementLocations", "corners", "presentation"] as const;

/** No authored corner may ask for a speed no Car could reach or hold. */
const MAX_AUTHORED_CORNER_SPEED = 1_000;

export function validateAuthoredTrack(value: unknown): AuthoredTrackContent {
  if (!isObject(value) || !hasExactKeys(value, ROOT_KEYS)) fail("Authored Track has missing or extra fields");
  if (value.schemaVersion !== 1) fail("Authored Track schemaVersion must be 1");
  if (!stableId(value.id)) fail("Authored Track id is invalid");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(value.version)) fail("Authored Track version is invalid");
  if (!positiveFinite(value.length)) fail("Authored Track length is invalid");
  const length = value.length;
  if (!Array.isArray(value.lanes) || value.lanes.length !== 4 || !value.lanes.every((lane, index) => isObject(lane) && hasExactKeys(lane, ["index"]) && lane.index === index)) {
    fail("Authored Track must contain exactly four Lanes indexed 0 through 3");
  }
  if (!progress(value.startFinish, length)) fail("Authored Track start/finish is invalid");

  const ids = new Set<string>();
  if (!Array.isArray(value.checkpoints) || value.checkpoints.length === 0) fail("Authored Track checkpoints are invalid");
  let previousDistance = 0;
  for (const checkpoint of value.checkpoints) {
    authoredPoint(checkpoint, ["id", "progress"], length, ids, "Checkpoint");
    const distance = ((checkpoint.progress as number) - value.startFinish + length) % length;
    if (distance === 0 || distance <= previousDistance) fail("Authored Track checkpoints must be ordered");
    previousDistance = distance;
  }

  if (!Array.isArray(value.fixedObstacles)) fail("Authored Track fixed obstacles are invalid");
  validateCanonical(value.fixedObstacles, (obstacle) => {
    authoredPoint(obstacle, ["id", "progress", "lane"], length, ids, "Fixed obstacle");
    if (!lane(obstacle.lane)) fail("Fixed obstacle Lane is invalid");
  }, "fixed obstacles");

  if (!Array.isArray(value.powerUpOpportunities)) fail("Authored Track pickup opportunities are invalid");
  validateCanonical(value.powerUpOpportunities, (opportunity) => {
    authoredPoint(opportunity, ["id", "progress", "allowedEffects", ...(opportunity.spawnRadius === undefined ? [] : ["spawnRadius"])], length, ids, "Pickup opportunity");
    if (opportunity.spawnRadius !== undefined && (!positiveFinite(opportunity.spawnRadius) || opportunity.spawnRadius > length / 4)) fail("Pickup spawn radius is invalid");
    if (!Array.isArray(opportunity.allowedEffects) || opportunity.allowedEffects.length === 0
      || new Set(opportunity.allowedEffects).size !== opportunity.allowedEffects.length
      || !opportunity.allowedEffects.every(powerUpEffect)) fail("Pickup allowed effects are invalid");
  }, "pickup opportunities");

  if (!Array.isArray(value.hazardPlacementLocations)) fail("Authored Track Hazard locations are invalid");
  validateCanonical(value.hazardPlacementLocations, (location) => {
    authoredPoint(location, ["id", "progress", "allowedLanes"], length, ids, "Hazard location");
    if (!Array.isArray(location.allowedLanes) || location.allowedLanes.length === 0
      || new Set(location.allowedLanes).size !== location.allowedLanes.length
      || !location.allowedLanes.every(lane)
      || !isAscending(location.allowedLanes as number[])) fail("Hazard allowed Lanes are invalid");
  }, "Hazard locations");

  if (!Array.isArray(value.corners)) fail("Authored Track corners are invalid");
  validateCanonical(value.corners, (corner) => {
    if (!isObject(corner) || !hasExactKeys(corner, ["id", "fromProgress", "toProgress", "laneSpeedLimits"])
      || !stableId(corner.id) || ids.has(corner.id)
      || !progress(corner.fromProgress, length) || !progress(corner.toProgress, length)
      || corner.fromProgress === corner.toProgress) fail("Track corner is malformed or duplicated");
    ids.add(corner.id as string);
    if (!Array.isArray(corner.laneSpeedLimits) || corner.laneSpeedLimits.length !== 4
      || !corner.laneSpeedLimits.every((limit) => positiveFinite(limit) && limit <= MAX_AUTHORED_CORNER_SPEED)) {
      fail("Track corner Lane speed limits are invalid");
    }
  }, "corners");

  if (!isObject(value.presentation) || !hasExactKeys(value.presentation, ["path"])
    || !Array.isArray(value.presentation.path) || value.presentation.path.length < 4) fail("Authored Track presentation path is invalid");
  let previousProgress = -1;
  for (const point of value.presentation.path) {
    if (!isObject(point) || !hasExactKeys(point, ["progress", "x", "y", "z", "bank"])
      || !progress(point.progress, length) || !finite(point.x) || !finite(point.z)
      || !finite(point.y) || point.y < 0 || !finite(point.bank) || Math.abs(point.bank) > MAX_AUTHORED_BANK
      || point.progress <= previousProgress) fail("Authored Track path points must be finite, banked within limits, and ordered");
    previousProgress = point.progress;
  }
  if ((value.presentation.path[0] as Record<string, unknown>).progress !== value.startFinish) fail("Authored Track path must begin at start/finish");

  return freezeContent({
    track: {
      id: value.id,
      version: value.version,
      length,
      lanes: value.lanes as unknown as [Lane, Lane, Lane, Lane],
      startFinish: value.startFinish,
      checkpoints: value.checkpoints as unknown as Checkpoint[],
      fixedObstacles: value.fixedObstacles as unknown as FixedObstacle[],
      powerUpOpportunities: value.powerUpOpportunities as unknown as PowerUpOpportunity[],
      hazardPlacementLocations: value.hazardPlacementLocations as unknown as HazardPlacementLocation[],
      corners: value.corners as unknown as TrackCorner[],
    },
    path: (value.presentation as { path: AuthoredPathPoint[] }).path,
  });
}

export const WORKSHOP_CONTENT = validateAuthoredTrack(rawWorkshopTrack);
export const WORKSHOP_TRACK = WORKSHOP_CONTENT.track;
export const WORKSHOP_PATH = WORKSHOP_CONTENT.path;
export const WORKSHOP_TRACK_IDENTITY = `${WORKSHOP_TRACK.id}@${WORKSHOP_TRACK.version}`;
export const DINING_CONTENT = validateAuthoredTrack(rawDiningTrack);
export const DINING_TRACK = DINING_CONTENT.track;
export const DEFAULT_TRACK = DINING_TRACK;

const AUTHORED_TRACKS = new Map([
  [WORKSHOP_TRACK.id, WORKSHOP_CONTENT],
  [DINING_TRACK.id, DINING_CONTENT],
]);

/** Unknown ids are synthetic test Tracks; known authored Tracks must match their baked geometry. */
export function resolveAuthoredTrack(track: Pick<Track, "id" | "version" | "length">): AuthoredTrackContent | undefined {
  const content = AUTHORED_TRACKS.get(track.id);
  if (content === undefined) return undefined;
  if (track.version !== content.track.version || track.length !== content.track.length) {
    fail(`Authored Track identity mismatch: ${track.id}@${track.version ?? "unversioned"}`);
  }
  return content;
}

function authoredPoint(value: unknown, keys: readonly string[], length: number, ids: Set<string>, label: string): asserts value is Record<string, unknown> {
  if (!isObject(value) || !hasExactKeys(value, keys) || !stableId(value.id) || ids.has(value.id) || !progress(value.progress, length)) fail(`${label} is malformed or duplicated`);
  ids.add(value.id);
}

function validateCanonical(values: unknown[], validate: (value: Record<string, unknown>) => void, label: string): void {
  for (const value of values) validate(value as Record<string, unknown>);
  const ids = values.map((value) => (value as Record<string, unknown>).id as string);
  if (!isAscending(ids)) fail(`Authored Track ${label} must use canonical stable-id order`);
}

function freezeContent(content: AuthoredTrackContent): AuthoredTrackContent {
  const track = content.track;
  for (const values of [track.lanes, track.checkpoints, track.fixedObstacles, track.powerUpOpportunities, track.hazardPlacementLocations, track.corners, content.path]) {
    for (const value of values ?? []) Object.freeze(value);
    Object.freeze(values);
  }
  Object.freeze(track);
  return Object.freeze(content);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stableId(value: unknown): value is string { return typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function positiveFinite(value: unknown): value is number { return finite(value) && value > 0; }
function progress(value: unknown, length: number): value is number { return finite(value) && value >= 0 && value < length; }
function lane(value: unknown): value is LaneIndex { return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3; }
function powerUpEffect(value: unknown): value is PowerUpEffect { return value === "boost" || value === "shield" || value === "hazard"; }
function isAscending(values: readonly (number | string)[]): boolean { return values.every((value, index) => index === 0 || values[index - 1]! < value); }
function fail(message: string): never { throw new Error(message); }
