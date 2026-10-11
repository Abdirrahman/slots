import {
  COUNTDOWN_TICKS,
  MAX_CONFIGURED_BOTS,
  MAX_CONNECTION_GENERATION,
  MAX_EVENT_BATCH,
  MAX_GUEST_NAME_LENGTH,
  MAX_LAPS,
  MAX_PLAYER_ID_LENGTH,
  MAX_RACERS,
  MAX_RACE_ID_LENGTH,
  MAX_ROOM_CODE_LENGTH,
  MAX_ROOM_CONNECTIONS,
  MAX_SPECTATORS,
  MIN_ROOM_CODE_LENGTH,
  RECONNECT_TOKEN_LENGTH,
  SNAPSHOT_INTERVAL_TICKS,
} from "./multiplayer-config";
import {
  PROTOCOL_VERSION,
  validRaceConfiguration,
  type ServerErrorMessage,
  type ServerIdentityMessage,
  type ServerRaceEventsMessage,
  type ServerSnapshotMessage as ProtocolSnapshotMessage,
} from "./protocol";
import { CRASH_CAUSES, PROVISIONAL_CORNERING, PROVISIONAL_DURATIONS, PROVISIONAL_POWER_UPS, TICKS_PER_SECOND, automaticSpeedTarget, type CarState, type LaneChangeDirection, type LaneIndex, type RaceEvent, type RaceState } from "./race";
import type { RoomSnapshot } from "./room";
import { isRacingCarAssetId } from "./racing-assets";
import { interpolateCarMotion, lanePosition, sampleTrackPose, type CarMotion, type TrackPose } from "./presentation";

export type ServerSnapshotMessage = ProtocolSnapshotMessage<RoomSnapshot>;
export type ServerMessage = ServerSnapshotMessage | ServerIdentityMessage | ServerRaceEventsMessage | ServerErrorMessage;

export interface SnapshotPair {
  readonly previous: ServerSnapshotMessage | null;
  readonly current: ServerSnapshotMessage;
}

export function parseServerMessage(text: string): ServerMessage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Malformed server message");
  }
  if (!isObject(value) || value.protocolVersion !== PROTOCOL_VERSION) throw new Error("Incompatible server protocol");
  if (value.type === "error") {
    if (!hasExactKeys(value, ["protocolVersion", "type", "code", "message"])
      || typeof value.code !== "string" || !/^[a-z_]+$/u.test(value.code)
      || typeof value.message !== "string" || value.message.length === 0 || value.message.length > 256) {
      throw new Error("Malformed server message");
    }
    return value as unknown as ServerErrorMessage;
  }
  if (value.type === "identity") {
    if (!hasExactKeys(value, [
      "protocolVersion", "type", "roomCode", "localPlayerId", "reconnectToken", "connectionGeneration",
    ]) || !isRoomCode(value.roomCode) || !isPlayerId(value.localPlayerId)
      || typeof value.reconnectToken !== "string" || value.reconnectToken.length !== RECONNECT_TOKEN_LENGTH
      || !/^[A-Za-z0-9_-]+$/u.test(value.reconnectToken)
      || !isConnectionGeneration(value.connectionGeneration)) throw new Error("Malformed server message");
    return value as unknown as ServerIdentityMessage;
  }
  if (value.type === "race_events") {
    if (!hasExactKeys(value, ["protocolVersion", "type", "roomCode", "raceId", "events"])
      || !isRoomCode(value.roomCode) || !isRaceId(value.raceId)
      || !Array.isArray(value.events) || value.events.length === 0 || value.events.length > MAX_EVENT_BATCH
      || !value.events.every(isIdentifiedRaceEvent)) throw new Error("Malformed server message");
    return value as unknown as ServerRaceEventsMessage;
  }
  if (
    value.type !== "snapshot"
    || !hasExactKeys(value, [
      "protocolVersion", "type", "roomCode", "raceId", "simulationTick", "stateVersion",
      "lastProcessedInputSequence", "localPlayerId", "connectionGeneration", "state",
    ])
    || !isRoomCode(value.roomCode)
    || !(value.raceId === null || isRaceId(value.raceId))
    || !isNonNegativeSafeInteger(value.simulationTick)
    || !isPositiveSafeInteger(value.stateVersion)
    || !isInputSequence(value.lastProcessedInputSequence)
    || !isPlayerId(value.localPlayerId)
    || !isConnectionGeneration(value.connectionGeneration)
    || !isObject(value.state)
    || !isValidMilestone6State(value.state, value.localPlayerId)
    || value.state.roomCode !== value.roomCode
    || value.state.raceId !== value.raceId
    || value.state.stateVersion !== value.stateVersion
    || value.state.lastProcessedInputSequence !== value.lastProcessedInputSequence
    || value.state.localConnectionGeneration !== value.connectionGeneration
    || (value.state.race === null
      ? value.simulationTick !== 0
      : !isObject(value.state.race) || value.state.race.tick !== value.simulationTick)
  ) throw new Error("Malformed server message");
  return value as unknown as ServerSnapshotMessage;
}

