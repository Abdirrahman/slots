import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { enhanceDiningScene } from "./dining-atmosphere";
import { createRaceVfx } from "./race-vfx";
import { createRaceMap } from "./race-map";
import "./style.css";

import { readGhost, saveGhost, sampleGhost, scoreCupRound, type GhostRun } from "./replay";
import { RaceAudio } from "./audio";
import { DEFAULT_TRACK } from "./authored-track";
import { DEFAULT_CAR_ASSET_ID, DINING_MAP_ASSET, RACING_CAR_ASSETS, isRacingCarAssetId, type RacingCarAsset } from "./racing-assets";
import { bestTimeKey, readBestTime, recordBestTime } from "./best-times";
import { isEditingControl, laneIntentForKey } from "./controls";
import { EventFeedbackConsumer, raceEventInvolvesCar, resultTransitionFeedback, type EventFeedback } from "./feedback";

import {
  acceptSnapshot,
  interpolateSnapshotCar,
  parseServerMessage,
  predictLocalCarPose,
  snapshotAlpha,
  snapshotCarMotion,
  type ServerMessage,
  type ServerSnapshotMessage,
  type SnapshotPair,
} from "./multiplayer-client";
import { LANE_PREDICTION_TIMEOUT_MS } from "./multiplayer-config";
import { PROTOCOL_VERSION } from "./protocol";
import {
  PROVISIONAL_POWER_UPS,
  PROVISIONAL_CORNERING,
  gripLimit,
  type RaceConfiguration,
  type PowerUpOpportunityState,
  TICKS_PER_SECOND,
  TICK_SECONDS,
  type CarState,
  type HazardState,
  type LaneChangeDirection,
  type Track,
} from "./race";
import {
  PROVISIONAL_PRESENTATION,
  chaseCameraPose,
  raceStandings,
  sampleTrackPose,
  selectCameraCarId,
  speedCameraFov,
  type CameraPose,
  type TrackPose,
} from "./presentation";
import {
  buildHazard,
  buildObstacle,
  buildPickup,
  placeOnSurface,
  poseHazard,
  poseOnTrack,
  surfaceOffset,
  warningTexture,
  type PickupView,
} from "./track-view";
import { normalizeVolume, panelVisibility, parseSoloRaceOptions, parseStoredSettings, raceControlsEnabled, serializeSettings } from "./settings";

const canvas = requiredElement("race-canvas", HTMLCanvasElement);
document.body.dataset.phase = "garage";
const raceCallout = requiredElement("race-callout", HTMLElement);
const leaderboard = requiredElement("race-leaderboard", HTMLOListElement);
const cameraButton = requiredElement("camera-button", HTMLButtonElement);
const fullscreenButton = requiredElement("fullscreen-button", HTMLButtonElement);
let cameraMode = 0;
let calloutUntil = 0;
let calloutKey = "";
let lastCountdown = -1;
let eventMessageUntil = 0;
const errorMessage = requiredElement("webgl-error", HTMLElement);
const connectionMessage = requiredElement("connection-message", HTMLElement);
const setupPanel = requiredElement("setup-panel", HTMLElement);
const roomPanel = requiredElement("room-panel", HTMLElement);
const nameInput = requiredElement("guest-name", HTMLInputElement);
const roomInput = requiredElement("room-code-input", HTMLInputElement);
const soloBotCount = requiredElement("solo-bot-count", HTMLSelectElement);
const soloBotDifficulty = requiredElement("solo-bot-difficulty", HTMLSelectElement);
const presetControl = requiredElement("race-preset", HTMLSelectElement);
const voltageControl = requiredElement("race-voltage", HTMLSelectElement);
const lapsControl = requiredElement("race-laps", HTMLSelectElement);
const assistControl = requiredElement("driving-assist", HTMLInputElement);
const rulesDescription = requiredElement("rules-description", HTMLElement);
const soloSummary = requiredElement("solo-summary", HTMLElement);
const startStatus = requiredElement("start-status", HTMLElement);
const startInstructions = requiredElement("start-instructions", HTMLElement);
const drivingInstructions = requiredElement("driving-instructions", HTMLElement);
const cupButton = requiredElement("cup-button", HTMLButtonElement);
const garageButton = requiredElement("garage-button", HTMLButtonElement);
const speedValue = requiredElement("speed-value", HTMLElement);
const gripValue = requiredElement("grip-value", HTMLElement);
const gripMeter = requiredElement("grip-meter", HTMLMeterElement);
const inventoryValue = requiredElement("inventory-value", HTMLElement);
const sectorValue = requiredElement("sector-value", HTMLElement);
const cupValue = requiredElement("cup-value", HTMLElement);
const heldControls = new Set<string>();
let gamepadThrottle = 0, gamepadBrake = false;
let ghostRun: GhostRun | null = null;
let runSamples: [number, number, number][] = [];
let sectorTimes: number[] = [];
let lastSectorAt = 0;
const sectorEvents = new Set<string>();
let cup: { round: number; scores: Record<string, number>; completed: string[] } | null = null;
const soloButton = requiredElement("solo-button", HTMLButtonElement);
const createButton = requiredElement("create-button", HTMLButtonElement);
const joinButton = requiredElement("join-button", HTMLButtonElement);
const startButton = requiredElement("start-button", HTMLButtonElement);
const rematchButton = requiredElement("rematch-button", HTMLButtonElement);
const roomCodeValue = requiredElement("room-code-value", HTMLElement);
const playerList = requiredElement("player-list", HTMLUListElement);
const hostValue = requiredElement("host-value", HTMLElement);
const resultList = requiredElement("result-list", HTMLOListElement);
const lapValue = requiredElement("lap-value", HTMLElement);
const statusValue = requiredElement("status-value", HTMLElement);
const timeValue = requiredElement("time-value", HTMLElement);
const eventMessage = requiredElement("event-message", HTMLElement);
const bestTimeValue = requiredElement("best-time-value", HTMLElement);
const positionValue = requiredElement("position-value", HTMLElement);
const gapAheadValue = requiredElement("gap-ahead-value", HTMLElement);
const gapBehindValue = requiredElement("gap-behind-value", HTMLElement);
const boostMeter = requiredElement("boost-meter", HTMLElement);
const boostValue = requiredElement("boost-value", HTMLElement);
const effectList = requiredElement("effect-list", HTMLUListElement);
const deslotWarning = requiredElement("deslot-warning", HTMLElement);
const settingsButton = requiredElement("settings-button", HTMLButtonElement);
const creditsButton = requiredElement("credits-button", HTMLButtonElement);
const settingsPanel = requiredElement("settings-panel", HTMLElement);
const creditsPanel = requiredElement("credits-panel", HTMLElement);
const muteControl = requiredElement("mute-control", HTMLInputElement);
const volumeControl = requiredElement("volume-control", HTMLInputElement);
const volumeValue = requiredElement("volume-value", HTMLOutputElement);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const garagePanel = requiredElement("garage-panel", HTMLElement);
const carGrid = requiredElement("car-grid", HTMLElement);
const assetStatus = requiredElement("asset-status", HTMLElement);
const assetRetry = requiredElement("asset-retry", HTMLButtonElement);
const CAR_SELECTION_KEY = "slots:selected-car";
let selectedCarAssetId = readLocal(CAR_SELECTION_KEY) ?? DEFAULT_CAR_ASSET_ID;
if (!isRacingCarAssetId(selectedCarAssetId)) selectedCarAssetId = DEFAULT_CAR_ASSET_ID;
let assetsReady = false;
buildGarage();
assetRetry.addEventListener("click", () => location.reload());

const LAST_ROOM_KEY = "slots:last-room";
const SETTINGS_KEY = "slots:settings";
const CAR_PROFILE_ID = "balanced-v1";
const TOKEN_KEY_PREFIX = "slots:reconnect-token:";
const MAX_RECONNECT_ATTEMPTS = 3;
/**
 * Close code for a protocol failure the client detects.
 *
 * The server may close with 1002, but `WebSocket.close` in a browser only accepts 1000 and
 * 4000-4999 and throws for anything else, so a client-side 1002 threw instead of closing and
 * buried the real error.
 */
const PROTOCOL_CLOSE_CODE = 4002;
const RECONNECT_DELAYS_MS = [200, 500, 900] as const;

let sequence = 0;
let snapshots: SnapshotPair | null = null;
let snapshotReceivedAt = performance.now();
let predictedLaneChange: LaneChangeDirection | undefined;
let predictedLaneSequence: number | null = null;
let predictedLaneAt = 0;
let protocolFailure = false;
let reconnectAttempts = 0;
let reconnecting = false;
let pendingSetup = false;
let identity: Extract<ServerMessage, { type: "identity" }> | null = null;
let socket!: WebSocket;
const feedbackConsumer = new EventFeedbackConsumer();
const feedbackQueue: EventFeedback[] = [];
const recordedRaces = new Set<string>();
const pickups = new Map<string, PickupView>();
/** Pickups float above the Track surface, clear of the Cars passing under them. */
const PICKUP_HEIGHT = 0.95;
let openPanel: "closed" | "settings" | "credits" = "closed";
let settings = parseStoredSettings(readLocal(SETTINGS_KEY));
const raceAudio = new RaceAudio(settings);

