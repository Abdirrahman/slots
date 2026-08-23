import { WORKSHOP_TRACK } from "./authored-track";
import { BOT_DIFFICULTY_PROFILES, botInput } from "./bot";
import {
  COUNTDOWN_TICKS,
  DEFAULT_RACE_LAPS,
  EMPTY_ROOM_EXPIRATION_MS,
  INPUT_LEASE_TICKS,
  MAX_CONFIGURED_BOTS,
  MAX_CONNECTION_GENERATION,
  MAX_LAPS,
  MAX_RACERS,
  MAX_ROOM_CONNECTIONS,
  MAX_RACE_DURATION_TICKS,
  MAX_SPECTATORS,
  POST_FINISH_TIMEOUT_TICKS,
  RECONNECT_RESERVATION_MS,
  SNAPSHOT_INTERVAL_TICKS,
  type SoloRaceConfiguration,
} from "./multiplayer-config";
import type { InputCommand } from "./protocol";
import {
  PROVISIONAL_CAR_PROFILE,
  advanceRace,
  createRace,
  finishRaceWithDnfs,
  type CarInput,
  type CarProfile,
  type LaneChangeDirection,
  type LaneIndex,
  type RaceConfiguration,
  type RaceEvent,
  type RaceInputs,
  type RaceState,
  type Track,
} from "./race";

export type RoomPhase = "open" | "countdown" | "racing" | "results";
export type PlayerRole = "racer" | "spectator";
export type RaceSeatController = "human" | "bot" | "none";

export interface RoomPlayer {
  readonly id: string;
  readonly name: string;
  readonly role: PlayerRole;
  readonly raceSeatId: string | null;
  readonly controller: RaceSeatController;
  readonly reclaimPending: boolean;
  readonly bestTimeEligible: boolean;
  readonly isHost: boolean;
  readonly connected: boolean;
}

export interface ConfiguredBotRaceSeat {
  readonly id: string;
  readonly name: string;
}

export interface RoomConnectionIdentity {
  readonly playerId: string;
  readonly reconnectToken: string;
  readonly connectionGeneration: number;
}

export interface RoomSnapshot {
  readonly roomCode: string;
  readonly phase: RoomPhase;
  readonly stateVersion: number;
  readonly raceId: string | null;
  readonly countdownTicksRemaining: number | null;
  readonly configuration: RaceConfiguration;
  readonly soloConfiguration: SoloRaceConfiguration | null;
  readonly configuredBots: readonly ConfiguredBotRaceSeat[];
  readonly players: readonly RoomPlayer[];
  readonly race: RaceState | null;
  readonly lastProcessedInputSequence: number | null;
  readonly localConnectionGeneration: number | null;
  readonly localRole: PlayerRole | null;
  readonly canControlRace: boolean;
  readonly canStartRace: boolean;
  readonly canRematch: boolean;
}

export interface RoomAdvance {
  readonly snapshotDue: boolean;
  readonly events: readonly RaceEvent[];
}

export interface CreateRoomOptions {
  readonly code: string;
  readonly hostId: string;
  readonly hostName: string;
  readonly track?: Track;
  readonly carProfile?: CarProfile;
  readonly configuration?: RaceConfiguration;
  readonly soloConfiguration?: SoloRaceConfiguration;
  readonly createRaceId?: () => string;
  readonly createReconnectToken?: () => string;
  readonly now?: () => number;
}

interface PlayerRecord {
  readonly id: string;
  readonly name: string;
  role: PlayerRole;
  readonly joinOrder: number;
  connected: boolean;
  connectionGeneration: number;
  reconnectToken: string;
  disconnectedAt: number | null;
}

interface RaceSeatControl {
  controller: RaceSeatController;
  pendingLaneChange: LaneChangeDirection | undefined;
  pendingBoost: boolean;
  lastSequence: number;
  lastInputServerTick: number;
  takeoverPending: boolean;
  reclaimPending: boolean;
  reclaimCheckpointId: string | null;
  reclaimReady: boolean;
  bestTimeEligible: boolean;
}

type InputIntent = Pick<InputCommand, "raceId" | "seq" | "laneChange" | "useBoost">;

export class Room {
  readonly code: string;