export function acceptSnapshot(pair: SnapshotPair | null, incoming: ServerSnapshotMessage): SnapshotPair {
  if (pair !== null && incoming.stateVersion <= pair.current.stateVersion) return pair;
  return { previous: pair?.current ?? null, current: incoming };
}

export function snapshotAlpha(secondsSinceCurrent: number): number {
  const snapshotSeconds = SNAPSHOT_INTERVAL_TICKS / TICKS_PER_SECOND;
  return clamp(secondsSinceCurrent / snapshotSeconds, 0, 1);
}

/** The motion an observed Car reads as having, interpolated between the last two snapshots. */
export function snapshotCarMotion(pair: SnapshotPair, carId: string, alpha: number): CarMotion | null {
  const currentRace = pair.current.state.race;
  if (currentRace === null) return null;
  const current = findCar(currentRace, carId);
  if (current === undefined) return null;
  const settled: CarMotion = { progress: current.progress, lane: lanePosition(current) };
  if (current.result !== "racing") return settled;
  const previousRace = pair.previous?.state.race;
  const previous = previousRace?.track.id === currentRace.track.id ? findCar(previousRace, carId) : undefined;
  if (
    previous === undefined
    || current.crashRecoveryTicksRemaining > 0
    || current.ghost
    || previous.crashRecoveryTicksRemaining > 0
    || previous.ghost !== current.ghost
  ) return settled;
  return interpolateCarMotion(currentRace.track, previous, current, alpha);
}

export function interpolateSnapshotCar(
  pair: SnapshotPair,
  carId: string,
  alpha: number,
): TrackPose | null {
  const motion = snapshotCarMotion(pair, carId, alpha);
  if (motion === null) return null;
  return sampleTrackPose(pair.current.state.race!.track, motion.progress, motion.lane);
}

/**
 * The Lane the local Racer's own input has already committed their Car to.
 *
 * Lane is predicted where forward travel is not. A Lane transition is the Racer's decision
 * and the Room advances it by a fixed fraction per tick, so the client can reproduce it
 * exactly; forward travel is the Track's decision and cannot be reproduced without knowing
 * what the Car is about to hit. A mispredicted Lane is also self-correcting in a way a
 * mispredicted progress is not — a Blocked change renders as a partial move followed by a
 * return, which is precisely what the authoritative rule produces anyway.
 *
 * Only a Car that cannot act on a Lane input at all is excluded: a Crashed or recovering
 * Car, and a Car that has finished or is DNF. Contact, Shield, Boost and Ghost state all
 * leave Lane changing available, and contact is the state where a Racer most wants it,
 * because changing Lane is how a constrained Car gets out from behind the Car ahead.
 */
export function predictLocalLane(
  car: CarState,
  secondsSinceSnapshot: number,
  laneChange?: LaneChangeDirection,
): number {
  if (car.result !== "racing" || car.crashRecoveryTicksRemaining > 0) return lanePosition(car);
  const advanced = secondsSinceSnapshot * TICKS_PER_SECOND / car.profile.laneChangeDurationTicks;
  if (car.laneTransition !== null) {
    const progress = car.laneTransition.progress + (car.laneTransition.phase === "returning" ? -advanced : advanced);
    return lanePosition({ lane: car.lane, laneTransition: { ...car.laneTransition, progress: clamp(progress, 0, 1) } });
  }
  if (laneChange === undefined) return lanePosition(car);
  const to = car.lane + laneChange;
  if (to < 0 || to > 3) return lanePosition(car);
  return lanePosition({
    lane: car.lane,
    laneTransition: { from: car.lane, to: to as LaneIndex, progress: clamp(advanced, 0, 1), phase: "changing" },
  });
}

/**
 * Whether the local Car's forward travel can be extrapolated past the last snapshot.
 *
 * Anything that can truncate or redirect travel inside the next snapshot interval rules it
 * out, because a progress prediction that overshoots shows up as the Car snapping backwards
 * when authority arrives. On a Track carrying obstacles, pickups or live Hazards — which is
 * every authored Track — that means forward travel is interpolated from authority instead.
 * The 67 ms this costs is not felt: forward motion is continuous and nothing the Racer does
 * changes it. Lane is what responds to input, and `predictLocalLane` always predicts it.
 */
function canPredictProgress(race: RaceState, car: CarState): boolean {
  return race.configuration.rules === undefined && car.result === "racing"
    && car.ordinaryContact === null
    && car.crashRecoveryTicksRemaining === 0
    && !car.ghost
    && car.shieldTicksRemaining === 0
    && car.boostTicksRemaining === 0
    && (race.track.fixedObstacles?.length ?? 0) === 0
    && (race.track.powerUpOpportunities?.length ?? 0) === 0
    && race.hazards.length === 0;
}

