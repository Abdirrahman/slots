import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import "./style.css";

import { RaceAudio } from "./audio";
import { TOY_CAR_ASSETS } from "./car-assets";
import { WORKSHOP_TRACK } from "./authored-track";
import { bestTimeKey, readBestTime, recordBestTime } from "./best-times";
import { boostIntentForKey, isBoostControlKey, isEditingControl, isLaneControlKey, laneIntentForKey } from "./controls";
import { EventFeedbackConsumer, resultTransitionFeedback, type EventFeedback } from "./feedback";

import {
  acceptSnapshot,
  interpolateSnapshotCar,
  parseServerMessage,
  predictLocalCarPose,
  snapshotAlpha,
  type ServerMessage,
  type ServerSnapshotMessage,
  type SnapshotPair,
} from "./multiplayer-client";
import { INPUT_LEASE_TICKS } from "./multiplayer-config";
import { PROTOCOL_VERSION } from "./protocol";
import {
  PROVISIONAL_POWER_UPS,
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
  buildTrackView,
  placeOnSurface,
  poseHazard,
  poseOnTrack,
  surfaceOffset,
  warningTexture,
  type PickupView,
} from "./track-view";
import { buildWorkshop } from "./workshop-scenery";
import { normalizeVolume, panelVisibility, parseSoloRaceOptions, parseStoredSettings, raceControlsEnabled, serializeSettings } from "./settings";

const canvas = requiredElement("race-canvas", HTMLCanvasElement);
const errorMessage = requiredElement("webgl-error", HTMLElement);
const connectionMessage = requiredElement("connection-message", HTMLElement);
const setupPanel = requiredElement("setup-panel", HTMLElement);
const roomPanel = requiredElement("room-panel", HTMLElement);
const nameInput = requiredElement("guest-name", HTMLInputElement);
const roomInput = requiredElement("room-code-input", HTMLInputElement);
const soloBotCount = requiredElement("solo-bot-count", HTMLSelectElement);
const soloBotDifficulty = requiredElement("solo-bot-difficulty", HTMLSelectElement);
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
let protocolFailure = false;
let reconnectAttempts = 0;
let reconnecting = false;
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

muteControl.checked = settings.muted;
volumeControl.value = String(settings.volume);
volumeValue.value = `${Math.round(settings.volume * 100)}%`;
const rememberedRoom = readSession(LAST_ROOM_KEY);
if (rememberedRoom !== null) roomInput.value = rememberedRoom;
connect();
window.setInterval(() => {
  if (canControlRace()) sendInput();
}, (INPUT_LEASE_TICKS / TICKS_PER_SECOND) * 500);

soloButton.addEventListener("click", () => sendSetup("create_solo_race"));
createButton.addEventListener("click", () => sendSetup("create_room"));
joinButton.addEventListener("click", () => sendSetup("join_room"));
startButton.addEventListener("click", () => {
  if (snapshots?.current.state.canStartRace === true) send({ type: "start_race" });
});
rematchButton.addEventListener("click", () => {
  void raceAudio.activate();
  const message = snapshots?.current;
  if (message?.state.canRematch === true && message.raceId !== null) send({ type: "rematch", raceId: message.raceId });
});
settingsButton.addEventListener("click", () => { void raceAudio.activate(); setPanel(panelVisibility(openPanel, "settings")); });
creditsButton.addEventListener("click", () => { void raceAudio.activate(); setPanel(panelVisibility(openPanel, "credits")); });
muteControl.addEventListener("change", updateAudioSettings);
volumeControl.addEventListener("input", updateAudioSettings);
for (const button of [soloButton, createButton, joinButton, startButton]) button.addEventListener("click", () => { void raceAudio.activate(); });

const context = canvas.getContext("webgl2", { antialias: true, alpha: false });
if (context === null) showWebGlFailure();
else void startPresentation(context);