  private hostIdValue: string | null;
  private phaseValue: RoomPhase = "open";
  private version = 1;
  private serverTick = 0;
  private countdownRemaining: number | null = null;
  private raceIdValue: string | null = null;
  private raceValue: RaceState | null = null;
  private configurationValue: RaceConfiguration;
  private readonly players = new Map<string, PlayerRecord>();
  private readonly controls = new Map<string, RaceSeatControl>();
  private readonly configuredBots: readonly ConfiguredBotRaceSeat[];
  private readonly soloConfigurationValue: SoloRaceConfiguration | null;
  private readonly issuedRaceIds = new Set<string>();
  private participants: readonly string[] = [];
  private racingTicks = 0;
  private firstFinishTick: number | null = null;
  private emptySince: number | null = null;
  private nextJoinOrder = 0;
  private readonly track: Track;
  private readonly carProfile: CarProfile;
  private readonly raceIdFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly clock: () => number;

  constructor(options: CreateRoomOptions) {
    if (!options.code || !options.hostId || !options.hostName) throw new Error("Room code, Host id, and Host name are required");
    validateConfiguration(options.configuration ?? { laps: DEFAULT_RACE_LAPS });
    if (options.soloConfiguration !== undefined) validateSoloConfiguration(options.soloConfiguration);
    this.code = options.code;
    this.hostIdValue = options.hostId;
    this.track = options.track ?? WORKSHOP_TRACK;
    this.carProfile = options.carProfile ?? PROVISIONAL_CAR_PROFILE;
    this.configurationValue = Object.freeze({ ...(options.configuration ?? { laps: DEFAULT_RACE_LAPS }) });
    this.soloConfigurationValue = options.soloConfiguration === undefined
      ? null
      : Object.freeze({ ...options.soloConfiguration });
    this.configuredBots = this.soloConfigurationValue === null
      ? Object.freeze([])
      : Object.freeze(Array.from({ length: this.soloConfigurationValue.botCount }, (_, index) => Object.freeze({
        id: `configured-bot-${index + 1}`,
        name: `Bot ${index + 1}`,
      })));
    if (this.configuredBots.some((bot) => bot.id === options.hostId)) throw new Error("Configured Bot id conflicts with the Host id");
    this.raceIdFactory = options.createRaceId ?? (() => crypto.randomUUID());
    this.tokenFactory = options.createReconnectToken ?? defaultToken;
    this.clock = options.now ?? Date.now;
    this.players.set(options.hostId, this.newPlayer(options.hostId, options.hostName, "racer"));
  }

  get phase(): RoomPhase { return this.phaseValue; }
  get raceId(): string | null { return this.raceIdValue; }
  get race(): RaceState | null { return this.raceValue; }
  get hostId(): string { return this.hostIdValue ?? ""; }

  connectionIdentity(playerId: string): RoomConnectionIdentity | null {
    const player = this.players.get(playerId);
    return player === undefined ? null : {
      playerId,
      reconnectToken: player.reconnectToken,
      connectionGeneration: player.connectionGeneration,
    };
  }

  isActiveConnection(playerId: string, generation: number): boolean {
    const player = this.players.get(playerId);
    return player?.connected === true && player.connectionGeneration === generation;
  }

  join(playerId: string, name: string): RoomPlayer {
    if (this.soloConfigurationValue !== null) throw new Error("Solo Rooms do not accept joins");
    const existing = this.players.get(playerId);
    if (existing !== undefined) return this.publicPlayer(existing);
    if (!playerId || !name) throw new Error("Player id and guest name are required");
    this.pruneExpiredReservations();
    if (this.connectedCount() >= MAX_ROOM_CONNECTIONS) throw new Error("Room connection limit reached");

    const racerCount = [...this.players.values()].filter((player) => player.role === "racer").length;
    const role: PlayerRole = this.phaseValue === "open" && racerCount < MAX_RACERS ? "racer" : "spectator";
    const roleCount = [...this.players.values()].filter((player) => player.role === role).length;
    if (role === "spectator" && roleCount >= MAX_SPECTATORS) throw new Error("Spectator limit reached");
    const player = this.newPlayer(playerId, name, role);
    this.players.set(playerId, player);
    this.emptySince = null;
    this.version += 1;
    return this.publicPlayer(player);
  }