export function predictLocalCarPose(
  pair: SnapshotPair,
  carId: string,
  secondsSinceSnapshot: number,
  laneChange?: LaneChangeDirection,
): TrackPose | null {
  const race = pair.current.state.race;
  if (race === null) return null;
  const car = findCar(race, carId);
  if (car === undefined) return null;
  const seconds = clamp(secondsSinceSnapshot, 0, SNAPSHOT_INTERVAL_TICKS / TICKS_PER_SECOND);
  const lane = predictLocalLane(car, seconds, laneChange);
  if (!canPredictProgress(race, car)) {
    const observed = snapshotCarMotion(pair, carId, snapshotAlpha(secondsSinceSnapshot))!;
    return sampleTrackPose(race.track, observed.progress, lane);
  }
  // Extrapolate with the server's own throttle model, so a corner's lift is predicted rather
  // than corrected away by the next snapshot.
  const target = automaticSpeedTarget(race.track, car);
  const speed = car.speed < target
    ? Math.min(target, car.speed + car.profile.accelerationPerSecondSquared * seconds)
    : Math.max(target, car.speed - car.profile.brakingPerSecondSquared * seconds);
  return sampleTrackPose(race.track, car.progress + ((car.speed + speed) / 2) * seconds, lane);
}

function findCar(race: RaceState, carId: string): CarState | undefined {
  return race.cars.find((car) => car.id === carId);
}

function isIdentifiedRaceEvent(value: unknown): boolean {
  return isObject(value) && hasExactKeys(value, ["id", "event"])
    && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 160
    && /^[A-Za-z0-9_:-]+$/u.test(value.id) && isRaceEvent(value.event);
}

function isRaceEvent(value: unknown): value is RaceEvent {
  if (!isObject(value) || typeof value.type !== "string" || !isNonNegativeSafeInteger(value.tick)
    || !isNonNegativeFinite(value.timeSeconds)) return false;
  const timed = ["type", "tick", "timeSeconds"];
  switch (value.type) {
    case "checkpoint": return hasExactKeys(value, [...timed, "carId", "checkpointId"]) && isPlayerId(value.carId) && stableSourceId(value.checkpointId);
    case "lap": return hasExactKeys(value, [...timed, "carId", "lap"]) && isPlayerId(value.carId) && isPositiveSafeInteger(value.lap);
    case "finish": case "blocked_lane_change": case "ghost_end":
      return hasExactKeys(value, [...timed, "carId"]) && isPlayerId(value.carId);
    case "ordinary_collision": return hasExactKeys(value, [...timed, "carId", "leadingCarId"]) && isPlayerId(value.carId) && isPlayerId(value.leadingCarId) && value.carId !== value.leadingCarId;
    case "crash": return hasExactKeys(value, [...timed, "carId", "cause", "sourceId"]) && isPlayerId(value.carId)
      && (CRASH_CAUSES as readonly string[]).includes(String(value.cause)) && stableSourceId(value.sourceId);
    case "respawn": return hasExactKeys(value, [...timed, "carId", "lane"]) && isPlayerId(value.carId) && isLane(value.lane);
    case "power_up_collected": return hasExactKeys(value, [...timed, "carId", "opportunityId", "effect"])
      && isPlayerId(value.carId) && stableSourceId(value.opportunityId) && isPowerUpEffect(value.effect);
    case "shield_consumed": return hasExactKeys(value, [...timed, "carId", "sourceId"]) && isPlayerId(value.carId) && stableSourceId(value.sourceId);
    case "boosted_impact": return hasExactKeys(value, [...timed, "carId", "targetCarId"]) && isPlayerId(value.carId) && isPlayerId(value.targetCarId) && value.carId !== value.targetCarId;
    case "hazard_placed": return hasExactKeys(value, [...timed, "carId", "hazardId", "locationId", "lane"])
      && isPlayerId(value.carId) && stableSourceId(value.hazardId) && stableSourceId(value.locationId) && isLane(value.lane);
    case "hazard_activated": case "hazard_removed":
      return hasExactKeys(value, [...timed, "hazardId"]) && stableSourceId(value.hazardId);
    case "hazard_consumed": return hasExactKeys(value, [...timed, "carId", "hazardId"]) && isPlayerId(value.carId) && stableSourceId(value.hazardId);
    case "boost_activated": return hasExactKeys(value, [...timed, "carId", "chargesRemaining"])
      && isPlayerId(value.carId) && isNonNegativeSafeInteger(value.chargesRemaining)
      && (value.chargesRemaining as number) < PROVISIONAL_POWER_UPS.maximumBoostCharges;
    case "deslot_warning": return hasExactKeys(value, [...timed, "carId", "cornerId"])
      && isPlayerId(value.carId) && stableSourceId(value.cornerId);
    default: return false;
  }
}

function stableSourceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isValidMilestone6State(state: Record<string, unknown>, localPlayerId: string): boolean {
  if (!hasExactKeys(state, [
    "roomCode", "phase", "stateVersion", "raceId", "countdownTicksRemaining",
    "configuration", "soloConfiguration", "configuredBots", "players", "race", "lastProcessedInputSequence",
    "localConnectionGeneration", "localRole", "canControlRace", "canStartRace", "canRematch",
  ]) || !isRoomCode(state.roomCode)
    || !["open", "countdown", "racing", "results"].includes(String(state.phase))
    || !isPositiveSafeInteger(state.stateVersion)
    || !(state.raceId === null || isRaceId(state.raceId))
    || !isValidConfiguration(state.configuration)
    || !(state.soloConfiguration === null || isValidSoloConfiguration(state.soloConfiguration))
    || !Array.isArray(state.configuredBots) || state.configuredBots.length > MAX_CONFIGURED_BOTS
    || !state.configuredBots.every(isValidConfiguredBot)
    || !Array.isArray(state.players) || state.players.length < 1 || state.players.length > MAX_ROOM_CONNECTIONS
    || !state.players.every(isValidPlayer)
    || !isInputSequence(state.lastProcessedInputSequence)
    || !isConnectionGeneration(state.localConnectionGeneration)
    || (state.localRole !== "racer" && state.localRole !== "spectator")
    || typeof state.canControlRace !== "boolean"
    || typeof state.canStartRace !== "boolean"
    || typeof state.canRematch !== "boolean") return false;

  const players = state.players as Record<string, unknown>[];
  const configuredBots = state.configuredBots as Record<string, unknown>[];
  const ids = new Set(players.map((player) => player.id));
  const botIds = new Set(configuredBots.map((bot) => bot.id));
  const local = players.find((player) => player.id === localPlayerId);
  const racers = players.filter((player) => player.role === "racer");
  const spectators = players.filter((player) => player.role === "spectator");
  const solo = state.soloConfiguration as Record<string, unknown> | null;
  if (ids.size !== players.length || botIds.size !== configuredBots.length
    || configuredBots.some((bot, index) => bot.id !== `configured-bot-${index + 1}` || bot.name !== `Bot ${index + 1}`)
    || [...botIds].some((id) => ids.has(id))
    || racers.length > MAX_RACERS || spectators.length > MAX_SPECTATORS
    || local === undefined || local.connected !== true || local.role !== state.localRole
    || players.filter((player) => player.isHost).length !== 1
    || (solo === null ? configuredBots.length !== 0 : configuredBots.length !== solo.botCount
      || players.length !== 1 || racers.length !== 1 || spectators.length !== 0)) return false;

  if (solo !== null && ((state.configuration as Record<string, unknown>).rules === "trial"
    ? solo.botCount !== 0 : (solo.botCount as number) < 1)) return false;
  const phase = state.phase;
  const raceValid = state.race === null ? phase === "open" : isValidRace(state.race, state.configuration);
  if (!raceValid
    || (phase === "open" && state.race !== null)
    || (phase === "open" && state.countdownTicksRemaining !== null)
    || (phase === "countdown" && (!isNonNegativeSafeInteger(state.countdownTicksRemaining)
      || (state.countdownTicksRemaining as number) > COUNTDOWN_TICKS))
    || ((phase === "racing" || phase === "results") && state.countdownTicksRemaining !== null)
    || (phase !== "open" && (state.raceId === null || state.race === null))
    || (phase === "results" && (state.race as Record<string, unknown>).status !== "finished")
    || ((phase === "countdown" || phase === "racing") && (state.race as Record<string, unknown>).status !== "racing")) return false;

  const carIds = new Set(state.race === null
    ? []
    : ((state.race as Record<string, unknown>).cars as Record<string, unknown>[]).map((car) => car.id));
  const racerSeatIds = new Set(racers.map((player) => player.raceSeatId));
  if (![...carIds].every((id) => racerSeatIds.has(id) || botIds.has(id))
    || (phase !== "open" && [...botIds].some((id) => !carIds.has(id)))
    || !players.every((player) => isValidPlayerState(player, phase as string, carIds))) return false;
  const localCanControl = phase === "racing" && local.role === "racer"
    && local.controller === "human" && local.reclaimPending === false;
  return state.canControlRace === localCanControl
    && state.canStartRace === (phase === "open" && local.role === "racer" && local.isHost === true)
        && state.canRematch === (phase === "results" && local.role === "racer" && local.isHost === true);
}

