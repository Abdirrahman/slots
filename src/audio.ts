import type { AudioCue } from "./feedback";
import type { LocalSettings } from "./settings";

/** Breakbeat tempo. Fast enough to carry a Race without outrunning the cue sounds. */
const BEATS_PER_MINUTE = 168;
const STEPS_PER_BAR = 16;
const SECONDS_PER_STEP = 60 / BEATS_PER_MINUTE / 4;
/** How far ahead notes are scheduled, and how often the scheduler wakes to do it. */
const SCHEDULE_AHEAD_SECONDS = 0.24;
const SCHEDULER_INTERVAL_MS = 60;
/** Music sits under the Race cues so a Hazard warning is never buried by a snare. */
const MUSIC_LEVEL = 0.34;

export interface PatternStep {
  readonly kick: boolean;
  readonly snare: boolean;
  readonly hat: boolean;
  readonly hatOpen: boolean;
  /** Semitone offset from the root, or null for a rest. */
  readonly bass: number | null;
  readonly stab: number | null;
}

const ROOT_HZ = 55;
/** A minor-key riff: root, minor third, fifth, minor seventh, and the octave above. */
const BASS_FIGURE = [0, 0, 12, 0, 3, 0, 7, 10];
const STAB_FIGURE = [12, 15, 19, 22, 15, 12, 19, 10];

/**
 * One bar of the pattern, derived rather than stored.
 *
 * Bars cycle through four variations so the loop does not announce itself: the break moves
 * its snare on odd bars and the stabs only answer on the second half of every other bar.
 * Pure and deterministic, so it can be asserted without an AudioContext.
 */
export function breakbeatPattern(bar: number): readonly PatternStep[] {
  const variation = ((bar % 4) + 4) % 4;
  return Array.from({ length: STEPS_PER_BAR }, (_, step): PatternStep => {
    const kick = step === 0 || step === 6 || (variation % 2 === 1 && step === 10) || step === 11;
    const snare = step === 4 || step === 12 || (variation === 3 && step === 14);
    const hat = step % 2 === 1;
    const hatOpen = step === 7 || (variation >= 2 && step === 15);
    const bass = step % 2 === 0 ? BASS_FIGURE[(step / 2 + variation) % BASS_FIGURE.length]! : null;
    const stab = variation % 2 === 1 && step >= 8 && step % 4 === 0
      ? STAB_FIGURE[(step / 4 + variation) % STAB_FIGURE.length]!
      : null;
    return { kick, snare, hat, hatOpen, bass, stab };
  });
}

export function semitonesToHz(semitones: number, root = ROOT_HZ): number {
  return root * 2 ** (semitones / 12);
}

export class RaceAudio {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private settings: LocalSettings;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private bar = 0;
  private wantsMusic = false;

  constructor(settings: LocalSettings) { this.settings = settings; }