  reconnect(reconnectToken: string): RoomConnectionIdentity | null {
    this.pruneExpiredReservations();
    const player = [...this.players.values()].find((candidate) => candidate.reconnectToken === reconnectToken);
    if (player === undefined || player.connectionGeneration >= MAX_CONNECTION_GENERATION) return null;
    const replacedActiveHost = player.connected && this.hostIdValue === player.id;
    if (replacedActiveHost) {
      player.connected = false;
      this.transferHost();
    }
    player.connectionGeneration += 1;
    player.reconnectToken = this.issueToken();
    player.connected = true;
    player.disconnectedAt = null;
    this.emptySince = null;

    const control = this.controls.get(player.id);
    if (control !== undefined && this.participants.includes(player.id)) {
      clearControl(control);
      control.lastSequence = -1;
      if (this.phaseValue === "countdown") {
        control.controller = "bot";
        control.bestTimeEligible = false;
        control.reclaimPending = true;
        control.reclaimCheckpointId = null;
      } else if (this.phaseValue === "racing" && this.raceValue !== null) {
        const car = this.raceValue.cars.find((candidate) => candidate.id === player.id);
        control.controller = "bot";
        control.bestTimeEligible = false;
        control.reclaimPending = car?.result === "racing";
        control.reclaimCheckpointId = car === undefined || car.result !== "racing"
          ? null
          : this.raceValue.track.checkpoints[car.nextCheckpointIndex]?.id ?? null;
      }
    }
    if (this.hostIdValue === null) this.transferHost();
    this.version += 1;
    return this.connectionIdentity(player.id);
  }

  configureRace(playerId: string, configuration: RaceConfiguration): boolean {
    if (!this.canHostAct(playerId) || this.phaseValue !== "open") return false;
    validateConfiguration(configuration);
    this.configurationValue = Object.freeze({ ...configuration });
    this.version += 1;
    return true;
  }

  startRace(playerId: string): string | null {
    if (!this.canHostAct(playerId)) return null;
    if (this.phaseValue === "countdown") return this.raceIdValue;
    if (this.phaseValue !== "open") return null;
    this.pruneExpiredReservations();
    this.participants = Object.freeze([...this.players.values()]
      .filter((player) => player.role === "racer" && player.connected)
      .map((player) => player.id)
      .sort(compareIds));
    if (this.soloConfigurationValue === null ? this.participants.length < 2 : this.participants.length !== 1) return null;

    const raceId = this.raceIdValue ?? this.issueRaceId();
    const configuration = Object.freeze({ ...this.configurationValue });
    this.configurationValue = configuration;
    this.raceIdValue = raceId;
    const raceSeats = [...this.participants, ...this.configuredBots.map((bot) => bot.id)].sort(compareIds);
    this.raceValue = createRace({
      track: this.track,
      configuration,
      cars: raceSeats.map((id, index) => ({ id, profile: this.carProfile, lane: index as LaneIndex })),
      seed: hashRaceId(raceId),
    });
    this.controls.clear();
    for (const id of this.participants) this.controls.set(id, newControl(this.serverTick));
    this.racingTicks = 0;
    this.firstFinishTick = null;
    this.countdownRemaining = COUNTDOWN_TICKS;
    this.phaseValue = "countdown";
    this.version += 1;
    return raceId;
  }

  acceptInput(playerId: string, input: InputIntent): boolean;
  acceptInput(playerId: string, generation: number, input: InputIntent): boolean;
  acceptInput(playerId: string, generationOrInput: number | InputIntent, maybeInput?: InputIntent): boolean {
    const generation = typeof generationOrInput === "number" ? generationOrInput : null;
    const input = typeof generationOrInput === "number" ? maybeInput! : generationOrInput;
    if (generation !== null && !this.isActiveConnection(playerId, generation)) return false;
    if ((this.phaseValue !== "countdown" && this.phaseValue !== "racing") || input.raceId !== this.raceIdValue) return false;
    const control = this.controls.get(playerId);
    if (this.players.get(playerId)?.connected !== true || control === undefined || control.controller !== "human"
      || control.reclaimPending || input.seq <= control.lastSequence) return false;
    if (input.laneChange !== undefined) {
      const car = this.raceValue?.cars.find((candidate) => candidate.id === playerId);
      if (car === undefined || car.result !== "racing" || car.crashRecoveryTicksRemaining > 0
        || car.laneTransition !== null || control.pendingLaneChange !== undefined) return false;
      control.pendingLaneChange = input.laneChange;
    }
    if (input.useBoost === true) {
      // A spend is only accepted when the Race can act on it, so a rejected press does not
      // silently consume a charge the Racer still believes they hold.
      const car = this.raceValue?.cars.find((candidate) => candidate.id === playerId);
      if (car === undefined || car.result !== "racing" || car.crashRecoveryTicksRemaining > 0
        || car.ghost || car.boostCharges === 0 || car.boostTicksRemaining > 0) return false;
      control.pendingBoost = true;
    }
    control.lastSequence = input.seq;
    control.lastInputServerTick = this.serverTick;
    this.version += 1;
    return true;
  }