function isValidConfiguredBot(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || !hasExactKeys(value, ["id", "name"])
    || typeof value.id !== "string" || !/^configured-bot-[1-3]$/u.test(value.id)
    || typeof value.name !== "string" || !/^Bot [1-3]$/u.test(value.name)) return false;
  return value.id.at(-1) === value.name.at(-1);
}

function isValidPlayer(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && hasExactKeys(value, ["id", "name", "role", "raceSeatId", "controller", "reclaimPending", "bestTimeEligible", "isHost", "connected", ...(value.carAssetId === undefined ? [] : ["carAssetId"])])
    && (value.carAssetId === undefined || isRacingCarAssetId(value.carAssetId))
    && isPlayerId(value.id)
    && typeof value.name === "string" && value.name.length > 0 && value.name.length <= MAX_GUEST_NAME_LENGTH
    && value.name === value.name.trim() && !/[\u0000-\u001f\u007f]/u.test(value.name)
    && (value.role === "racer" || value.role === "spectator")
    && (value.raceSeatId === null || isPlayerId(value.raceSeatId))
    && (value.controller === "human" || value.controller === "bot" || value.controller === "none")
    && typeof value.reclaimPending === "boolean"
    && typeof value.bestTimeEligible === "boolean"
    && (value.role === "racer" || value.bestTimeEligible === false)
    && typeof value.isHost === "boolean"
    && typeof value.connected === "boolean"
    && (value.role === "racer" ? value.raceSeatId === value.id : value.raceSeatId === null);
}

function isValidPlayerState(player: Record<string, unknown>, phase: string, carIds: Set<unknown>): boolean {
  if (player.role === "spectator") return player.controller === "none" && player.reclaimPending === false;
  if (phase === "open" || phase === "results") return player.controller === "none" && player.reclaimPending === false;
  const hasCar = carIds.has(player.raceSeatId);
  return hasCar
    ? (player.controller === "human" || player.controller === "bot")
      && (player.reclaimPending === false || player.controller === "bot")
    : player.controller === "none" && player.reclaimPending === false;
}

function isValidConfiguration(value: unknown): value is Record<string, unknown> {
  return validRaceConfiguration(value);
}

function isValidSoloConfiguration(value: unknown): value is Record<string, unknown> {
  return isObject(value)
    && hasExactKeys(value, ["botCount", "botDifficulty"])
    && Number.isSafeInteger(value.botCount) && (value.botCount as number) >= 0
    && (value.botCount as number) <= MAX_CONFIGURED_BOTS
    && (value.botDifficulty === "easy" || value.botDifficulty === "normal" || value.botDifficulty === "hard");
}