cameraButton.addEventListener("click", cycleCamera);
function cycleCamera(): void {
  cameraMode = (cameraMode + 1) % 3;
  cameraButton.textContent = ["Chase cam", "Bonnet cam", "Wide cam"][cameraMode]!;
  raceAudio.playMenu();
  if (["countdown", "racing"].includes(document.body.dataset.phase ?? "")) canvas.focus({ preventScroll: true });
}
fullscreenButton.addEventListener("click", () => {
  const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
  void action?.catch(() => { fullscreenButton.title = "Use your browser's fullscreen shortcut"; });
  if (["countdown", "racing"].includes(document.body.dataset.phase ?? "")) canvas.focus({ preventScroll: true });
});
document.addEventListener("fullscreenchange", () => {
  const label = document.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen";
  fullscreenButton.setAttribute("aria-label", label); fullscreenButton.title = label;
  if (["countdown", "racing"].includes(document.body.dataset.phase ?? "")) canvas.focus({ preventScroll: true });
});
for (const control of document.querySelectorAll("button, select, summary")) {
  if (control !== cameraButton) control.addEventListener("click", () => raceAudio.playMenu());
}

muteControl.checked = settings.muted;
volumeControl.value = String(settings.volume);
volumeValue.value = `${Math.round(settings.volume * 100)}%`;
const rememberedRoom = readSession(LAST_ROOM_KEY);
if (rememberedRoom !== null) roomInput.value = rememberedRoom;
connect();
window.setInterval(() => {
  if (canControlRace()) sendInput();
}, 100);

soloButton.addEventListener("click", () => { cup = null; sendSetup("create_solo_race"); });
cupButton.addEventListener("click", () => {
  cup = { round: 0, scores: {}, completed: [] }; voltageControl.value = "3";
  if (presetControl.value === "trial") presetControl.value = "club";
  sendSetup("create_solo_race");
});
garageButton.addEventListener("click", () => { forgetReconnect(); location.reload(); });
function updateRaceOptions(): void {
  const trial = presetControl.value === "trial";
  soloBotCount.disabled = trial; soloBotDifficulty.disabled = trial; cupButton.hidden = trial;
  createButton.hidden = trial;
  rulesDescription.textContent = trial ? "No items, no bots. Race your personal-best ghost; assist and voltage have separate records."
    : presetControl.value === "party" ? "Shared random pickups. Racers over 15% of a lap behind may receive Boost or Shield instead of Mine. Car speed stays unchanged."
    : "Shared random pickups on safe straights. Equal item odds; no pace assistance.";
  soloSummary.textContent = `${lapsControl.value} ${lapsControl.value === "1" ? "lap" : "laps"} · ${trial ? "Time Trial · personal-best ghost" : `${soloBotCount.value} ${soloBotDifficulty.value} opponents`} · ${voltageControl.value}V · ${assistControl.checked ? "automatic throttle" : "manual throttle"}`;
  startInstructions.textContent = assistControl.checked
    ? "The car accelerates and brakes for corners automatically. Use A / D or ← / → to change lanes. Space uses a boost."
    : "Hold W / ↑ to accelerate; S / ↓ brakes. Use A / D or ← / → to change lanes. Space uses a boost.";
}
for (const control of [presetControl, voltageControl, lapsControl, assistControl, soloBotCount, soloBotDifficulty]) control.addEventListener("change", updateRaceOptions);
updateRaceOptions();
createButton.addEventListener("click", () => sendSetup("create_room"));
joinButton.addEventListener("click", () => sendSetup("join_room"));
startButton.addEventListener("click", () => {
  if (assetsReady && snapshots?.current.state.canStartRace === true) send({ type: "start_race" });
});
rematchButton.addEventListener("click", () => {
  void raceAudio.activate();
  const message = snapshots?.current;
  if (assetsReady && message?.state.canRematch === true && message.raceId !== null) {
    if (cup !== null && cup.round < 2) { cup.round += 1; voltageControl.value = String([3, 6, 9][cup.round]); }
    else if (cup !== null) cup = null;
    send({ type: "rematch", raceId: message.raceId, ...(cup === null ? {} : { configuration: selectedConfiguration() }) });
    canvas.focus();
  }
});
settingsButton.addEventListener("click", () => { void raceAudio.activate(); setPanel(panelVisibility(openPanel, "settings")); });
creditsButton.addEventListener("click", () => { void raceAudio.activate(); setPanel(panelVisibility(openPanel, "credits")); });
muteControl.addEventListener("change", updateAudioSettings);
volumeControl.addEventListener("input", updateAudioSettings);
for (const button of [soloButton, cupButton, createButton, joinButton, startButton]) button.addEventListener("click", () => { void raceAudio.activate(); });

const context = canvas.getContext("webgl2", { antialias: true, alpha: false });
if (context === null) showWebGlFailure();
else void startPresentation(context).catch((error: unknown) => {
  assetsReady = false;
  disableNetworkControls();
  assetStatus.hidden = false;
  assetStatus.firstElementChild!.textContent = `Unable to load the race assets. ${error instanceof Error ? error.message : "Please retry."}`;
  assetRetry.hidden = false;
});