  disconnect(playerId: string, generation?: number): boolean {
    const player = this.players.get(playerId);
    if (player === undefined || !player.connected || (generation !== undefined && player.connectionGeneration !== generation)) return false;
    player.connected = false;
    player.disconnectedAt = this.clock();
    const control = this.controls.get(playerId);
    if (control !== undefined) {
      clearControl(control);
      if (this.participants.includes(playerId) && (this.phaseValue === "countdown" || this.phaseValue === "racing")) {
        control.takeoverPending = true;
      }
    }
    if (this.hostIdValue === playerId) this.transferHost();
    if (this.connectedCount() === 0 && (this.phaseValue === "open" || this.phaseValue === "results")) this.emptySince = this.clock();
    this.version += 1;
    return true;
  }

  rematch(playerId: string, raceId: string): boolean {
    if (!this.canHostAct(playerId) || this.phaseValue !== "results" || raceId !== this.raceIdValue) return false;
    this.phaseValue = "open";
    this.raceIdValue = this.issueRaceId();
    this.raceValue = null;
    this.countdownRemaining = null;
    this.participants = [];
    this.racingTicks = 0;
    this.firstFinishTick = null;
    this.controls.clear();
    this.pruneExpiredReservations();
    this.promoteSpectators();
    this.version += 1;
    return true;
  }

  advance(): RoomAdvance {
    this.serverTick += 1;
    this.pruneExpiredReservations();
    this.applyControllerBoundaries();
    let events: readonly RaceEvent[] = [];

    if (this.phaseValue === "countdown") {
      this.countdownRemaining = Math.max(0, this.countdownRemaining! - 1);
      if (this.countdownRemaining === 0) {
        this.phaseValue = "racing";
        this.countdownRemaining = null;
        for (const control of this.controls.values()) control.lastInputServerTick = this.serverTick;
      }
      this.version += 1;
    } else if (this.phaseValue === "racing") {
      this.racingTicks += 1;
      const inputs: Record<string, CarInput> = {};
      for (const id of this.participants) {
        const control = this.controls.get(id)!;
        if (control.controller === "human" && this.serverTick - control.lastInputServerTick >= INPUT_LEASE_TICKS) {
          clearControl(control);
          control.controller = "bot";
          this.version += 1;
        }
        if (control.controller === "bot") control.bestTimeEligible = false;
        inputs[id] = control.controller === "bot"
          ? botInput(this.raceValue!, id, BOT_DIFFICULTY_PROFILES.normal)
          : {
            ...(control.pendingLaneChange === undefined ? {} : { laneChange: control.pendingLaneChange }),
            ...(control.pendingBoost ? { useBoost: true } : {}),
          };
        control.pendingLaneChange = undefined;
        control.pendingBoost = false;
      }
      if (this.soloConfigurationValue !== null) {
        const profile = BOT_DIFFICULTY_PROFILES[this.soloConfigurationValue.botDifficulty];
        for (const bot of this.configuredBots) inputs[bot.id] = botInput(this.raceValue!, bot.id, profile);
      }

      const advanced = advanceRace(this.raceValue!, inputs as RaceInputs);
      this.raceValue = advanced.state;
      events = advanced.events;
      this.observeReclaimCheckpoints(events);
      if (this.firstFinishTick === null && events.some((event) => event.type === "finish")) this.firstFinishTick = advanced.state.tick;
      const postFinishExpired = this.firstFinishTick !== null
        && advanced.state.tick - this.firstFinishTick >= POST_FINISH_TIMEOUT_TICKS;
      if (advanced.state.status === "finished") this.phaseValue = "results";
      else if (postFinishExpired || this.racingTicks >= MAX_RACE_DURATION_TICKS) {
        this.raceValue = finishRaceWithDnfs(advanced.state);
        this.phaseValue = "results";
      }
      if (this.phaseValue === "results") {
        for (const control of this.controls.values()) {
          clearControl(control);
          control.controller = "none";
          control.reclaimPending = false;
        }
        if (this.connectedCount() === 0) this.emptySince = this.clock();
        if (this.hostIdValue === null || this.players.get(this.hostIdValue)?.role === "spectator") this.transferHost();
      }
      this.version += 1;
    }

    return { snapshotDue: this.serverTick % SNAPSHOT_INTERVAL_TICKS === 0, events };
  }