function isValidRace(value: unknown, roomConfiguration: Record<string, unknown>): boolean {
  if (!isObject(value) || !hasExactKeys(value, [
    "tick", "status", "track", "configuration", "cars", "seed", "randomState", "powerUpLap",
    "powerUpOpportunities", "hazards", "nextHazardSequence",
  ])) return false;
  if (
    !Number.isSafeInteger(value.tick) || (value.tick as number) < 0
    || (value.status !== "racing" && value.status !== "finished")
    || !isValidConfiguration(value.configuration)
    || ["laps", "rules", "assist", "voltage"].some((key) => (value.configuration as Record<string, unknown>)[key] !== roomConfiguration[key])
    || !isObject(value.track) || !isValidTrack(value.track)
    || !Array.isArray(value.cars) || value.cars.length < 1 || value.cars.length > MAX_RACERS
    || !isUint32(value.seed)
    || !isUint32(value.randomState)
    || !isNonNegativeSafeInteger(value.powerUpLap)
    || !Array.isArray(value.powerUpOpportunities)
    || !Array.isArray(value.hazards)
    || !isNonNegativeSafeInteger(value.nextHazardSequence)
  ) return false;

  if (value.configuration.rules === "trial" && value.hazards.length !== 0) return false;
  const trackLength = value.track.length as number;
  const checkpointCount = (value.track.checkpoints as unknown[]).length;
  const laps = (value.configuration as Record<string, unknown>).laps as number;
  const carIds = new Set<string>();
  if (!value.cars.every((car) => {
    if (!isValidCar(car, trackLength, checkpointCount, laps) || carIds.has(car.id as string)) return false;
    if ((value.configuration as Record<string, unknown>).rules !== undefined && (
      ["shieldCharges", "mineCharges", "travelled", "lastPickupTravel", "lastPickupTick", "bargeTicks", "bargeCooldown"].some((key) => car[key] === undefined)
      || (car.boostCharges as number) > 2 || (car.boostCharges as number) + (car.shieldCharges as number) + (car.mineCharges as number) > 3
      || (car.lastPickupTick as number) > (value.tick as number)
    )) return false;
    carIds.add(car.id as string);
    return true;
  })) return false;
  if (!value.cars.every((car) => {
    const contact = (car as Record<string, unknown>).ordinaryContact;
    return !isObject(contact) || carIds.has(contact.leadingCarId as string);
  })) return false;
  const allCarsDone = value.cars.every((car) => (car as Record<string, unknown>).result !== "racing");
  if ((value.status === "finished") !== allCarsDone) return false;

  const authoredOpportunities = new Map<string, Record<string, unknown>>();
  for (const opportunity of (value.track.powerUpOpportunities ?? []) as Record<string, unknown>[]) {
    authoredOpportunities.set(opportunity.id as string, opportunity);
  }
  const opportunityIds = new Set<string>();
  if (value.powerUpOpportunities.length !== (value.configuration.rules === "trial" ? 0 : authoredOpportunities.size) || !value.powerUpOpportunities.every((opportunity) => {
    if (!isObject(opportunity) || !hasExactKeys(opportunity, ["id", "lane", "effect", "collected",
      ...["progress", "phase", "ticksRemaining"].filter((key) => opportunity[key] !== undefined)])) return false;
    const authored = authoredOpportunities.get(opportunity.id as string);
    if (
      authored === undefined || opportunityIds.has(opportunity.id as string)
      || !isLane(opportunity.lane)
      || !isPowerUpEffect(opportunity.effect)
      || !(authored.allowedEffects as unknown[]).includes(opportunity.effect)
      || typeof opportunity.collected !== "boolean"
    ) return false;
    if ((value.configuration as Record<string, unknown>).rules !== undefined && (
      !isFiniteRange(opportunity.progress, 0, trackLength)
      || !["cooldown", "warning", "active"].includes(String(opportunity.phase))
      || opportunity.collected !== (opportunity.phase === "cooldown")
      || !isPositiveSafeInteger(opportunity.ticksRemaining) || (opportunity.ticksRemaining as number) > 600
      || ![...authoredOpportunities.values()].some((zone) => {
        const delta = Math.abs((opportunity.progress as number) - (zone.progress as number));
        return Math.min(delta, trackLength - delta) <= (zone.spawnRadius as number | undefined ?? Math.min(12, trackLength * 0.08));
      })
    )) return false;
    opportunityIds.add(opportunity.id as string);
    return true;
  })) return false;

  const locations = new Map<string, Record<string, unknown>>();
  for (const location of (value.track.hazardPlacementLocations ?? []) as Record<string, unknown>[]) {
    locations.set(location.id as string, location);
  }
  const hazardIds = new Set<string>();
  return value.hazards.every((hazard) => {
    if (!isObject(hazard) || !hasExactKeys(hazard, ["id", "locationId", "progress", "lane", "phase", "ticksRemaining"])) return false;
    const location = locations.get(hazard.locationId as string);
    return typeof hazard.id === "string" && hazard.id.length > 0 && !hazardIds.has(hazard.id)
      && typeof hazard.locationId === "string" && location !== undefined
      && hazard.progress === location.progress
      && isLane(hazard.lane) && (location.allowedLanes as unknown[]).includes(hazard.lane)
      && (hazard.phase === "warning" || hazard.phase === "active")
      && Number.isSafeInteger(hazard.ticksRemaining) && (hazard.ticksRemaining as number) > 0
      && (hazard.ticksRemaining as number) <= (hazard.phase === "warning"
        ? PROVISIONAL_DURATIONS.hazardWarningTicks
        : PROVISIONAL_DURATIONS.hazardActiveTicks)
      && (hazardIds.add(hazard.id), true);
  });
}