function connect(): void {
  sequence = 0;
  identity = null;
  const connection = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = connection;
  connection.addEventListener("open", () => {
    const roomCode = readSession(LAST_ROOM_KEY);
    const token = roomCode === null ? null : readSession(`${TOKEN_KEY_PREFIX}${roomCode}`);
    if (roomCode !== null && token !== null) {
      reconnecting = true;
      showConnectionMessage("Restoring Room connection…");
      send({ type: "reconnect", roomCode, reconnectToken: token });
    } else {
      reconnecting = false;
      soloButton.disabled = false;
      createButton.disabled = false;
      joinButton.disabled = false;
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
    disableNetworkControls();
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
    if (message.code === "invalid_command" && /protocol|version/iu.test(message.message)) {
      protocolFailure = true;
      socket.close(PROTOCOL_CLOSE_CODE, message.message);
      return;
    }
    if (reconnecting) {
      forgetReconnect();
      reconnecting = false;
      snapshots = null;
      setupPanel.hidden = false;
      roomPanel.hidden = true;
      soloButton.disabled = false;
      createButton.disabled = false;
      joinButton.disabled = false;
    }
    showConnectionMessage(message.message);
    return;
  }
  if (message.type === "identity") {
    if (snapshots !== null && (snapshots.current.roomCode !== message.roomCode
      || snapshots.current.localPlayerId !== message.localPlayerId)) snapshots = null;
    identity = message;
    reconnecting = false;
    reconnectAttempts = 0;
    writeSession(LAST_ROOM_KEY, message.roomCode);
    writeSession(`${TOKEN_KEY_PREFIX}${message.roomCode}`, message.reconnectToken);
    return;
  }
  if (identity === null || message.roomCode !== identity.roomCode) throw new Error("Malformed server identity state");
  if (message.type === "race_events") {
    if (snapshots?.current.raceId !== message.raceId) return;
    const feedback = feedbackConsumer.consume(message.raceId, message.events, reducedMotion.matches);
    for (const item of feedback) {
      feedbackQueue.push(item);
      raceAudio.play(item.audio);
      eventMessage.textContent = item.announcement;
    }
    return;
  }
  if (message.localPlayerId !== identity.localPlayerId || message.connectionGeneration !== identity.connectionGeneration) {
    throw new Error("Malformed server identity state");
  }
  receiveSnapshot(message);
}

function sendSetup(type: "create_solo_race" | "create_room" | "join_room"): void {
  const name = nameInput.value.trim();
  if (name.length === 0) {
    nameInput.focus();
    showConnectionMessage("Enter a guest name.");
    return;
  }
  if (type === "create_solo_race") {
    const options = parseSoloRaceOptions(soloBotCount.value, soloBotDifficulty.value);
    if (options === null) {
      soloBotCount.focus();
      showConnectionMessage("Choose 1 to 3 Bots and an available difficulty.");
      return;
    }
    send({ type, name, ...options });
  } else if (type === "create_room") send({ type, name });
  else send({ type, name, roomCode: roomInput.value.trim().toUpperCase() });
}

function send(payload: Record<string, unknown>): number {
  const sentSequence = sequence++;
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, seq: sentSequence, ...payload }));
  }
  return sentSequence;
}

function sendInput(laneChange?: LaneChangeDirection, useBoost?: true): void {
  const raceId = snapshots?.current.raceId;
  if (!canControlRace() || raceId === null || raceId === undefined) return;
  const sent = send({
    type: "input", raceId,
    ...(laneChange === undefined ? {} : { laneChange }),
    ...(useBoost === undefined ? {} : { useBoost }),
  });
  if (laneChange !== undefined) {
    predictedLaneChange = laneChange;
    predictedLaneSequence = sent;
  }
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
    raceAudio.play(localCar!.result === "finished" ? "finish" : "crash");
    feedbackQueue.push({ eventId: `${message.raceId}:result:${localCar!.id}`, announcement: resultFeedback,
      audio: localCar!.result === "finished" ? "finish" : "crash", effect: "banner", cameraImpulse: 0, sourceId: localCar!.id });
  }
  if (message.raceId !== null && message.state.phase === "results" && !recordedRaces.has(message.raceId)) {
    recordedRaces.add(message.raceId);
    updateBestTime(message, local, localCar);
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
  roomPanel.hidden = false;
  connectionMessage.hidden = true;
  updateUi();
}