  isExpired(now = this.clock()): boolean {
    return this.connectedCount() === 0
      && (this.phaseValue === "open" || this.phaseValue === "results")
      && this.emptySince !== null
      && now - this.emptySince >= EMPTY_ROOM_EXPIRATION_MS;
  }

  snapshot(forPlayerId?: string): RoomSnapshot {
    const local = forPlayerId === undefined ? undefined : this.players.get(forPlayerId);
    const control = local === undefined ? undefined : this.controls.get(local.id);
    return {
      roomCode: this.code,
      phase: this.phaseValue,
      stateVersion: this.version,
      raceId: this.raceIdValue,
      countdownTicksRemaining: this.countdownRemaining,
      configuration: this.configurationValue,
      soloConfiguration: this.soloConfigurationValue,
      configuredBots: this.configuredBots,
      players: [...this.players.values()].sort(comparePlayers).map((player) => this.publicPlayer(player)),
      race: this.raceValue,
      lastProcessedInputSequence: control?.lastSequence ?? null,
      localConnectionGeneration: local?.connectionGeneration ?? null,
      localRole: local?.role ?? null,
      canControlRace: control?.controller === "human" && !control.reclaimPending && this.phaseValue === "racing",
      canStartRace: local !== undefined && this.canHostAct(local.id) && this.phaseValue === "open",
      canRematch: local !== undefined && this.canHostAct(local.id) && this.phaseValue === "results",
    };
  }

  private newPlayer(id: string, name: string, role: PlayerRole): PlayerRecord {
    return { id, name, role, joinOrder: this.nextJoinOrder++, connected: true, connectionGeneration: 1,
      reconnectToken: this.issueToken(), disconnectedAt: null };
  }

  private publicPlayer(player: PlayerRecord): RoomPlayer {
    const control = this.controls.get(player.id);
    return Object.freeze({
      id: player.id,
      name: player.name,
      role: player.role,
      raceSeatId: player.role === "racer" ? player.id : null,
      controller: control?.controller ?? "none",
      reclaimPending: control?.reclaimPending ?? false,
      bestTimeEligible: control?.bestTimeEligible ?? false,
      isHost: player.id === this.hostIdValue,
      connected: player.connected,
    });
  }

  private applyControllerBoundaries(): void {
    for (const [id, control] of this.controls) {
      if (control.takeoverPending) {
        clearControl(control);
        control.takeoverPending = false;
        control.controller = "bot";
        control.bestTimeEligible = false;
        this.version += 1;
      }
      if (control.reclaimReady || (control.reclaimPending && control.reclaimCheckpointId === null && this.phaseValue === "racing")) {
        const player = this.players.get(id);
        if (player?.connected) {
          clearControl(control);
          control.controller = "human";
          control.reclaimPending = false;
          control.reclaimCheckpointId = null;
          control.reclaimReady = false;
          control.lastInputServerTick = this.serverTick;
          this.version += 1;
        }
      }
    }
  }

  private observeReclaimCheckpoints(events: readonly RaceEvent[]): void {
    for (const [id, control] of this.controls) {
      if (!control.reclaimPending || control.reclaimCheckpointId === null) continue;
      const car = this.raceValue!.cars.find((candidate) => candidate.id === id);
      if (car?.result !== "racing") {
        control.reclaimPending = false;
        control.reclaimCheckpointId = null;
      } else if (events.some((event) => event.type === "checkpoint" && event.carId === id && event.checkpointId === control.reclaimCheckpointId)) {
        control.reclaimReady = true;
      }
    }
  }