function isValidTrack(value: Record<string, unknown>): boolean {
  const trackKeys = [
    "id", "length", "lanes", "startFinish", "checkpoints",
    "fixedObstacles", "powerUpOpportunities", "hazardPlacementLocations",
    ...(value.corners === undefined ? [] : ["corners"]),
    ...(value.version === undefined ? [] : ["version"]),
  ];
  if (!hasExactKeys(value, trackKeys)) return false;
  if (
    typeof value.id !== "string" || value.id.length === 0
    || !(value.version === undefined || (typeof value.version === "string" && /^\d+\.\d+\.\d+$/u.test(value.version)))
    || !isPositiveFinite(value.length)
    || !Array.isArray(value.lanes) || value.lanes.length !== 4
    || !value.lanes.every((lane, index) => isObject(lane) && hasExactKeys(lane, ["index"]) && lane.index === index)
    || !isFiniteRange(value.startFinish, 0, value.length as number)
    || !Array.isArray(value.checkpoints)
    || !Array.isArray(value.fixedObstacles)
    || !Array.isArray(value.powerUpOpportunities)
    || !Array.isArray(value.hazardPlacementLocations)
  ) return false;

  const length = value.length as number;
  const ids = new Set<string>();
  let previousDistance = 0;
  for (const checkpoint of value.checkpoints) {
    if (!isAuthoredPoint(checkpoint, ["id", "progress"], length, ids)) return false;
    const distance = ((checkpoint.progress as number) - (value.startFinish as number) + length) % length;
    if (distance === 0 || distance <= previousDistance) return false;
    previousDistance = distance;
  }
  for (const obstacle of value.fixedObstacles ?? []) {
    if (!isAuthoredPoint(obstacle, ["id", "progress", "lane"], length, ids) || !isLane(obstacle.lane)) return false;
  }
  for (const opportunity of value.powerUpOpportunities ?? []) {
    if (
      !isAuthoredPoint(opportunity, ["id", "progress", "allowedEffects", ...(opportunity.spawnRadius === undefined ? [] : ["spawnRadius"])], length, ids)
      || !(opportunity.spawnRadius === undefined || isPositiveFinite(opportunity.spawnRadius) && (opportunity.spawnRadius as number) <= length / 4)
      || !Array.isArray(opportunity.allowedEffects) || opportunity.allowedEffects.length === 0
      || new Set(opportunity.allowedEffects).size !== opportunity.allowedEffects.length
      || !opportunity.allowedEffects.every(isPowerUpEffect)
    ) return false;
  }
  for (const location of value.hazardPlacementLocations ?? []) {
    if (
      !isAuthoredPoint(location, ["id", "progress", "allowedLanes"], length, ids)
      || !Array.isArray(location.allowedLanes) || location.allowedLanes.length === 0
      || new Set(location.allowedLanes).size !== location.allowedLanes.length
      || !location.allowedLanes.every(isLane)
    ) return false;
  }
  if (value.corners !== undefined) {
    if (!Array.isArray(value.corners)) return false;
    for (const corner of value.corners) {
      if (
        !isObject(corner) || !hasExactKeys(corner, ["id", "fromProgress", "toProgress", "laneSpeedLimits"])
        || typeof corner.id !== "string" || corner.id.length === 0 || ids.has(corner.id)
        || !isFiniteRange(corner.fromProgress, 0, length)
        || !isFiniteRange(corner.toProgress, 0, length)
        || corner.fromProgress === corner.toProgress
        || !Array.isArray(corner.laneSpeedLimits) || corner.laneSpeedLimits.length !== 4
        || !corner.laneSpeedLimits.every(isPositiveFinite)
      ) return false;
      ids.add(corner.id);
    }
  }
  return true;
}

function isAuthoredPoint(
  value: unknown,
  keys: readonly string[],
  trackLength: number,
  ids: Set<string>,
): value is Record<string, unknown> {
  if (
    !isObject(value) || !hasExactKeys(value, keys)
    || typeof value.id !== "string" || value.id.length === 0 || ids.has(value.id)
    || !isFiniteRange(value.progress, 0, trackLength)
  ) return false;
  ids.add(value.id);
  return true;
}