function connect(): void {
  sequence = 0;
  identity = null;
  const connection = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = connection;
  updateSetupControls();
  connection.addEventListener("open", () => {
    const roomCode = readSession(LAST_ROOM_KEY);
    const token = roomCode === null ? null : readSession(`${TOKEN_KEY_PREFIX}${roomCode}`);
    if (roomCode !== null && token !== null) {
      reconnecting = true;
      showConnectionMessage("Restoring Room connection…");
      send({ type: "reconnect", roomCode, reconnectToken: token });
    } else {
      reconnecting = false;
      updateSetupControls();
      connectionMessage.hidden = true;
    }
  });
  connection.addEventListener("message", (event) => {
    try {
      receiveServerMessage(parseServerMessage(String(event.data)));
    } catch (error) {
      protocolFailure = true;
      showConnectionMessage(error instanceof Error ? error.message : "Incompatible server protocol");
      connection.close(PROTOCOL_CLOSE_CODE, "Incompatible server protocol");
    }
  });
  connection.addEventListener("close", (event) => {
    if (connection !== socket) return;
    pendingSetup = false;
    disableNetworkControls();
    startStatus.textContent = "Race server disconnected. Reload to try again.";
    clearLocalInput();
    if (protocolFailure || event.code === 1002 || event.code === PROTOCOL_CLOSE_CODE) {
      showConnectionMessage(`Protocol incompatible: ${event.reason || "client and server versions differ"}`);
      return;
    }
    const roomCode = readSession(LAST_ROOM_KEY);
    const token = roomCode === null ? null : readSession(`${TOKEN_KEY_PREFIX}${roomCode}`);
    if (roomCode !== null && token !== null && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = RECONNECT_DELAYS_MS[reconnectAttempts]!;
      reconnectAttempts += 1;
      showConnectionMessage(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})…`);
      window.setTimeout(connect, delay);
      return;
    }
    showConnectionMessage("Connection lost. Create or join a Room when the server is available.");
  });
  connection.addEventListener("error", () => {
    if (connection === socket) showConnectionMessage("Unable to connect to the Room server.");
  });
}

function receiveServerMessage(message: ServerMessage): void {
  if (message.type === "error") {
    pendingSetup = false;
    if (message.code === "invalid_command" && /protocol|version/iu.test(message.message)) {
      protocolFailure = true;
      socket.close(PROTOCOL_CLOSE_CODE, message.message);
      return;
    }
    if (reconnecting) {
      forgetReconnect();
      reconnecting = false;
      snapshots = null;
      document.body.dataset.phase = "garage";
      setupPanel.hidden = false;
      garagePanel.hidden = false;
      roomPanel.hidden = true;
    }
    updateSetupControls();
    showConnectionMessage(message.message);
    return;
  }
  if (message.type === "identity") {
    if (snapshots !== null && (snapshots.current.roomCode !== message.roomCode
      || snapshots.current.localPlayerId !== message.localPlayerId)) snapshots = null;
    identity = message;
    pendingSetup = false;
    reconnecting = false;
    reconnectAttempts = 0;
    writeSession(LAST_ROOM_KEY, message.roomCode);
    writeSession(`${TOKEN_KEY_PREFIX}${message.roomCode}`, message.reconnectToken);
    return;
  }
  if (identity === null || message.roomCode !== identity.roomCode) throw new Error("Malformed server identity state");
  if (message.type === "race_events") {
    if (snapshots?.current.raceId !== message.raceId) return;
    for (const identified of message.events) {
      const event = identified.event;
      if ((event.type !== "checkpoint" && event.type !== "lap") || event.carId !== identity.localPlayerId || sectorEvents.has(identified.id)) continue;
      sectorEvents.add(identified.id);
      const duration = event.timeSeconds - lastSectorAt;
      const previousBest = ghostRun?.sectors[sectorTimes.length];
      const sectorDelta = previousBest === undefined ? null : duration - (previousBest - (ghostRun?.sectors[sectorTimes.length - 1] ?? 0));
      const delta = sectorDelta === null ? "" : ` · ${sectorDelta >= 0 ? "+" : ""}${sectorDelta.toFixed(3)}s vs PB sector`;
      sectorTimes.push(event.timeSeconds); lastSectorAt = event.timeSeconds;
      sectorValue.textContent = `Sector ${sectorTimes.length}: ${duration.toFixed(3)}s${delta}`;
    }
    const feedback = feedbackConsumer.consume(message.raceId, message.events, reducedMotion.matches);
    for (const item of feedback) {
      const event = message.events.find(identified => identified.id === item.eventId)!.event;
      const concernsLocal = raceEventInvolvesCar(event, identity.localPlayerId);
      // Every racer keeps world effects; the driver's audio, text and camera answer to their own race.
      feedbackQueue.push({ ...item, sourceId: "carId" in event ? event.carId : item.sourceId,
        cameraImpulse: concernsLocal ? item.cameraImpulse : 0 });
      if (concernsLocal) {
        if (!document.hidden) raceAudio.play(item.audio);
        eventMessage.textContent = item.announcement;
        eventMessageUntil = performance.now() + 2400;
      }
    }
    return;
  }
  if (message.localPlayerId !== identity.localPlayerId || message.connectionGeneration !== identity.connectionGeneration) {
    throw new Error("Malformed server identity state");
  }
  receiveSnapshot(message);
}

function sendSetup(type: "create_solo_race" | "create_room" | "join_room"): void {
  if (!assetsReady || pendingSetup || socket.readyState !== WebSocket.OPEN) return;
  const name = nameInput.value.trim() || "Player";
  if (type === "create_solo_race") {
    const options = parseSoloRaceOptions(soloBotCount.value, soloBotDifficulty.value);
    if (options === null) {
      soloBotCount.closest("details")!.open = true;
      soloBotCount.focus();
      showConnectionMessage("Choose 1 to 3 Bots and an available difficulty.");
      return;
    }
    pendingSetup = true;
    updateSetupControls();
    send({ type, name, carAssetId: selectedCarAssetId, ...options,
      ...(presetControl.value === "trial" ? { botCount: 0 } : {}), configuration: selectedConfiguration() });
  } else {
    pendingSetup = true;
    updateSetupControls();
    if (type === "create_room") send({ type, name, carAssetId: selectedCarAssetId, configuration: selectedConfiguration() });
    else send({ type, name, carAssetId: selectedCarAssetId, roomCode: roomInput.value.trim().toUpperCase() });
  }
}

function send(payload: Record<string, unknown>): number {
  const sentSequence = sequence++;
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, seq: sentSequence, ...payload }));
  }
  return sentSequence;
}

function sendInput(laneChange?: LaneChangeDirection, useBoost?: true, item?: "useShield" | "useMine" | "barge"): void {
  const raceId = snapshots?.current.raceId;
  if (!canControlRace() || raceId === null || raceId === undefined) return;
  const sent = send({
    type: "input", raceId,
    throttle: heldControls.has("KeyW") || heldControls.has("ArrowUp") ? 1 : gamepadThrottle,
    brake: heldControls.has("KeyS") || heldControls.has("ArrowDown") || gamepadBrake,
    ...(item === undefined ? {} : { [item]: true }),
    ...(laneChange === undefined ? {} : { laneChange }),
    ...(useBoost === undefined ? {} : { useBoost }),
  });
  // Only a change the Room can take *now* is predicted. A press made during a transition, or
  // one made while an earlier press is still unacknowledged, is buffered by the Room and
  // starts a tick or two later; predicting it would move the Car before the Room agrees it
  // may move, and for a reversed second press it would move the Car the wrong way first.
  if (laneChange !== undefined && predictedLaneChange === undefined && localCar()?.laneTransition === null) {
    predictedLaneChange = laneChange;
    predictedLaneSequence = sent;
    predictedLaneAt = performance.now();
  }
}

/**
 * The predicted Lane edge, if it is still worth rendering.
 *
 * The Room advances `lastProcessedInputSequence` only for inputs it accepts, so a Lane edge
 * it rejects is never acknowledged and `receiveSnapshot` never clears it. Without a deadline
 * that leaves the local Car drawn part-way into a Lane it never entered, for the rest of the
 * Race. The prediction is dropped here rather than in the snapshot path because it has to
 * expire on wall-clock time, whether or not snapshots are still arriving.
 */
function livePredictedLaneChange(): LaneChangeDirection | undefined {
  if (predictedLaneChange === undefined) return undefined;
  if (performance.now() - predictedLaneAt > LANE_PREDICTION_TIMEOUT_MS) {
    predictedLaneChange = undefined; predictedLaneSequence = null;
    return undefined;
  }
  return predictedLaneChange;
}

function localCar(): CarState | undefined {
  const message = snapshots?.current;
  if (message === undefined) return undefined;
  return message.state.race?.cars.find((candidate) => candidate.id === message.localPlayerId);
}

function receiveSnapshot(message: ServerSnapshotMessage): void {
  const previous = snapshots?.current;
  snapshots = acceptSnapshot(snapshots, message);
  if (snapshots.current !== message) return;
  snapshotReceivedAt = performance.now();
  const local = message.state.players.find((player) => player.id === message.localPlayerId)!;
  const previousLocal = previous?.state.players.find((player) => player.id === previous.localPlayerId);
  const localCar = message.state.race?.cars.find((car) => car.id === message.localPlayerId);
  const previousCar = previous?.state.race?.cars.find((car) => car.id === previous.localPlayerId);
  const resultFeedback = localCar === undefined ? null : resultTransitionFeedback(previousCar?.result ?? null, localCar.result);
  if (resultFeedback !== null) {
    eventMessage.textContent = resultFeedback;
    eventMessageUntil = performance.now() + 2400;
    feedbackQueue.push({ eventId: `${message.raceId}:result:${localCar!.id}`, announcement: resultFeedback,
      audio: localCar!.result === "finished" ? "finish" : "crash", effect: "banner", cameraImpulse: 0, sourceId: localCar!.id });
  }
  if (message.raceId !== previous?.raceId) {
    runSamples = []; sectorTimes = []; lastSectorAt = 0; sectorEvents.clear();
    eventMessage.textContent = ""; feedbackQueue.length = 0;
    sectorValue.textContent = "Sector times appear at checkpoints";
    ghostRun = localCar === undefined || message.state.race === null || message.state.configuration.rules !== "trial" ? null
      : readGhost({ getItem: readLocal, setItem: writeLocal }, recordKey(message, localCar), message.state.race.track.length);
  }
  if (localCar !== undefined && message.state.race !== null && message.state.phase === "racing" && localCar.result === "racing") {
    const seconds = message.state.race.tick * TICK_SECONDS;
    if (runSamples.length === 0 || seconds - runSamples[runSamples.length - 1]![0] >= 0.1) {
      const lane = localCar.laneTransition === null ? localCar.lane : localCar.laneTransition.from + (localCar.laneTransition.to - localCar.laneTransition.from) * localCar.laneTransition.progress;
      runSamples.push([seconds, localCar.completedLaps * message.state.race.track.length + localCar.progress, lane]);
    }
  }
  if (message.raceId !== null && message.state.phase === "results" && !recordedRaces.has(message.raceId)) {
    recordedRaces.add(message.raceId);
    updateBestTime(message, local, localCar);
    if (message.state.race !== null && localCar?.result === "finished" && local.bestTimeEligible && localCar.finishedAtSeconds !== null
      && message.state.configuration.rules === "trial" && runSamples.length > 1) {
      saveGhost({ getItem: readLocal, setItem: writeLocal }, recordKey(message, localCar), { version: 1, seconds: localCar.finishedAtSeconds,
        length: message.state.race.track.length, samples: [...runSamples, [localCar.finishedAtSeconds, localCar.completedLaps * message.state.race.track.length, localCar.lane]], sectors: sectorTimes });
    }
    if (cup !== null && !cup.completed.includes(message.raceId) && message.state.race !== null) {
      cup.completed.push(message.raceId);
      const places = raceStandings(message.state.race.track, message.state.race.cars);
      const scores = scoreCupRound(places.map((place) => ({ id: place.carId === message.localPlayerId ? "You" : message.state.configuredBots.find((bot) => bot.id === place.carId)?.name ?? "Racer", finished: message.state.race!.cars.find((car) => car.id === place.carId)!.result === "finished" })));
      for (const [name, points] of Object.entries(scores)) cup.scores[name] = (cup.scores[name] ?? 0) + points;
      if (cup.completed.length === 3 && (cup.scores.You ?? 0) > Math.max(0, ...Object.entries(cup.scores).filter(([name]) => name !== "You").map(([, score]) => score))) writeLocal("slots:dining-cup-winner", "1");
    }
  }
  if (previous !== undefined && (previous.connectionGeneration !== message.connectionGeneration
    || previous.state.localRole !== message.state.localRole
    || previous.state.canControlRace && !message.state.canControlRace
    || previousLocal?.controller !== local.controller)) clearLocalInput();
  if (
    predictedLaneSequence !== null
    && message.lastProcessedInputSequence !== null
    && message.lastProcessedInputSequence >= predictedLaneSequence
  ) {
    predictedLaneChange = undefined;
    predictedLaneSequence = null;
  }
  setupPanel.hidden = true;
  garagePanel.hidden = true;
  roomPanel.hidden = false;
  connectionMessage.hidden = true;
  updateUi();
  if (message.state.phase === "countdown" && previous?.state.phase !== "countdown") {
    if (openPanel !== "closed") setPanel("closed");
    focusRace();
  }
  if (message.state.phase === "results" && previous?.state.phase !== "results" && message.state.canRematch) {
    rematchButton.focus({ preventScroll: true });
    rematchButton.scrollIntoView({ block: "nearest" });
  }
}

async function startPresentation(context: WebGL2RenderingContext): Promise<void> {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  } catch {
    showWebGlFailure();
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 220);
  const initialCameraPose = chaseCameraPose(sampleTrackPose(DEFAULT_TRACK, 0, 1.5), null, 0, 0, true);
  camera.position.set(initialCameraPose.x, initialCameraPose.y, initialCameraPose.z);
  camera.lookAt(initialCameraPose.targetX, initialCameraPose.targetY, initialCameraPose.targetZ);
  const [map, carModels] = await Promise.all([loadDiningMap(scene), loadCarModels()]);
  const atmosphere = enhanceDiningScene(scene, map, renderer);
  const vfx = createRaceVfx(scene);
  const drawMap = createRaceMap(requiredElement("minimap", HTMLCanvasElement), DEFAULT_TRACK);
  const renderTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, renderTarget);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), .13, .3, 2.1);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const startLights = [0, 1, 2].map((index) => map.getObjectByName(`start-light-${index}`))
    .filter((light): light is THREE.Mesh => light instanceof THREE.Mesh);
  addTrackContent(scene, DEFAULT_TRACK);
  assetsReady = true;
  assetStatus.hidden = true;
  updateUi();
  updateSetupControls();
  let previewCar: THREE.Group | null = null;
  function updatePreviewCar(): void {
    if (previewCar !== null) { scene.remove(previewCar); disposeCarMaterials(previewCar); }
    const asset = RACING_CAR_ASSETS.find((candidate) => candidate.id === selectedCarAssetId)!;
    previewCar = createCar(asset, carModels.get(asset.id)!);
    placeOnSurface(previewCar, sampleTrackPose(DEFAULT_TRACK, 0, 1), PROVISIONAL_PRESENTATION.trackSurfaceY);
    scene.add(previewCar);
  }
  updatePreviewCar();
  carGrid.addEventListener("change", () => { updatePreviewCar(); void raceAudio.activate().then(() => raceAudio.playMenu()); });
  const cars = new Map<string, THREE.Group>();
  let ghostCar: THREE.Group | null = null;
  let ghostAssetId = "";
  const hazards = new Map<string, THREE.Group>();
  const effects = createEffectPool(scene, 12);
  const presentationPoses = new Map<string, TrackPose>();
  let cameraPose: CameraPose | null = initialCameraPose;
  let followedCameraCarId: string | null = null;
  let previousFrameAt = performance.now();
  let cameraImpulse = 0;
  let cinematicSeconds = 0;

  const driveKey = (code: string, down: boolean, repeat = false): void => {
    if (["KeyW", "ArrowUp", "KeyS", "ArrowDown"].includes(code)) {
      if (down) heldControls.add(code); else heldControls.delete(code);
      sendInput(); return;
    }
    if (!down || repeat || !canUseLaneControls()) return;
    void raceAudio.activate();
    if (code === "Space") { if (canSpendBoost()) sendInput(undefined, true); }
    else if (code === "KeyQ") sendInput(undefined, undefined, "useShield");
    else if (code === "KeyE") sendInput(undefined, undefined, "useMine");
    else if (code === "KeyF") sendInput(undefined, undefined, "barge");
    else { const lane = laneIntentForKey(code, false); if (lane !== undefined) sendInput(lane); }
  };
  const drivingKeys = ["KeyW", "ArrowUp", "KeyS", "ArrowDown", "KeyA", "ArrowLeft", "KeyD", "ArrowRight", "Space", "KeyQ", "KeyE", "KeyF"];
  window.addEventListener("keydown", (event) => {
    if (event.code === "Escape" && openPanel !== "closed") { event.preventDefault(); setPanel("closed"); return; }
    if (event.code === "KeyC" && openPanel === "closed" && !event.repeat && !isEditingControl(event.target instanceof HTMLElement ? event.target : null)) {
      cycleCamera(); return;
    }
    if (isEditingControl(event.target instanceof HTMLElement ? event.target : null) || openPanel !== "closed" || !drivingKeys.includes(event.code)) return;
    event.preventDefault(); driveKey(event.code, true, event.repeat);
  });
  window.addEventListener("keyup", (event) => { driveKey(event.code, false); });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-drive]")) {
    button.addEventListener("pointerdown", (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); driveKey(button.dataset.drive!, true); });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(type, () => driveKey(button.dataset.drive!, false));
  }
  window.addEventListener("blur", () => { heldControls.clear(); gamepadThrottle = 0; gamepadBrake = false; sendInput(); clearLocalInput(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      heldControls.clear(); gamepadThrottle = 0; gamepadBrake = false; sendInput();
      raceAudio.updateEngine(0, 1, false, false, false); raceAudio.setMusic(false);
    } else updateUi();
  });
  let previousGamepadButtons: boolean[] = [];
  const pollGamepad = (): void => {
    const pad = navigator.getGamepads?.()[0];
    gamepadThrottle = pad && document.hasFocus() && openPanel === "closed" ? pad.buttons[7]?.value ?? 0 : 0;
    gamepadBrake = !!pad && document.hasFocus() && openPanel === "closed" && (pad.buttons[6]?.value ?? 0) > 0.2;
    if (!pad || !document.hasFocus() || openPanel !== "closed") { previousGamepadButtons = []; return; }
    for (const [index, code] of [[14, "ArrowLeft"], [15, "ArrowRight"], [0, "Space"], [2, "KeyQ"], [1, "KeyE"], [3, "KeyF"]] as const) {
      if (pad.buttons[index]?.pressed && !previousGamepadButtons[index]) driveKey(code, true);
    }
    previousGamepadButtons = pad.buttons.map((button) => button.pressed);
  };
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(renderFrame);

  function renderFrame(frameAt: number): void {
    const frameSeconds = Math.min(0.1, Math.max(0, (frameAt - previousFrameAt) / 1_000));
    previousFrameAt = frameAt;
    cinematicSeconds += frameSeconds;
    atmosphere.update(cinematicSeconds, reducedMotion.matches);
    pollGamepad();
    const pair = snapshots;
    const race = pair?.current.state.race;
    if (pair !== null && pair !== undefined && race !== null && race !== undefined) {
      if (previewCar !== null) { scene.remove(previewCar); disposeCarMaterials(previewCar); previewCar = null; }
      const elapsed = (performance.now() - snapshotReceivedAt) / 1_000;
      const presentedTick = THREE.MathUtils.lerp(pair.previous?.state.race?.tick ?? race.tick, race.tick, snapshotAlpha(elapsed));
      presentationPoses.clear();
      for (let index = 0; index < race.cars.length; index += 1) {
        const carState = race.cars[index]!;
        let car = cars.get(carState.id);
        if (car === undefined) {
          const selection = pair.current.state.players.find((player) => player.id === carState.id)?.carAssetId;
          const botIndex = pair.current.state.configuredBots.findIndex((bot) => bot.id === carState.id);
          const unusedBodies = RACING_CAR_ASSETS.filter((asset) => !pair.current.state.players.some((player) => player.role === "racer" && player.carAssetId === asset.id));
          const asset = RACING_CAR_ASSETS.find((candidate) => candidate.id === selection)
            ?? (botIndex >= 0 ? unusedBodies[botIndex % unusedBodies.length] : undefined)
            ?? RACING_CAR_ASSETS[index % RACING_CAR_ASSETS.length]!;
          car = createCar(asset, carModels.get(asset.id)!);
          cars.set(carState.id, car);
          scene.add(car);
        }
        // The local Car predicts what it can from the Racer's own input; every other Car is
        // interpolated between snapshots. Which parts of the local Car are safe to predict is
        // `predictLocalCarPose`'s decision, not the render loop's.
        const pose = carState.id === pair.current.localPlayerId && canControlRace()
          ? predictLocalCarPose(pair, carState.id, elapsed, livePredictedLaneChange())
          : interpolateSnapshotCar(pair, carState.id, snapshotAlpha(elapsed));
        if (pose !== null) {
          presentationPoses.set(carState.id, pose);
          car.visible = true;
          const spinning = !reducedMotion.matches && carState.crashRecoveryTicksRemaining > 0;
          const returning = !reducedMotion.matches && carState.laneTransition?.phase === "returning";
          placeOnSurface(
            car,
            pose,
            PROVISIONAL_PRESENTATION.trackSurfaceY,
            spinning ? (presentedTick % 12) * Math.PI / 6 : 0,
            returning ? (carState.laneTransition!.to - carState.laneTransition!.from) * 0.12 : 0,
          );
          const model = car.children[0]!;
          const laneLean = carState.laneTransition === null ? 0
            : (carState.laneTransition.to - carState.laneTransition.from) * Math.sin(carState.laneTransition.progress * Math.PI) * -.09;
          model.rotation.z = reducedMotion.matches ? 0 : laneLean;
          const previousSpeed = pair.previous?.state.race?.cars.find(previous => previous.id === carState.id)?.speed ?? carState.speed;
          const pitch = Math.max(-.025, Math.min(.04, (previousSpeed - carState.speed) * .035));
          model.rotation.x = reducedMotion.matches ? 0 : THREE.MathUtils.lerp(model.rotation.x, pitch, 1 - Math.exp(-12 * frameSeconds));
          updateCarEffects(car, carState, carState.speed < previousSpeed - .01);
          vfx.car(car, carState, frameSeconds, reducedMotion.matches);
          if (!reducedMotion.matches) spinWheels(car, carState.speed, frameSeconds);
        }
      }
      for (const [id, car] of cars) {
        if (race.cars.some((state) => state.id === id)) continue;
        scene.remove(car);
        disposeCarMaterials(car);
        cars.delete(id);
      }
      const ghostPose = ghostRun === null || pair.current.state.configuration.rules !== "trial" || pair.current.state.phase !== "racing" ? null
        : sampleGhost(ghostRun, ((pair.previous?.state.race?.tick ?? race.tick)
          + (race.tick - (pair.previous?.state.race?.tick ?? race.tick)) * snapshotAlpha(elapsed)) * TICK_SECONDS);
      if (ghostPose !== null) {
        const assetId = pair.current.state.players.find((player) => player.id === pair.current.localPlayerId)?.carAssetId ?? DEFAULT_CAR_ASSET_ID;
        if (ghostCar === null || ghostAssetId !== assetId) {
          if (ghostCar !== null) { scene.remove(ghostCar); disposeCarMaterials(ghostCar); }
          ghostCar = createCar(RACING_CAR_ASSETS.find((asset) => asset.id === assetId)!, carModels.get(assetId)!);
          ghostCar.traverse((object) => { if (object instanceof THREE.Mesh) {
            object.castShadow = false;
            for (const material of Array.isArray(object.material) ? object.material : [object.material]) { material.transparent = true; material.opacity = 0.25; material.depthWrite = false; }
          } });
          scene.add(ghostCar); ghostAssetId = assetId;
        }
        ghostCar.visible = true;
        placeOnSurface(ghostCar, sampleTrackPose(race.track, ghostPose.progress, ghostPose.lane), PROVISIONAL_PRESENTATION.trackSurfaceY);
      } else if (ghostCar !== null) ghostCar.visible = false;
      updatePowerUps(race.track, race.powerUpOpportunities, frameAt);
      updateHazards(scene, race.track, hazards, race.hazards);
      updateStartLights(startLights, pair.current.state.phase, pair.current.state.countdownTicksRemaining);
      while (feedbackQueue.length > 0) {
        const feedback = feedbackQueue.shift()!;
        const source = feedback.sourceId === null ? undefined : cars.get(feedback.sourceId) ?? hazards.get(feedback.sourceId);
        const localSource = cars.get(pair.current.localPlayerId) ?? cars.values().next().value;
        triggerEffect(effects, source ?? localSource, feedback, reducedMotion.matches);
        if (source ?? localSource) vfx.burst((source ?? localSource)!, feedback.effect, reducedMotion.matches);
        cameraImpulse = Math.max(cameraImpulse, feedback.cameraImpulse);
      }
      updateEffects(effects, reducedMotion.matches, frameSeconds);
      drawMap(race.cars, pair.current.localPlayerId, presentationPoses);
      const followId = selectCameraCarId(race.cars, pair.current.localPlayerId);
      if (followId !== followedCameraCarId) {
        followedCameraCarId = followId;
        cameraPose = null;
      }
      const followedPose = followId === null ? undefined : presentationPoses.get(followId);
      const followedCar = followId === null ? undefined : race.cars.find((state) => state.id === followId);
      if (followedPose !== undefined) {
        camera.clearViewOffset();
        cameraPose = chaseCameraPose(followedPose, cameraPose, frameSeconds, cameraImpulse, reducedMotion.matches);
        // Speed opens the field of view and adds a small shake. Both are bounded and both are
        // pinned at rest under reduced motion, because the next four Lanes must stay readable.
        const fov = cameraMode === 1 ? 72 : cameraMode === 2 ? 54 : speedCameraFov(
          followedCar?.speed ?? 0,
          followedCar?.profile.topSpeedPerSecond ?? 1,
          reducedMotion.matches,
        );
        if (Math.abs(camera.fov - fov) > 0.01) {
          camera.fov = fov;
          camera.updateProjectionMatrix();
        }
        const shake = reducedMotion.matches
          ? 0
          : (fov - PROVISIONAL_PRESENTATION.cameraFovAtRest)
            / (PROVISIONAL_PRESENTATION.cameraFovAtBoost - PROVISIONAL_PRESENTATION.cameraFovAtRest)
            * PROVISIONAL_PRESENTATION.cameraShake;
        const followedMotion = followId === null ? null : snapshotCarMotion(pair, followId, snapshotAlpha(elapsed));
        const ahead = sampleTrackPose(race.track, (followedMotion?.progress ?? followedCar?.progress ?? 0) + 11, followedPose.lanePosition);
        if (cameraMode === 1) {
          camera.position.copy(surfaceOffset(followedPose, .84));
          camera.position.x += Math.sin(followedPose.heading) * .55;
          camera.position.z += Math.cos(followedPose.heading) * .55;
          camera.lookAt(ahead.x, ahead.y + .65, ahead.z);
        } else if (cameraMode === 2) {
          const amount = reducedMotion.matches ? 1 : 1 - Math.exp(-5 * frameSeconds);
          camera.position.lerp(new THREE.Vector3(
            followedPose.x - Math.sin(followedPose.heading) * 10,
            followedPose.y + 7.5,
            followedPose.z - Math.cos(followedPose.heading) * 10), amount);
          camera.lookAt(followedPose.x + Math.sin(followedPose.heading) * 4, followedPose.y + .35, followedPose.z + Math.cos(followedPose.heading) * 4);
        } else {
          camera.position.set(
            cameraPose.x + Math.sin(frameAt / 41) * shake,
            cameraPose.y + Math.sin(frameAt / 29) * shake,
            cameraPose.z + Math.sin(frameAt / 37) * shake,
          );
          camera.lookAt(
            THREE.MathUtils.lerp(cameraPose.targetX, ahead.x, .65),
            THREE.MathUtils.lerp(cameraPose.targetY, ahead.y + .55, .65),
            THREE.MathUtils.lerp(cameraPose.targetZ, ahead.z, .65));
        }
        raceAudio.updateEngine(followedCar?.speed ?? 0, followedCar?.profile.topSpeedPerSecond ?? 1,
          heldControls.has("KeyS") || heldControls.has("ArrowDown") || gamepadBrake,
          (followedCar?.boostTicksRemaining ?? 0) > 0, !document.hidden && pair.current.state.phase === "racing" && followedCar?.result === "racing" && (followedCar?.crashRecoveryTicksRemaining ?? 0) === 0);
      }
      cameraImpulse *= Math.exp(Math.log(0.88) * frameSeconds * 60);
    } else if (previewCar !== null) {
      const pose = sampleTrackPose(DEFAULT_TRACK, 0, 1);
      const angle = pose.heading + .6 + (reducedMotion.matches ? 0 : Math.sin(cinematicSeconds * .16) * .42);
      camera.fov = 44;
      camera.position.set(pose.x + Math.sin(angle) * 5.9, pose.y + 2.3, pose.z + Math.cos(angle) * 5.9);
      camera.lookAt(pose.x, pose.y + .35, pose.z);
      if (canvas.clientWidth > 760) camera.setViewOffset(canvas.clientWidth, canvas.clientHeight, -canvas.clientWidth * .17, 0, canvas.clientWidth, canvas.clientHeight);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();
      drawMap([], null, presentationPoses);
      raceAudio.updateEngine(0, 1, false, false, false);
    }
    vfx.update(frameSeconds);
    if (raceCallout.textContent && calloutUntil > 0 && frameAt > calloutUntil) {
      raceCallout.textContent = ""; calloutUntil = 0;
    }
    if (eventMessage.textContent && frameAt > eventMessageUntil) eventMessage.textContent = "";
    composer.render(frameSeconds);
    requestAnimationFrame(renderFrame);
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function updateUi(): void {
  const message = snapshots?.current;
  if (message === undefined) return;
  const state = message.state;
  document.body.dataset.phase = state.phase;
  const local = state.players.find((player) => player.id === message.localPlayerId);
  const localCar = state.race?.cars.find((car) => car.id === message.localPlayerId);
  document.body.dataset.boost = String((localCar?.boostTicksRemaining ?? 0) > 0);
  document.body.dataset.risk = String((localCar?.deslotPressure ?? 0) > 0);
  document.body.style.setProperty("--speed", String(Math.min(1, (localCar?.speed ?? 0) / ((localCar?.profile.topSpeedPerSecond ?? 1) * 1.25))));
  updateRaceCallout(state, localCar);
  const ordered = state.race === null ? [] : raceStandings(state.race.track, state.race.cars);
  leaderboard.replaceChildren(...ordered.map((standing) => {
    const item = document.createElement("li");
    item.dataset.local = String(standing.carId === message.localPlayerId);
    const name = state.players.find(player => player.id === standing.carId)?.name
      ?? state.configuredBots.find(bot => bot.id === standing.carId)?.name ?? "Racer";
    const place = document.createElement("b"); place.textContent = String(standing.position).padStart(2, "0");
    const label = document.createElement("span"); label.textContent = standing.carId === message.localPlayerId ? "You" : name;
    const gap = document.createElement("small"); gap.textContent = standing.position === 1 ? "LEADER" : formatGap(standing.gapToLeader, localCar?.speed ?? 0);
    item.append(place, label, gap); return item;
  }));
  roomCodeValue.textContent = state.roomCode;
  const soloSummary = state.soloConfiguration === null
    ? null
    : `${state.soloConfiguration.botCount} ${state.soloConfiguration.botDifficulty[0]!.toUpperCase()}${state.soloConfiguration.botDifficulty.slice(1)} Bot${state.soloConfiguration.botCount === 1 ? "" : "s"}`;
  hostValue.textContent = local === undefined
    ? "Connection identity unavailable"
    : `${local.role === "racer" ? "Racer" : "Spectator"}${local.isHost ? " · You are Host" : ""}${soloSummary === null ? "" : ` · Solo · ${soloSummary}`}`;
  hostValue.textContent += ` · ${state.configuration.rules ?? "Club"} · ${state.configuration.voltage ?? 6}V · ${state.configuration.assist ? "Assist" : "Manual"}`;
  drivingInstructions.textContent = state.configuration.assist
    ? "Automatic throttle on · A / D or ← / → changes lanes · S / ↓ brakes"
    : "Hold W / ↑ to accelerate · S / ↓ brakes · A / D or ← / → changes lanes";
  playerList.replaceChildren(
    ...state.players.map((player) => {
      const item = document.createElement("li");
      const controller = player.controller === "bot" ? "Bot" : player.controller === "human" ? "human" : "no controller";
      const body = RACING_CAR_ASSETS.find((asset) => asset.id === player.carAssetId)?.displayName;
      item.textContent = `${player.name} — ${player.role === "racer" ? "Racer" : "Spectator"}${body === undefined ? "" : ` · ${body}`} · ${controller}`
        + `${player.reclaimPending ? " · reclaim pending" : ""}`
        + ` · ${player.connected ? "connected" : "disconnected"}`
        + `${player.isHost ? " · Host" : ""}`;
      return item;
    }),
    ...state.configuredBots.map((bot) => {
      const item = document.createElement("li");
      item.textContent = `${bot.name} — Configured Bot · ${state.soloConfiguration!.botDifficulty}`;
      return item;
    }),
  );
  const connectedRacers = state.players.filter((player) => player.role === "racer" && player.connected).length;
  const enoughRacers = state.soloConfiguration === null ? connectedRacers >= 2 : connectedRacers === 1;
  startButton.hidden = !state.canStartRace;
  startButton.disabled = !assetsReady || !state.canStartRace || !enoughRacers;
  garageButton.hidden = false;
  garageButton.textContent = state.phase === "racing" || state.phase === "countdown" ? "Leave race" : "Return to garage";
  rematchButton.textContent = cup !== null && cup.round < 2 ? `Next Cup round · ${[3, 6, 9][cup.round + 1]}V` : "Race again";
  cupValue.textContent = cup === null ? "" : `Dining Cup · Round ${cup.round + 1} / 3 · ${Object.entries(cup.scores).sort((a, b) => b[1] - a[1]).map(([name, score]) => `${name}: ${score}`).join(" · ")}${cup.completed.length === 3 ? " · Cup complete" : ""}`;
  rematchButton.hidden = !state.canRematch;
  rematchButton.disabled = !assetsReady || !state.canRematch;
  resultList.hidden = state.phase !== "results";
  resultList.replaceChildren(...[...(state.race?.cars ?? [])]
    .sort((a, b) => (a.finishedAtSeconds ?? Infinity) - (b.finishedAtSeconds ?? Infinity)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((car) => {
      const item = document.createElement("li");
      const name = state.players.find((candidate) => candidate.id === car.id)?.name
        ?? state.configuredBots.find((candidate) => candidate.id === car.id)?.name
        ?? "Racer";
      item.textContent = `${name} — ${car.result === "finished" ? `${car.finishedAtSeconds!.toFixed(3)}s` : "DNF"}`;
      return item;
    }));

  const laps = state.configuration.laps;
  if (state.race?.track.version !== undefined && localCar !== undefined) {
    const key = bestTimeKey({ trackId: state.race.track.id, trackVersion: state.race.track.version, configuration: state.configuration, soloConfiguration: state.soloConfiguration, carProfileId: CAR_PROFILE_ID, carProfile: localCar.profile });
    const best = readBestTime(localStorage, key);
    bestTimeValue.textContent = `Local best: ${best === null ? "—" : `${best.toFixed(3)}s`}`;
  }
  raceAudio.setMusic(!document.hidden && (state.phase === "countdown" || state.phase === "racing"));
  updateRaceMeters(state, localCar);
  lapValue.textContent = `${Math.min((localCar?.completedLaps ?? 0) + 1, laps)} / ${laps}`;
  timeValue.textContent = (localCar?.finishedAtSeconds ?? (state.race?.tick ?? 0) * TICK_SECONDS).toFixed(3);
  statusValue.textContent = local?.role === "spectator"
    ? "Spectating authoritative Race"
    : local?.controller === "bot"
      ? local.reclaimPending ? "Bot driving — control reclaim pending" : "Bot driving"
      : state.phase === "open"
    ? soloSummary !== null ? `Solo ready — ${soloSummary}` : connectedRacers < 2 ? "Waiting for a second Racer" : state.canStartRace ? "Ready — start when set" : "Waiting for Host"
    : state.phase === "countdown"
      ? `Starts in ${Math.max(1, Math.ceil((state.countdownTicksRemaining ?? 0) * TICK_SECONDS))}`
      : state.phase === "racing"
        ? localCar?.crashRecoveryTicksRemaining
          ? `Crashed — recovery ${Math.ceil(localCar.crashRecoveryTicksRemaining * TICK_SECONDS)}s`
          : localCar?.ghost
            ? "Respawn Ghost — clears when space is safe"
            : localCar?.shieldTicksRemaining
              ? "Shield active"
              : localCar?.boostTicksRemaining
                ? "Boost active"
                : localCar?.laneTransition?.phase === "returning"
                  ? "Lane change blocked — returning"
                  : localCar?.ordinaryContact !== null
                    ? "Ordinary collision — constrained behind Racer"
                    : "Go! Race in progress"
        : "Official Results";
  canvas.setAttribute("aria-disabled", String(!assetsReady || !state.canControlRace));
}

function buildGarage(): void {
  if (readLocal("slots:dining-cup-winner") === "1") requiredElement("garage-title", HTMLElement).textContent = "Dining Cup champion.";
  carGrid.replaceChildren(...RACING_CAR_ASSETS.map((asset) => {
    const label = document.createElement("label");
    label.className = "car-choice";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "car-asset";
    radio.value = asset.id;
    radio.checked = asset.id === selectedCarAssetId;
    radio.addEventListener("change", () => {
      selectedCarAssetId = asset.id;
      writeLocal(CAR_SELECTION_KEY, asset.id);
    });
    const image = document.createElement("img");
    image.src = asset.cardPath;
    image.alt = "";
    image.width = 512;
    image.height = 512;
    const name = document.createElement("strong");
    name.textContent = asset.displayName;
    const description = document.createElement("span");
    const handling = ["Balanced acceleration and braking", "Highest speed; slower braking and lane changes", "Fast acceleration and lane changes; lower top speed", "Strong brakes; quick GT pace"][RACING_CAR_ASSETS.indexOf(asset)];
    description.textContent = `${asset.description} · ${handling}`;
    label.append(radio, image, name, description);
    return label;
  }));
}

async function loadDiningMap(scene: THREE.Scene): Promise<THREE.Group> {
  const map = (await new GLTFLoader().loadAsync(DINING_MAP_ASSET.modelPath)).scene;
  if (map.getObjectByName("track-surface") === undefined) throw new Error("Dining map is missing its road surface.");
  map.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = !object.name.startsWith("floor") && !object.name.startsWith("wall");
    object.receiveShadow = true;
  });
  scene.add(map);
  return map;
}

function updateRaceCallout(state: ServerSnapshotMessage["state"], car: CarState | undefined): void {
  let key = "", text = "", detail = "";
  if (state.phase === "countdown") {
    const step = Math.max(1, Math.ceil((state.countdownTicksRemaining ?? 0) * TICK_SECONDS));
    key = `countdown:${step}`; text = String(step); detail = "GET READY";
    if (step !== lastCountdown) { raceAudio.playCountdown(step); lastCountdown = step; }
  } else if (state.phase === "racing" && lastCountdown > 0) {
    lastCountdown = 0; raceAudio.playCountdown(0);
    key = "go"; text = "GO!"; detail = "FULL THROTTLE";
  } else if (state.phase === "results") {
    key = "results"; text = car?.result === "finished" ? "FINISH!" : "RACE OVER"; detail = "DINING TABLE RUN";
  }
  if (key && key !== calloutKey) {
    calloutKey = key;
    raceCallout.textContent = text;
    raceCallout.dataset.detail = detail;
    raceCallout.dataset.kind = key.startsWith("countdown") ? "countdown" : key;
    raceCallout.classList.remove("callout-enter");
    void raceCallout.offsetWidth;
    raceCallout.classList.add("callout-enter");
    calloutUntil = state.phase === "results" ? performance.now() + 2200 : state.phase === "countdown" ? 0 : performance.now() + 1200;
  }
  if (state.phase === "open") { raceCallout.textContent = ""; calloutKey = ""; lastCountdown = -1; }
}

function disposeCarMaterials(car: THREE.Group): void {
  car.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
    // Model geometries are shared by the loaded source and every clone.
    if (object.name.endsWith("-effect")) object.geometry.dispose();
  });
}

/**
 * Race position, the gaps either side, Boost charges and active effects.
 *
 * Gaps are shown in seconds at the Car's own current speed, which is what a Racer is actually
 * asking when they look: how long until I am on them, or they are on me.
 */
function updateRaceMeters(state: ServerSnapshotMessage["state"], localCar: CarState | undefined): void {
  const race = state.race;
  const trial = state.configuration.rules === "trial";
  boostMeter.hidden = trial;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-drive="Space"], [data-drive="KeyQ"], [data-drive="KeyE"], [data-drive="KeyF"]')) button.hidden = trial;
  if (race === null || race === undefined || localCar === undefined) {
    positionValue.textContent = "—";
    gapAheadValue.textContent = "—";
    gapBehindValue.textContent = "—";
    boostValue.textContent = `0 / ${PROVISIONAL_POWER_UPS.maximumBoostCharges}`;
    boostMeter.dataset.charges = "0";
    effectList.replaceChildren();
    deslotWarning.hidden = true;
    return;
  }

  speedValue.textContent = `${Math.round(localCar.speed * 3.6 * PROVISIONAL_PRESENTATION.worldUnitsPerProgress)}`;
  const limit = gripLimit(race, localCar);
  gripMeter.value = Math.min(1, localCar.deslotPressure / PROVISIONAL_CORNERING.deslotThreshold);
  gripValue.textContent = Number.isFinite(limit) ? `${localCar.speed > limit ? "Lift or brake" : "Grip stable"} · corner limit ${limit.toFixed(1)}` : "Straight · prepare your braking point";
  inventoryValue.textContent = trial ? ghostRun === null ? "Clean Time Trial · finish to save your ghost" : "Clean Time Trial · racing your personal-best ghost" : `Space Boost ${localCar.boostCharges}/2 · Q Shield ${localCar.shieldCharges ?? 0} · E Mine ${localCar.mineCharges ?? 0} · F Barge ${localCar.bargeCooldown ? (localCar.bargeCooldown * TICK_SECONDS).toFixed(1) + "s" : "ready during Boost"}`;
  const standings = raceStandings(race.track, race.cars);
  const mine = standings.find((standing) => standing.carId === localCar.id);
  const behind = standings.find((standing) => standing.position === (mine?.position ?? 0) + 1);
  positionValue.textContent = mine === undefined ? "—" : `${mine.position} / ${standings.length}`;
  gapAheadValue.textContent = formatGap(mine?.gapToAhead ?? null, localCar.speed);
  gapBehindValue.textContent = formatGap(behind === undefined ? null : behind.gapToAhead, localCar.speed);

  boostValue.textContent = `${localCar.boostCharges} / ${state.configuration.rules === undefined ? PROVISIONAL_POWER_UPS.maximumBoostCharges : 2}`;
  boostMeter.dataset.charges = String(localCar.boostCharges);

  const effects: [string, string][] = [];
  if (localCar.boostTicksRemaining > 0) effects.push(["boost", `Boost ${(localCar.boostTicksRemaining * TICK_SECONDS).toFixed(1)}s`]);
  if (localCar.shieldTicksRemaining > 0) effects.push(["shield", `Shield ${(localCar.shieldTicksRemaining * TICK_SECONDS).toFixed(1)}s`]);
  if (localCar.drafting) effects.push(["draft", "Slipstream"]);
  if (localCar.ghost) effects.push(["ghost", "Ghost"]);
  effectList.replaceChildren(...effects.map(([kind, label]) => {
    const item = document.createElement("li");
    item.dataset.effect = kind;
    item.textContent = label;
    return item;
  }));

  deslotWarning.hidden = localCar.deslotPressure <= 0;
}

function formatGap(progressGap: number | null, speed: number): string {
  if (progressGap === null || progressGap < 0) return "—";
  if (speed <= 0) return `${progressGap.toFixed(1)}u`;
  return `${(progressGap / speed).toFixed(2)}s`;
}

function clearLocalInput(): void {
  predictedLaneChange = undefined;
  predictedLaneSequence = null;
  predictedLaneAt = 0;
  heldControls.clear(); gamepadThrottle = 0; gamepadBrake = false;
}

function canControlRace(): boolean {
  if (!assetsReady) return false;
  const message = snapshots?.current;
  if (message === undefined || identity === null || socket.readyState !== WebSocket.OPEN
    || message.connectionGeneration !== identity.connectionGeneration || message.state.canControlRace !== true || message.state.localRole !== "racer") return false;
  const local = message.state.players.find((player) => player.id === message.localPlayerId);
  return local !== undefined && raceControlsEnabled({
    localRole: message.state.localRole,
    canControlRace: message.state.canControlRace,
    controller: local.controller,
    reclaimPending: local.reclaimPending,
    connected: local.connected,
  });
}

function canUseLaneControls(): boolean {
  if (!canControlRace()) return false;
  const car = localCar();
  return car?.result === "racing" && car.crashRecoveryTicksRemaining === 0;
}

/** Mirrors the Room's own acceptance rule, so a rejected press never looks like a spend. */
function canSpendBoost(): boolean {
  if (!canUseLaneControls()) return false;
  const car = localCar();
  return car !== undefined && !car.ghost && car.boostCharges > 0 && car.boostTicksRemaining === 0;
}

/** Authored Track content: the fixed obstacles and the pickup markers. */
function addTrackContent(scene: THREE.Scene, track: Track): void {
  for (const obstacle of track.fixedObstacles ?? []) {
    const prop = buildObstacle(obstacle.id);
    poseOnTrack(prop, track, obstacle.progress, obstacle.lane);
    scene.add(prop);
    // Chevrons painted on the Track give a Racer time to change Lane before the obstacle.
    const warning = new THREE.Mesh(
      new THREE.PlaneGeometry(PROVISIONAL_PRESENTATION.laneSpacing * 0.9, 4.2),
      new THREE.MeshStandardMaterial({ map: warningTexture(), roughness: 0.7, side: THREE.DoubleSide }),
    );
    warning.rotation.x = -Math.PI / 2;
    warning.receiveShadow = true;
    const marker = new THREE.Group();
    marker.add(warning);
    poseOnTrack(marker, track, obstacle.progress - 5, obstacle.lane, 0.012);
    scene.add(marker);
  }

  for (const opportunity of track.powerUpOpportunities ?? []) {
    const pickup = buildPickup(opportunity.id);
    pickups.set(opportunity.id, pickup);
    scene.add(pickup.group);
  }
}

async function loadCarModels(): Promise<Map<string, THREE.Group>> {
  const loader = new GLTFLoader();
  const models = await Promise.all(RACING_CAR_ASSETS.map(async (asset) => {
    const model = (await loader.loadAsync(asset.modelPath)).scene;
    model.name = asset.id;
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return [asset.id, model] as const;
  }));
  return new Map(models);
}

function createCar(asset: RacingCarAsset, source: THREE.Group): THREE.Group {
  const car = new THREE.Group();
  car.name = asset.id;
  const model = source.clone(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material.clone();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.envMapIntensity = 1.05;
      if (material.name.includes("paint") || material.name.includes("body")) {
        material.roughness = .26; material.metalness = .35;
      }
    }
  });
  car.add(model);
  const contactShadow = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 2.7), new THREE.MeshBasicMaterial({
    map: carShadowTexture(), transparent: true, opacity: .58, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  contactShadow.name = "contact-shadow-effect";
  contactShadow.rotation.x = -Math.PI / 2; contactShadow.position.y = .018;
  car.add(contactShadow);
  car.userData.wheels = asset.wheelObjects
    .map((name) => model.getObjectByName(name))
    .filter((wheel): wheel is THREE.Object3D => wheel !== undefined);
  car.userData.wheelRadius = asset.wheelRadius;
  const shield = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.08, 8, 24), new THREE.MeshBasicMaterial({ color: 0x75d8ff, transparent: true, opacity: 0.65 }));
  shield.name = "shield-effect";
  shield.rotation.x = Math.PI / 2;
  shield.position.y = 0.45;
  shield.visible = false;
  car.add(shield);
  const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.ShaderMaterial({
    uniforms: { tint: { value: new THREE.Color(0x55dfff) } }, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `varying vec3 vNormal; varying vec3 vPosition;
      void main() { vec4 world = modelMatrix * vec4(position, 1.0); vPosition = world.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * world; }`,
    fragmentShader: `uniform vec3 tint; varying vec3 vNormal; varying vec3 vPosition;
      void main() { float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(cameraPosition - vPosition))), 2.8);
        gl_FragColor = vec4(tint * 1.5, rim * .48); }`,
  }));
  shell.name = "shield-shell-effect";
  shell.scale.set(.8, .62, 1.6); shell.position.y = .4;
  shell.visible = false; car.add(shell);
  const boost = new THREE.Mesh(new THREE.ConeGeometry(.22, 1.15, 12), new THREE.MeshBasicMaterial({
    color: 0x66dfff, transparent: true, opacity: .8, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  boost.name = "boost-effect";
  boost.rotation.x = -Math.PI / 2;
  boost.position.set(0, 0.27, -1.65);
  boost.visible = false;
  car.add(boost);
  return car;
}

let sharedCarShadow: THREE.CanvasTexture | undefined;
function carShadowTexture(): THREE.CanvasTexture {
  if (sharedCarShadow !== undefined) return sharedCarShadow;
  const image = document.createElement("canvas"); image.width = image.height = 64;
  const context = image.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 5, 32, 32, 32);
  gradient.addColorStop(0, "rgba(10,16,22,.95)"); gradient.addColorStop(.55, "rgba(10,16,22,.6)"); gradient.addColorStop(1, "rgba(10,16,22,0)");
  context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
  sharedCarShadow = new THREE.CanvasTexture(image);
  return sharedCarShadow;
}

/**
 * Toy wheels turn with the distance the Car actually covers on the bench.
 *
 * The axle is the wheel's own local X axis and the pipeline seats each wheel's origin on its
 * hub, so this is a spin rather than an orbit. Forward is local `+Z`, so rolling forward
 * carries the top of the wheel toward `+Z`, which is a positive turn about `+X`. The angle
 * is wrapped because it accumulates for the whole Race.
 */
function spinWheels(car: THREE.Group, speedPerSecond: number, frameSeconds: number): void {
  const wheels = car.userData.wheels as THREE.Object3D[] | undefined;
  const radius = car.userData.wheelRadius as number | undefined;
  if (wheels === undefined || radius === undefined || radius <= 0) return;
  const turn = speedPerSecond * PROVISIONAL_PRESENTATION.worldUnitsPerProgress * frameSeconds / radius;
  for (const wheel of wheels) wheel.rotation.x = (wheel.rotation.x + turn) % (Math.PI * 2);
}

function updateCarEffects(car: THREE.Group, state: CarState, braking: boolean): void {
  car.getObjectByName("contact-shadow-effect")!.visible = !state.ghost && state.crashRecoveryTicksRemaining === 0;
  car.getObjectByName("shield-effect")!.visible = state.shieldTicksRemaining > 0;
  car.getObjectByName("shield-shell-effect")!.visible = state.shieldTicksRemaining > 0;
  const boost = car.getObjectByName("boost-effect") as THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  boost.visible = state.boostTicksRemaining > 0;
  boost.scale.setScalar((state.bargeTicks ?? 0) > 0 ? 1.5 : 1);
  boost.scale.y *= reducedMotion.matches ? 1 : 1 + Math.sin(performance.now() * .035) * .2;
  boost.material.color.set((state.bargeTicks ?? 0) > 0 ? 0xfff4c0 : 0x66dfff);
  // The tail lamps are dim by default and come up when the Car is actually losing speed, so
  // a Racer can read a corner lift or a collision ahead of them off the Car in front.
  const deslotting = state.deslotPressure > 0;
  car.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.name.endsWith("-effect")) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial && material.name.endsWith("-taillights")) {
        material.emissiveIntensity = braking ? 3.4 : deslotting ? 2.2 : 0.5;
      }
      material.transparent = state.ghost || state.crashRecoveryTicksRemaining > 0;
      material.opacity = state.crashRecoveryTicksRemaining > 0 ? 0.3 : state.ghost ? 0.48 : 1;
    }
  });
}

function updatePowerUps(
  track: Track,
  opportunities: readonly PowerUpOpportunityState[],
  frameAt: number,
): void {
  for (const opportunity of opportunities) {
    const pickup = pickups.get(opportunity.id);
    const authored = track.powerUpOpportunities?.find((value) => value.id === opportunity.id);
    if (pickup === undefined || authored === undefined) continue;
    pickup.group.visible = !opportunity.collected;
    if (opportunity.collected) continue;
    poseOnTrack(pickup.group, track, opportunity.progress ?? authored.progress, opportunity.lane, PICKUP_HEIGHT);
    const warning = opportunity.phase === "warning";
    pickup.group.scale.setScalar(warning ? 0.65 + (reducedMotion.matches ? 0 : Math.sin(frameAt / 100) * 0.12) : 1);
    for (const [effect, shape] of Object.entries(pickup.shapes)) shape.visible = effect === opportunity.effect;
    if (reducedMotion.matches) continue;
    const shape = pickup.shapes[opportunity.effect];
    shape.rotation.y = frameAt / 620;
    shape.position.y = Math.sin(frameAt / 420) * 0.09;
  }
}

function updateHazards(scene: THREE.Scene, track: Track, groups: Map<string, THREE.Group>, states: readonly HazardState[]): void {
  for (const state of states) {
    let hazard = groups.get(state.id);
    if (hazard === undefined) {
      hazard = buildHazard();
      groups.set(state.id, hazard);
      scene.add(hazard);
    }
    poseHazard(hazard, track, state);
  }
  for (const [id, hazard] of groups) {
    if (states.some((state) => state.id === id)) continue;
    scene.remove(hazard);
    for (const child of hazard.children) {
      const solid = child as THREE.Mesh;
      solid.geometry.dispose();
      (solid.material as THREE.Material).dispose();
    }
    groups.delete(id);
  }
}

/** The gantry counts the Race in, then holds green while the Race runs. */
function updateStartLights(
  lights: readonly THREE.Mesh[],
  phase: string,
  countdownTicksRemaining: number | null,
): void {
  const seconds = Math.ceil((countdownTicksRemaining ?? 0) * TICK_SECONDS);
  for (const [index, light] of lights.entries()) {
    const material = light.material as THREE.MeshStandardMaterial;
    const racing = phase === "racing";
    const lit = racing || (phase === "countdown" && seconds > 0 && index < 4 - seconds);
    material.emissive.setHex(racing ? 0x2ce06a : 0xff2a15);
    material.emissiveIntensity = lit ? 2.4 : 0.12;
  }
}

interface PooledEffect { readonly mesh: THREE.Mesh; ttl: number }

function createEffectPool(scene: THREE.Scene, count: number): PooledEffect[] {
  return Array.from({ length: count }, () => {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 1, 20),
      new THREE.MeshBasicMaterial({ color: 0xffd35a, transparent: true, opacity: 0, side: THREE.DoubleSide }),
    );
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, ttl: 0 };
  });
}

function triggerEffect(pool: PooledEffect[], source: THREE.Object3D | undefined, feedback: EventFeedback, reduced: boolean): void {
  if (source === undefined) return;
  const effect = pool.find((candidate) => candidate.ttl === 0) ?? pool[0]!;
  effect.ttl = reduced ? .33 : .58;
  effect.mesh.visible = true;
  // Effects lie flat on the banked Track surface the Car is standing on.
  effect.mesh.position.copy(source.position);
  effect.mesh.rotation.copy(source.rotation);
  effect.mesh.rotateX(-Math.PI / 2);
  effect.mesh.translateZ(0.18);
  effect.mesh.scale.setScalar(reduced ? 1.2 : 0.5);
  const material = effect.mesh.material as THREE.MeshBasicMaterial;
  material.color.set(effectColor(feedback.effect));
  material.opacity = 0.8;
}

function effectColor(effect: EventFeedback["effect"]): number {
  if (effect === "boost") return 0xffa52f;
  if (effect === "deslot-warning") return 0xff2f6d;
  if (effect === "sparks" || effect.includes("hazard")) return 0xff6138;
  return 0xffd35a;
}

function updateEffects(pool: PooledEffect[], reduced: boolean, frameSeconds: number): void {
  for (const effect of pool) {
    if (effect.ttl === 0) continue;
    effect.ttl = Math.max(0, effect.ttl - frameSeconds);
    if (!reduced) effect.mesh.scale.multiplyScalar(Math.exp(2.64 * frameSeconds));
    (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.8, effect.ttl / .2);
    if (effect.ttl === 0) effect.mesh.visible = false;
  }
}

function setPanel(panel: "closed" | "settings" | "credits"): void {
  const previous = openPanel;
  openPanel = panel;
  if (panel !== "closed") { heldControls.clear(); gamepadThrottle = 0; gamepadBrake = false; sendInput(); }
  settingsPanel.hidden = panel !== "settings";
  creditsPanel.hidden = panel !== "credits";
  settingsButton.setAttribute("aria-expanded", String(panel === "settings"));
  creditsButton.setAttribute("aria-expanded", String(panel === "credits"));
  if (panel === "settings") muteControl.focus();
  if (panel === "credits") creditsPanel.focus();
  if (panel === "closed" && canControlRace()) focusRace();
  else if (panel === "closed") (previous === "credits" ? creditsButton : settingsButton).focus({ preventScroll: true });
}

function focusRace(): void {
  canvas.focus({ preventScroll: true });
  canvas.closest(".race-stage")!.scrollIntoView({ block: "start" });
}

function updateSetupControls(): void {
  const connected = socket.readyState === WebSocket.OPEN;
  const ready = assetsReady && connected && identity === null && !reconnecting && !pendingSetup;
  for (const button of [soloButton, cupButton, createButton, joinButton]) button.disabled = !ready;
  startStatus.textContent = pendingSetup ? "Starting your race…"
    : !assetsReady ? "Loading cars and track…"
    : !connected ? "Connecting to the race server…"
    : reconnecting ? "Restoring your race…"
    : "Ready · no name or room code needed";
  if (snapshots === null) statusValue.textContent = ready ? "Ready to race" : "Preparing race…";
}

function updateAudioSettings(): void {
  settings = { muted: muteControl.checked, volume: normalizeVolume(Number(volumeControl.value)) };
  volumeControl.value = String(settings.volume);
  volumeValue.value = `${Math.round(settings.volume * 100)}%`;
  raceAudio.update(settings);
  writeLocal(SETTINGS_KEY, serializeSettings(settings));
  void raceAudio.activate();
}

function updateBestTime(message: ServerSnapshotMessage, local: ServerSnapshotMessage["state"]["players"][number], localCar: CarState | undefined): void {
  const track = message.state.race?.track;
  if (track?.version === undefined || localCar === undefined) return;
  const identity = { trackId: track.id, trackVersion: track.version, configuration: message.state.configuration, soloConfiguration: message.state.soloConfiguration, carProfileId: CAR_PROFILE_ID, carProfile: localCar.profile };
  const best = recordBestTime(localStorage, identity, {
    role: local.role, result: localCar.result, bestTimeEligible: local.bestTimeEligible,
    finishedAtSeconds: localCar.finishedAtSeconds,
  });
  bestTimeValue.textContent = `Local best: ${best === null ? "—" : `${best.toFixed(3)}s`}`;
}

function showWebGlFailure(): void {
  assetStatus.hidden = true;
  errorMessage.hidden = false;
  canvas.hidden = true;
  statusValue.textContent = "WebGL2 unavailable";
}

function showConnectionMessage(message: string): void {
  connectionMessage.textContent = message;
  connectionMessage.hidden = false;
}

function disableNetworkControls(): void {
  soloButton.disabled = true; cupButton.disabled = true;
  createButton.disabled = true;
  joinButton.disabled = true;
  startButton.disabled = true;
  rematchButton.disabled = true;
}

function readLocal(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeLocal(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* Local settings remain best-effort. */ }
}

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Reconnect remains best-effort when browser storage is unavailable.
  }
}

function forgetReconnect(): void {
  const roomCode = readSession(LAST_ROOM_KEY);
  try {
    if (roomCode !== null) sessionStorage.removeItem(`${TOKEN_KEY_PREFIX}${roomCode}`);
    sessionStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    // Nothing else can be cleared when browser storage is unavailable.
  }
}

function requiredElement<T extends Element>(id: string, constructor: { new (): T }): T {
  const element = document.getElementById(id);
  if (!(element instanceof constructor)) throw new Error(`Missing required element #${id}`);
  return element;
}

function selectedConfiguration(): RaceConfiguration {
  return { laps: Number(lapsControl.value), rules: presetControl.value as "club" | "party" | "trial",
    assist: assistControl.checked, voltage: Number(voltageControl.value) as 3 | 6 | 9 };
}
function recordKey(message: ServerSnapshotMessage, car: CarState): string {
  return bestTimeKey({ trackId: message.state.race!.track.id, trackVersion: message.state.race!.track.version ?? "1.0.0",
    configuration: message.state.configuration, soloConfiguration: message.state.soloConfiguration,
    carProfileId: CAR_PROFILE_ID, carProfile: car.profile });
}