  private transferHost(): void {
    const connected = [...this.players.values()].filter((player) => player.connected).sort(comparePlayers);
    const racers = connected.filter((player) => player.role === "racer");
    if (racers.length > 0) {
      this.hostIdValue = racers[0]!.id;
      return;
    }
    const spectator = connected[0];
    const racerReservations = [...this.players.values()].filter((player) => player.role === "racer").length;
    if (spectator !== undefined && racerReservations < MAX_RACERS
      && (this.phaseValue === "open" || this.phaseValue === "results")) spectator.role = "racer";
    this.hostIdValue = spectator?.id ?? null;
  }

  private canHostAct(playerId: string): boolean {
    const player = this.players.get(playerId);
    return this.hostIdValue === playerId && player?.connected === true && player.role === "racer";
  }

  private promoteSpectators(): void {
    let racers = [...this.players.values()].filter((player) => player.role === "racer").length;
    for (const player of [...this.players.values()].filter((candidate) => candidate.role === "spectator" && candidate.connected).sort(comparePlayers)) {
      if (racers >= MAX_RACERS) break;
      player.role = "racer";
      racers += 1;
    }
  }

  private pruneExpiredReservations(): void {
    const now = this.clock();
    for (const player of [...this.players.values()]) {
      if (player.connected || player.disconnectedAt === null || now - player.disconnectedAt < RECONNECT_RESERVATION_MS) continue;
      player.reconnectToken = "";
      if (this.participants.includes(player.id) && (this.phaseValue === "countdown" || this.phaseValue === "racing" || this.phaseValue === "results")) continue;
      this.players.delete(player.id);
      if (this.hostIdValue === player.id || (this.hostIdValue !== null && this.players.get(this.hostIdValue)?.role === "spectator")) {
        this.transferHost();
      }
      this.version += 1;
    }
  }

  private connectedCount(): number { return [...this.players.values()].filter((player) => player.connected).length; }

  private issueRaceId(): string {
    const raceId = this.raceIdFactory();
    if (!raceId || this.issuedRaceIds.has(raceId)) throw new Error("Race id factory must return a new id");
    this.issuedRaceIds.add(raceId);
    return raceId;
  }

  private issueToken(): string {
    const token = this.tokenFactory();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("Reconnect token factory must return 43 base64url characters");
    if ([...this.players.values()].some((player) => player.reconnectToken === token)) throw new Error("Reconnect token factory must return a unique token");
    return token;
  }
}

function newControl(serverTick: number): RaceSeatControl {
  return { controller: "human", pendingLaneChange: undefined, pendingBoost: false, lastSequence: -1,
    lastInputServerTick: serverTick, takeoverPending: false, reclaimPending: false,
    reclaimCheckpointId: null, reclaimReady: false, bestTimeEligible: true };
}

function clearControl(control: RaceSeatControl): void {
  control.pendingLaneChange = undefined;
  control.pendingBoost = false;
}

function defaultToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 43);
}

function hashRaceId(raceId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < raceId.length; index += 1) hash = Math.imul(hash ^ raceId.charCodeAt(index), 16_777_619);
  return hash >>> 0;
}

function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function comparePlayers(a: PlayerRecord, b: PlayerRecord): number { return a.joinOrder - b.joinOrder || compareIds(a.id, b.id); }

function validateConfiguration(configuration: RaceConfiguration): void {
  if (!Number.isInteger(configuration.laps) || configuration.laps < 1 || configuration.laps > MAX_LAPS) {
    throw new Error(`Race laps must be an integer from 1 to ${MAX_LAPS}`);
  }
}

function validateSoloConfiguration(configuration: SoloRaceConfiguration): void {
  if (!Number.isInteger(configuration.botCount) || configuration.botCount < 1 || configuration.botCount > MAX_CONFIGURED_BOTS) {
    throw new Error(`Solo Bot count must be an integer from 1 to ${MAX_CONFIGURED_BOTS}`);
  }
  if (configuration.botDifficulty !== "easy" && configuration.botDifficulty !== "normal" && configuration.botDifficulty !== "hard") {
    throw new Error("Solo Bot difficulty is invalid");
  }
}