function isValidCar(
  value: unknown,
  trackLength: number,
  checkpointCount: number,
  laps: number,
): value is Record<string, unknown> {
  if (!isObject(value) || !hasExactKeys(value, [
    "id", "profile", "progress", "speed", "lane", "laneTransition", "ordinaryContact",
    "nextCheckpointIndex", "completedLaps", "finishedAtSeconds", "result",
    "crashRecoveryTicksRemaining", "ghost", "ghostMinimumTicksRemaining",
    "shieldTicksRemaining", "boostTicksRemaining", "boostCharges", "deslotPressure", "drafting",
    "respawnProgress",
    ...["shieldCharges", "mineCharges", "travelled", "lastPickupTravel", "lastPickupTick", "bargeTicks", "bargeCooldown"].filter((key) => value[key] !== undefined),
  ])) return false;
  if (["shieldCharges", "mineCharges"].some((key) => value[key] !== undefined && (!isNonNegativeSafeInteger(value[key]) || (value[key] as number) > 1))
    || value.travelled !== undefined && !isNonNegativeFinite(value.travelled)
    || value.lastPickupTravel !== undefined && (typeof value.lastPickupTravel !== "number" || !Number.isFinite(value.lastPickupTravel) || value.lastPickupTravel < -trackLength || value.lastPickupTravel > (value.travelled as number))
    || value.lastPickupTick !== undefined && (!Number.isSafeInteger(value.lastPickupTick) || (value.lastPickupTick as number) < -300)
    || value.bargeTicks !== undefined && (!isNonNegativeSafeInteger(value.bargeTicks) || (value.bargeTicks as number) > 12)
    || value.bargeCooldown !== undefined && (!isNonNegativeSafeInteger(value.bargeCooldown) || (value.bargeCooldown as number) > 90)) return false;
  const transition = value.laneTransition;
  const contact = value.ordinaryContact;
  const validTransition = transition === null || (
    isObject(transition)
    && hasExactKeys(transition, ["from", "to", "progress", "phase"])
    && isLane(transition.from) && isLane(transition.to) && transition.from === value.lane
    && Math.abs((transition.from as number) - (transition.to as number)) === 1
    && isFiniteRange(transition.progress, 0, 1, true)
    && (transition.phase === "changing" || transition.phase === "returning")
  );
  const validContact = contact === null || (
    isObject(contact)
    && hasExactKeys(contact, ["leadingCarId", "enteredAtTick"])
    && typeof contact.leadingCarId === "string" && contact.leadingCarId.length > 0
    && contact.leadingCarId !== value.id
    && isNonNegativeSafeInteger(contact.enteredAtTick)
  );
  const fixed = value.speed === 0 && transition === null && contact === null;
  const validResult = value.result === "racing"
    ? value.finishedAtSeconds === null && (value.completedLaps as number) < laps
    : value.result === "finished"
      ? isNonNegativeFinite(value.finishedAtSeconds) && (value.completedLaps as number) >= laps && fixed
      : value.result === "dnf" && value.finishedAtSeconds === null && fixed;
  const recovering = (value.crashRecoveryTicksRemaining as number) > 0;
  return typeof value.id === "string" && value.id.length > 0
    && isValidProfile(value.profile)
    && isFiniteRange(value.progress, 0, trackLength)
    && isNonNegativeFinite(value.speed)
    && isLane(value.lane)
    && isNonNegativeSafeInteger(value.nextCheckpointIndex) && (value.nextCheckpointIndex as number) <= checkpointCount
    && isNonNegativeSafeInteger(value.completedLaps)
    && isNonNegativeSafeInteger(value.crashRecoveryTicksRemaining)
    && (value.crashRecoveryTicksRemaining as number) <= PROVISIONAL_DURATIONS.crashRecoveryTicks
    && typeof value.ghost === "boolean"
    && isNonNegativeSafeInteger(value.ghostMinimumTicksRemaining)
    && (value.ghostMinimumTicksRemaining as number) <= PROVISIONAL_DURATIONS.minimumGhostTicks
    && ((value.ghostMinimumTicksRemaining as number) === 0 || value.ghost === true)
    && isNonNegativeSafeInteger(value.shieldTicksRemaining)
    && (value.shieldTicksRemaining as number) <= PROVISIONAL_DURATIONS.shieldTicks
    && isNonNegativeSafeInteger(value.boostTicksRemaining)
    && (value.boostTicksRemaining as number) <= PROVISIONAL_DURATIONS.boostTicks
    && isNonNegativeSafeInteger(value.boostCharges)
    && (value.boostCharges as number) <= PROVISIONAL_POWER_UPS.maximumBoostCharges
    && isFiniteRange(value.deslotPressure, 0, PROVISIONAL_CORNERING.deslotThreshold, true)
    && typeof value.drafting === "boolean"
    && (!recovering || value.drafting === false)
    && isFiniteRange(value.respawnProgress, 0, trackLength)
    && (!recovering || (value.result === "racing" && value.ghost === false && value.ghostMinimumTicksRemaining === 0 && fixed))
    && (!value.ghost || contact === null)
    && validResult && validTransition && validContact;
}

function isValidProfile(value: unknown): boolean {
  return isObject(value)
    && hasExactKeys(value, [
      "accelerationPerSecondSquared", "topSpeedPerSecond", "brakingPerSecondSquared", "laneChangeDurationTicks",
    ])
    && isNonNegativeFinite(value.accelerationPerSecondSquared)
    && isNonNegativeFinite(value.topSpeedPerSecond)
    && isPositiveFinite(value.brakingPerSecondSquared)
    && Number.isSafeInteger(value.laneChangeDurationTicks) && (value.laneChangeDurationTicks as number) > 0;
}

function isLane(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 3;
}

function isPowerUpEffect(value: unknown): boolean {
  return value === "shield" || value === "boost" || value === "hazard";
}

function isNonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isConnectionGeneration(value: unknown): boolean {
  return isPositiveSafeInteger(value) && (value as number) <= MAX_CONNECTION_GENERATION;
}

function isInputSequence(value: unknown): boolean {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= -1);
}

function isRoomCode(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_ROOM_CODE_LENGTH && value.length <= MAX_ROOM_CODE_LENGTH
    && /^[A-Z0-9]+$/u.test(value);
}

function isPlayerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PLAYER_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isRaceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_RACE_ID_LENGTH
    && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isUint32(value: unknown): boolean {
  return isNonNegativeSafeInteger(value) && (value as number) <= 0xffff_ffff;
}

function isPositiveFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteRange(value: unknown, minimum: number, maximum: number, includeMaximum = false): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum
    && (includeMaximum ? value <= maximum : value < maximum);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