async function startPresentation(context: WebGL2RenderingContext): Promise<void> {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, context, antialias: true });
  } catch {
    showWebGlFailure();
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 220);
  const initialCameraPose = chaseCameraPose(sampleTrackPose(WORKSHOP_TRACK, 0, 1.5), null, 0, 0, true);
  camera.position.set(initialCameraPose.x, initialCameraPose.y, initialCameraPose.z);
  camera.lookAt(initialCameraPose.targetX, initialCameraPose.targetY, initialCameraPose.targetZ);
  buildWorkshop(scene);
  const trackView = buildTrackView(WORKSHOP_TRACK);
  scene.add(trackView.group);
  addTrackContent(scene, WORKSHOP_TRACK);
  const carModels = await loadCarModels();
  const cars = new Map<string, THREE.Group>();
  const hazards = new Map<string, THREE.Group>();
  const effects = createEffectPool(scene, 12);
  const presentationPoses = new Map<string, TrackPose>();
  const previousSpeeds = new Map<string, number>();
  let cameraPose: CameraPose | null = initialCameraPose;
  let followedCameraCarId: string | null = null;
  let previousFrameAt = performance.now();
  let cameraImpulse = 0;

  window.addEventListener("keydown", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isEditingControl(target)) return;
    if (isBoostControlKey(event.code)) {
      if (!canUseLaneControls()) return;
      event.preventDefault();
      if (boostIntentForKey(event.code, event.repeat) === undefined || !canSpendBoost()) return;
      void raceAudio.activate();
      sendInput(undefined, true);
      return;
    }
    if (!isLaneControlKey(event.code) || !canUseLaneControls()) return;
    event.preventDefault();
    const laneChange = laneIntentForKey(event.code, event.repeat);
    if (laneChange === undefined || !canSendLaneIntent()) return;
    void raceAudio.activate();
    sendInput(laneChange);
  });
  window.addEventListener("blur", clearLocalInput);
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(renderFrame);

  function renderFrame(frameAt: number): void {
    const frameSeconds = Math.min(0.1, Math.max(0, (frameAt - previousFrameAt) / 1_000));
    previousFrameAt = frameAt;
    const pair = snapshots;
    const race = pair?.current.state.race;
    if (pair !== null && pair !== undefined && race !== null && race !== undefined) {
      const elapsed = (performance.now() - snapshotReceivedAt) / 1_000;
      presentationPoses.clear();
      for (let index = 0; index < race.cars.length; index += 1) {
        const carState = race.cars[index]!;
        let car = cars.get(carState.id);
        if (car === undefined) {
          car = createCar(index, carModels);
          cars.set(carState.id, car);
          scene.add(car);
        }
        const pose = carState.id === pair.current.localPlayerId
          && canControlRace()
          && carState.ordinaryContact === null
          && race.track.fixedObstacles?.length === 0
          && race.track.powerUpOpportunities?.length === 0
          && race.hazards.length === 0
          ? predictLocalCarPose(race, carState.id, elapsed, predictedLaneChange)
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
            spinning ? (race.tick % 12) * Math.PI / 6 : 0,
            returning ? (carState.laneTransition!.to - carState.laneTransition!.from) * 0.12 : 0,
          );
          car.scale.z = !reducedMotion.matches && carState.ordinaryContact !== null ? 0.88 : 1;
          const wasAt = previousSpeeds.get(carState.id);
          updateCarEffects(car, carState, wasAt !== undefined && carState.speed < wasAt - 0.01);
          previousSpeeds.set(carState.id, carState.speed);
          if (!reducedMotion.matches) spinWheels(car, carState.speed, frameSeconds);
        }
      }
      for (const [id, car] of cars) car.visible = race.cars.some((state) => state.id === id);
      updatePowerUps(race.track, race.powerUpOpportunities, frameAt);
      updateHazards(scene, race.track, hazards, race.hazards);
      updateStartLights(trackView.startLights, pair.current.state.phase, pair.current.state.countdownTicksRemaining);
      while (feedbackQueue.length > 0) {
        const feedback = feedbackQueue.shift()!;
        const source = feedback.sourceId === null ? undefined : cars.get(feedback.sourceId) ?? hazards.get(feedback.sourceId);
        const localSource = cars.get(pair.current.localPlayerId) ?? cars.values().next().value;
        triggerEffect(effects, source ?? localSource, feedback, reducedMotion.matches);
        cameraImpulse = Math.max(cameraImpulse, feedback.cameraImpulse);
      }
      updateEffects(effects, reducedMotion.matches);
      const followId = selectCameraCarId(race.cars, pair.current.localPlayerId);
      if (followId !== followedCameraCarId) {
        followedCameraCarId = followId;
        cameraPose = null;
      }
      const followedPose = followId === null ? undefined : presentationPoses.get(followId);
      const followedCar = followId === null ? undefined : race.cars.find((state) => state.id === followId);
      if (followedPose !== undefined) {
        cameraPose = chaseCameraPose(followedPose, cameraPose, frameSeconds, cameraImpulse, reducedMotion.matches);
        // Speed opens the field of view and adds a small shake. Both are bounded and both are
        // pinned at rest under reduced motion, because the next four Lanes must stay readable.
        const fov = speedCameraFov(
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
        camera.position.set(
          cameraPose.x + Math.sin(frameAt / 41) * shake,
          cameraPose.y + Math.sin(frameAt / 29) * shake,
          cameraPose.z + Math.sin(frameAt / 37) * shake,
        );
        camera.lookAt(cameraPose.targetX, cameraPose.targetY, cameraPose.targetZ);
      }
      cameraImpulse *= Math.exp(Math.log(0.88) * frameSeconds * 60);
    }
    renderer.render(scene, camera);
    requestAnimationFrame(renderFrame);
  }

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function updateUi(): void {
  const message = snapshots?.current;
  if (message === undefined) return;
  const state = message.state;
  const local = state.players.find((player) => player.id === message.localPlayerId);
  const localCar = state.race?.cars.find((car) => car.id === message.localPlayerId);
  roomCodeValue.textContent = state.roomCode;
  const soloSummary = state.soloConfiguration === null
    ? null
    : `${state.soloConfiguration.botCount} ${state.soloConfiguration.botDifficulty[0]!.toUpperCase()}${state.soloConfiguration.botDifficulty.slice(1)} Bot${state.soloConfiguration.botCount === 1 ? "" : "s"}`;
  hostValue.textContent = local === undefined
    ? "Connection identity unavailable"
    : `${local.role === "racer" ? "Racer" : "Spectator"}${local.isHost ? " · You are Host" : ""}${soloSummary === null ? "" : ` · Solo · ${soloSummary}`}`;
  playerList.replaceChildren(
    ...state.players.map((player) => {
      const item = document.createElement("li");
      const controller = player.controller === "bot" ? "Bot" : player.controller === "human" ? "human" : "no controller";
      item.textContent = `${player.name} — ${player.role === "racer" ? "Racer" : "Spectator"} · ${controller}`
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
  startButton.disabled = !state.canStartRace || !enoughRacers;
  rematchButton.hidden = !state.canRematch;
  rematchButton.disabled = !state.canRematch;
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
  raceAudio.setMusic(state.phase === "countdown" || state.phase === "racing");
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
                    : "Authoritative Race live"
        : "Official Results";
  canvas.setAttribute("aria-disabled", String(!state.canControlRace));
}

/**
 * Race position, the gaps either side, Boost charges and active effects.
 *
 * Gaps are shown in seconds at the Car's own current speed, which is what a Racer is actually
 * asking when they look: how long until I am on them, or they are on me.
 */
function updateRaceMeters(state: ServerSnapshotMessage["state"], localCar: CarState | undefined): void {
  const race = state.race;
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

  const standings = raceStandings(race.track, race.cars);
  const mine = standings.find((standing) => standing.carId === localCar.id);
  const behind = standings.find((standing) => standing.position === (mine?.position ?? 0) + 1);
  positionValue.textContent = mine === undefined ? "—" : `${mine.position} / ${standings.length}`;
  gapAheadValue.textContent = formatGap(mine?.gapToAhead ?? null, localCar.speed);
  gapBehindValue.textContent = formatGap(behind === undefined ? null : behind.gapToAhead, localCar.speed);

  boostValue.textContent = `${localCar.boostCharges} / ${PROVISIONAL_POWER_UPS.maximumBoostCharges}`;
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
  if (progressGap === null) return "—";
  if (speed <= 0) return `${progressGap.toFixed(1)}u`;
  return `${(progressGap / speed).toFixed(2)}s`;
}

function clearLocalInput(): void {
  predictedLaneChange = undefined;
  predictedLaneSequence = null;
}

function canControlRace(): boolean {
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
  const message = snapshots!.current;
  const car = message.state.race?.cars.find((candidate) => candidate.id === message.localPlayerId);
  return car?.result === "racing" && car.crashRecoveryTicksRemaining === 0;
}

function canSendLaneIntent(): boolean {
  if (!canUseLaneControls()) return false;
  const message = snapshots!.current;
  return message.state.race?.cars.find((candidate) => candidate.id === message.localPlayerId)?.laneTransition === null;
}

/** Mirrors the Room's own acceptance rule, so a rejected press never looks like a spend. */
function canSpendBoost(): boolean {
  if (!canUseLaneControls()) return false;
  const message = snapshots!.current;
  const car = message.state.race?.cars.find((candidate) => candidate.id === message.localPlayerId);
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

async function loadCarModels(): Promise<THREE.Group[]> {
  const loader = new GLTFLoader();
  return Promise.all(TOY_CAR_ASSETS.map(async (asset) => {
    const model = (await loader.loadAsync(asset.modelPath)).scene;
    model.name = asset.id;
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return model;
  }));
}

function createCar(index: number, models: readonly THREE.Group[]): THREE.Group {
  const car = new THREE.Group();
  const asset = TOY_CAR_ASSETS[index % TOY_CAR_ASSETS.length]!;
  const model = models[index % models.length]!.clone(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map((material) => material.clone())
      : object.material.clone();
  });
  car.add(model);
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
  const boost = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.2, 8), new THREE.MeshBasicMaterial({ color: 0xffa52f }));
  boost.name = "boost-effect";
  boost.rotation.x = -Math.PI / 2;
  boost.position.set(0, 0.35, -1.45);
  boost.visible = false;
  car.add(boost);
  return car;
}

/** Toy wheels turn with the distance the Car actually covers on the bench. */
function spinWheels(car: THREE.Group, speedPerSecond: number, frameSeconds: number): void {
  const wheels = car.userData.wheels as THREE.Object3D[] | undefined;
  const radius = car.userData.wheelRadius as number | undefined;
  if (wheels === undefined || radius === undefined || radius <= 0) return;
  const turn = speedPerSecond * PROVISIONAL_PRESENTATION.worldUnitsPerProgress * frameSeconds / radius;
  for (const wheel of wheels) wheel.rotation.x -= turn;
}

function updateCarEffects(car: THREE.Group, state: CarState, braking: boolean): void {
  car.getObjectByName("shield-effect")!.visible = state.shieldTicksRemaining > 0;
  car.getObjectByName("boost-effect")!.visible = state.boostTicksRemaining > 0;
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
  opportunities: readonly { readonly id: string; readonly lane: number; readonly effect: "boost" | "shield" | "hazard"; readonly collected: boolean }[],
  frameAt: number,
): void {
  for (const opportunity of opportunities) {
    const pickup = pickups.get(opportunity.id);
    const authored = track.powerUpOpportunities?.find((value) => value.id === opportunity.id);
    if (pickup === undefined || authored === undefined) continue;
    pickup.group.visible = !opportunity.collected;
    if (opportunity.collected) continue;
    poseOnTrack(pickup.group, track, authored.progress, opportunity.lane, PICKUP_HEIGHT);
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
  effect.ttl = reduced ? 20 : 35;
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

function updateEffects(pool: PooledEffect[], reduced: boolean): void {
  for (const effect of pool) {
    if (effect.ttl === 0) continue;
    effect.ttl -= 1;
    if (!reduced) effect.mesh.scale.multiplyScalar(1.045);
    (effect.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(0.8, effect.ttl / 12);
    if (effect.ttl === 0) effect.mesh.visible = false;
  }
}

function setPanel(panel: "closed" | "settings" | "credits"): void {
  openPanel = panel;
  settingsPanel.hidden = panel !== "settings";
  creditsPanel.hidden = panel !== "credits";
  settingsButton.setAttribute("aria-expanded", String(panel === "settings"));
  creditsButton.setAttribute("aria-expanded", String(panel === "credits"));
  if (panel === "settings") muteControl.focus();
  if (panel === "credits") creditsPanel.focus();
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
  errorMessage.hidden = false;
  canvas.hidden = true;
  statusValue.textContent = "WebGL2 unavailable";
}

function showConnectionMessage(message: string): void {
  connectionMessage.textContent = message;
  connectionMessage.hidden = false;
}

function disableNetworkControls(): void {
  soloButton.disabled = true;
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