  async activate(): Promise<void> {
    if (this.context === null) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = MUSIC_LEVEL;
      this.musicGain.connect(this.gain);
      this.noise = createNoiseBuffer(this.context);
      this.applyGain();
    }
    if (this.context.state === "suspended") await this.context.resume();
    if (this.wantsMusic) this.startScheduler();
  }

  update(settings: LocalSettings): void { this.settings = settings; this.applyGain(); }

  /** The soundtrack runs while a Race is live and stops the moment it is not. */
  setMusic(playing: boolean): void {
    this.wantsMusic = playing;
    if (playing) this.startScheduler();
    else this.stopScheduler();
  }

  play(cue: AudioCue): void {
    const context = this.context;
    const output = this.gain;
    if (context === null || output === null || context.state !== "running" || this.settings.muted) return;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const [frequency, duration, type] = cueShape(cue);
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * 0.72), context.currentTime + duration);
    envelope.gain.setValueAtTime(0.0001, context.currentTime);
    envelope.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.01);
    envelope.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + duration);
    oscillator.connect(envelope).connect(output);
    oscillator.start(); oscillator.stop(context.currentTime + duration);
  }

  private startScheduler(): void {
    const context = this.context;
    if (context === null || this.scheduler !== null || context.state !== "running") return;
    this.nextNoteTime = context.currentTime + 0.06;
    this.step = 0;
    this.bar = 0;
    this.scheduler = setInterval(() => this.schedule(), SCHEDULER_INTERVAL_MS);
  }

  private stopScheduler(): void {
    if (this.scheduler === null) return;
    clearInterval(this.scheduler);
    this.scheduler = null;
  }

  /** Schedules every step that falls inside the lookahead window, then advances the cursor. */
  private schedule(): void {
    const context = this.context;
    if (context === null || context.state !== "running") return;
    while (this.nextNoteTime < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
      if (!this.settings.muted) this.playStep(breakbeatPattern(this.bar)[this.step]!, this.nextNoteTime);
      this.nextNoteTime += SECONDS_PER_STEP;
      this.step += 1;
      if (this.step >= STEPS_PER_BAR) { this.step = 0; this.bar += 1; }
    }
  }

  private playStep(step: PatternStep, at: number): void {
    if (step.kick) this.kick(at);
    if (step.snare) this.snare(at);
    if (step.hat) this.hat(at, step.hatOpen);
    if (step.bass !== null) this.bass(at, step.bass);
    if (step.stab !== null) this.stab(at, step.stab);
  }

  private kick(at: number): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(150, at);
    oscillator.frequency.exponentialRampToValueAtTime(42, at + 0.11);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.9, at + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
    oscillator.connect(envelope).connect(this.musicGain!);
    oscillator.start(at); oscillator.stop(at + 0.26);
  }

  private snare(at: number): void {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    const band = context.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1_900;
    band.Q.value = 0.8;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.5, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
    source.connect(band).connect(envelope).connect(this.musicGain!);
    source.start(at); source.stop(at + 0.18);
  }

  private hat(at: number, open: boolean): void {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    const high = context.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 7_200;
    const envelope = context.createGain();
    const length = open ? 0.16 : 0.045;
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(open ? 0.2 : 0.13, at + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(high).connect(envelope).connect(this.musicGain!);
    source.start(at); source.stop(at + length + 0.01);
  }

  private bass(at: number, semitones: number): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(semitonesToHz(semitones), at);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(420, at);
    filter.frequency.exponentialRampToValueAtTime(140, at + SECONDS_PER_STEP * 1.6);
    filter.Q.value = 6;
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.42, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + SECONDS_PER_STEP * 1.7);
    oscillator.connect(filter).connect(envelope).connect(this.musicGain!);
    oscillator.start(at); oscillator.stop(at + SECONDS_PER_STEP * 1.8);
  }

  private stab(at: number, semitones: number): void {
    const context = this.context!;
    const envelope = context.createGain();
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3_600, at);
    filter.frequency.exponentialRampToValueAtTime(700, at + 0.22);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.16, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    // Two detuned saws give the stab width without a second oscillator bank.
    for (const detune of [-7, 7]) {
      const oscillator = context.createOscillator();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(semitonesToHz(semitones), at);
      oscillator.detune.setValueAtTime(detune, at);
      oscillator.connect(filter);
      oscillator.start(at); oscillator.stop(at + 0.32);
    }
    filter.connect(envelope).connect(this.musicGain!);
  }

  private applyGain(): void {
    if (this.gain !== null) this.gain.gain.value = this.settings.muted ? 0 : this.settings.volume;
  }
}

/** One second of deterministic white noise, reused by every percussion voice. */
function createNoiseBuffer(context: AudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const channel = buffer.getChannelData(0);
  let seed = 0x2f6e2b1;
  for (let index = 0; index < channel.length; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    channel[index] = (seed / 0xffff_ffff) * 2 - 1;
  }
  return buffer;
}

function cueShape(cue: AudioCue): readonly [number, number, OscillatorType] {
  if (cue === "finish" || cue === "lap") return [660, 0.28, "triangle"];
  if (cue === "crash" || cue === "impact" || cue === "hazard-hit") return [95, 0.22, "sawtooth"];
  if (cue === "boost") return [420, 0.3, "square"];
  if (cue === "deslot-warning") return [240, 0.26, "sawtooth"];
  if (cue === "pickup" || cue === "shield" || cue === "respawn") return [520, 0.16, "sine"];
  if (cue.startsWith("hazard")) return [180, 0.14, "square"];
  return [300, 0.1, "triangle"];
}
