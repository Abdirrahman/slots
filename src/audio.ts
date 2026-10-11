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
const MUSIC_LEVEL = 0.26;

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
  private engineGain: GainNode | null = null;
  private motor: OscillatorNode | null = null;
  private whine: OscillatorNode | null = null;
  private motorFilter: BiquadFilterNode | null = null;
  private motorGain: GainNode | null = null;
  private whineGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;
  private windGain: GainNode | null = null;
  private roadGain: GainNode | null = null;
  private brakeGain: GainNode | null = null;
  private roadSource: AudioBufferSourceNode | null = null;
  private speedRatio = 0;
  private braking = false;
  private boosting = false;
  private racing = false;
  private lastEngineUpdate = -Infinity;
  private noise: AudioBuffer | null = null;
  private settings: LocalSettings;
  private scheduler: ReturnType<typeof setInterval> | null = null;
  private nextNoteTime = 0;
  private step = 0;
  private bar = 0;
  private wantsMusic = false;
  private pattern = breakbeatPattern(0);
  private lastWarningAt = -Infinity;
  private lastContactAt = -Infinity;

  constructor(settings: LocalSettings) { this.settings = settings; }

  async activate(): Promise<void> {
    if (this.context === null) {
      if (typeof AudioContext === "undefined") return;
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      const limiter = this.context.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.knee.value = 18;
      limiter.ratio.value = 4;
      limiter.attack.value = 0.004;
      limiter.release.value = 0.18;
      this.gain.connect(limiter).connect(this.context.destination);
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.gain);
      this.noise = createNoiseBuffer(this.context);
      this.createEngine();
      this.applyGain();
    }
    if (this.context.state === "suspended") {
      try { await this.context.resume(); } catch { return; }
    }
    this.lastEngineUpdate = -Infinity;
    this.refreshEngine();
    if (this.wantsMusic) this.startScheduler();
  }

  update(settings: LocalSettings): void { this.settings = settings; this.applyGain(); }
  setSettings(settings: LocalSettings): void { this.update(settings); }

  /** Persistent voices are retuned, never recreated, in the render loop. */
  updateEngine(speed: number, topSpeed: number, braking: boolean, boosting: boolean, racing: boolean): void {
    this.speedRatio = Number.isFinite(speed) && Number.isFinite(topSpeed) && topSpeed > 0
      ? Math.min(1.4, Math.max(0, speed / topSpeed)) : 0;
    if (this.racing !== racing || this.braking !== braking || this.boosting !== boosting) this.lastEngineUpdate = -Infinity;
    this.braking = braking;
    this.boosting = boosting;
    this.racing = racing;
    this.refreshEngine();
  }

  /** The soundtrack runs while a Race is live and stops the moment it is not. */
  setMusic(playing: boolean): void {
    if (this.wantsMusic === playing) return;
    this.wantsMusic = playing;
    if (playing) this.startScheduler();
    else this.stopScheduler();
    if (this.context !== null && this.musicGain !== null) {
      this.musicGain.gain.cancelScheduledValues(this.context.currentTime);
      this.musicGain.gain.setTargetAtTime(playing ? MUSIC_LEVEL : 0, this.context.currentTime, 0.08);
    }
  }

  play(cue: AudioCue): void {
    const context = this.context;
    const output = this.gain;
    if (context === null || output === null || context.state !== "running" || this.settings.muted) return;
    const at = context.currentTime;
    if (cue === "deslot-warning" || cue === "hazard-warning") {
      if (at - this.lastWarningAt < 0.42) return;
      this.lastWarningAt = at;
    }
    if (cue === "collision" || cue === "blocked") {
      if (at - this.lastContactAt < 0.09) return;
      this.lastContactAt = at;
    }
    if (cue === "finish") {
      for (const [index, note] of [0, 7, 12, 16, 19, 24].entries()) {
        const hz = semitonesToHz(note, 261.63);
        this.tone(hz, hz, at + index * 0.095, index === 5 ? 0.62 : 0.2, 0.11, "triangle");
      }
    } else if (cue === "lap") {
      this.tone(659.25, 659.25, at, 0.14, 0.13, "triangle");
      this.tone(987.77, 987.77, at + 0.12, 0.3, 0.11, "triangle");
    } else if (cue === "crash" || cue === "impact" || cue === "hazard-hit") {
      this.tone(cue === "impact" ? 130 : 92, 35, at, 0.24, 0.23, "triangle");
      this.noiseBurst(at, 0.27, 0.18, 1_050, "lowpass");
      this.noiseBurst(at + 0.035, 0.13, 0.09, 4_000, "highpass");
    } else if (cue === "collision" || cue === "blocked") {
      this.tone(170, 60, at, 0.09, 0.13, "triangle");
      this.noiseBurst(at, 0.055, 0.07, 1_400, "lowpass");
    } else if (cue === "boost") {
      this.tone(180, 980, at, 0.38, 0.12, "triangle");
      this.noiseBurst(at, 0.42, 0.075, 2_800, "bandpass");
    } else if (cue === "deslot-warning" || cue === "hazard-warning") {
      const hz = cue === "deslot-warning" ? 540 : 392;
      this.tone(hz, hz * 0.88, at, 0.09, 0.1, "triangle");
      this.tone(hz, hz * 0.88, at + 0.14, 0.1, 0.08, "triangle");
    } else if (cue === "pickup" || cue === "shield" || cue === "respawn") {
      const hz = cue === "shield" ? 587.33 : cue === "respawn" ? 392 : 783.99;
      this.tone(hz, hz, at, 0.16, 0.11);
      this.tone(hz * 1.5, hz * 1.5, at + 0.08, 0.26, 0.08);
    } else if (cue === "hazard-active") {
      this.tone(220, 110, at, 0.17, 0.075, "triangle");
    } else if (cue === "checkpoint") {
      this.tone(1_046.5, 1_568, at, 0.075, 0.045);
    } else {
      this.tone(440, 330, at, 0.1, 0.045);
    }
  }

  /** Countdown uses 3, 2, 1; zero is the green-light chord. Call once per change. */
  playCountdown(step: number): void {
    const context = this.context;
    if (context === null || context.state !== "running" || this.settings.muted) return;
    const at = context.currentTime;
    if (step > 0) this.tone(523.25, 523.25, at, 0.16, 0.14, "triangle");
    else {
      this.tone(1_046.5, 1_046.5, at, 0.4, 0.15, "triangle");
      this.tone(1_318.51, 1_318.51, at, 0.36, 0.07);
    }
  }

  playMenu(): void {
    if (this.context === null || this.context.state !== "running" || this.settings.muted) return;
    this.tone(880, 1_176, this.context.currentTime, 0.055, 0.055, "triangle");
  }

  dispose(): void {
    this.stopScheduler();
    this.motor?.stop();
    this.whine?.stop();
    this.roadSource?.stop();
    this.gain?.disconnect();
    if (this.context !== null) void this.context.close().catch(() => undefined);
    this.context = null;
    this.gain = null;
    this.musicGain = null;
    this.engineGain = null;
    this.motor = null;
    this.whine = null;
    this.motorFilter = null;
    this.motorGain = null;
    this.whineGain = null;
    this.windFilter = null;
    this.windGain = null;
    this.roadGain = null;
    this.brakeGain = null;
    this.roadSource = null;
    this.noise = null;
    this.lastWarningAt = -Infinity;
    this.lastContactAt = -Infinity;
  }

  private createEngine(): void {
    const context = this.context!;
    this.engineGain = context.createGain();
    this.engineGain.gain.value = 0;
    this.engineGain.connect(this.gain!);
    this.motorFilter = context.createBiquadFilter();
    this.motorFilter.type = "lowpass";
    this.motorFilter.frequency.value = 1_800;
    this.motorFilter.Q.value = 0.6;
    this.motorFilter.connect(this.engineGain);
    this.motor = context.createOscillator();
    this.motor.type = "sawtooth";
    this.motor.frequency.value = 80;
    this.motorGain = context.createGain();
    this.motorGain.gain.value = 0;
    this.motor.connect(this.motorGain).connect(this.motorFilter);
    this.whine = context.createOscillator();
    this.whine.type = "triangle";
    this.whine.frequency.value = 240;
    this.whineGain = context.createGain();
    this.whineGain.gain.value = 0;
    this.whine.connect(this.whineGain).connect(this.motorFilter);
    this.roadSource = context.createBufferSource();
    this.roadSource.buffer = this.noise;
    this.roadSource.loop = true;
    this.windFilter = context.createBiquadFilter();
    this.windFilter.type = "lowpass";
    this.windFilter.frequency.value = 1_800;
    const windHigh = context.createBiquadFilter();
    windHigh.type = "highpass";
    windHigh.frequency.value = 650;
    this.windGain = context.createGain();
    this.windGain.gain.value = 0;
    this.roadSource.connect(windHigh).connect(this.windFilter).connect(this.windGain).connect(this.engineGain);
    const roadFilter = context.createBiquadFilter();
    roadFilter.type = "bandpass";
    roadFilter.frequency.value = 280;
    roadFilter.Q.value = 0.7;
    this.roadGain = context.createGain();
    this.roadGain.gain.value = 0;
    this.roadSource.connect(roadFilter).connect(this.roadGain).connect(this.engineGain);
    const brakeFilter = context.createBiquadFilter();
    brakeFilter.type = "bandpass";
    brakeFilter.frequency.value = 2_200;
    brakeFilter.Q.value = 0.7;
    this.brakeGain = context.createGain();
    this.brakeGain.gain.value = 0;
    this.roadSource.connect(brakeFilter).connect(this.brakeGain).connect(this.engineGain);
    this.motor.start();
    this.whine.start();
    this.roadSource.start();
  }

  private refreshEngine(): void {
    const context = this.context;
    if (context === null || context.state !== "running" || this.engineGain === null) return;
    const at = context.currentTime;
    // AudioParam interpolation supplies the motion between updates; 30 Hz keeps the graph lean.
    if (at - this.lastEngineUpdate < 1 / 30) return;
    this.lastEngineUpdate = at;
    const speed = this.speedRatio;
    const boost = this.boosting ? 1 : 0;
    this.engineGain.gain.setTargetAtTime(this.racing ? 1 : 0, at, this.racing ? 0.12 : 0.055);
    this.motor!.frequency.setTargetAtTime(78 + speed * 310 + boost * 44, at, 0.065);
    this.whine!.frequency.setTargetAtTime(230 + speed * 1_120 + boost * 170, at, 0.09);
    this.motorGain!.gain.setTargetAtTime(0.022 + speed * 0.024, at, 0.07);
    this.whineGain!.gain.setTargetAtTime(0.008 + speed * 0.02 + boost * 0.008, at, 0.07);
    this.motorFilter!.frequency.setTargetAtTime(1_000 + speed * 2_400, at, 0.08);
    this.windFilter!.frequency.setTargetAtTime(1_200 + speed * 2_100, at, 0.1);
    this.windGain!.gain.setTargetAtTime(speed * speed * 0.075 + boost * 0.02, at, 0.1);
    this.roadGain!.gain.setTargetAtTime(speed * 0.045, at, 0.08);
    this.brakeGain!.gain.setTargetAtTime(this.braking ? Math.min(1, speed) * 0.075 : 0, at, 0.04);
  }

  private tone(frequency: number, endFrequency: number, at: number, duration: number, level: number, type: OscillatorType = "sine"): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, at + duration);
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(level, at + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(envelope).connect(this.gain!);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
    oscillator.start(at); oscillator.stop(at + duration + 0.01);
  }

  private noiseBurst(at: number, duration: number, level: number, frequency: number, type: BiquadFilterType): void {
    const context = this.context!;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = frequency;
    filter.Q.value = 0.6;
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(level, at + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(filter).connect(envelope).connect(this.gain!);
    source.onended = () => { source.disconnect(); filter.disconnect(); envelope.disconnect(); };
    source.start(at); source.stop(at + duration + 0.01);
  }

  private startScheduler(): void {
    const context = this.context;
    if (context === null || this.scheduler !== null || context.state !== "running") return;
    this.nextNoteTime = context.currentTime + 0.06;
    this.step = 0;
    this.bar = 0;
    this.pattern = breakbeatPattern(0);
    this.musicGain!.gain.setTargetAtTime(MUSIC_LEVEL, context.currentTime, 0.08);
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
    // A backgrounded tab resumes on the next downbeat instead of replaying missed notes.
    if (this.nextNoteTime < context.currentTime - 0.2) {
      this.nextNoteTime = context.currentTime + 0.03;
      this.step = 0;
    }
    while (this.nextNoteTime < context.currentTime + SCHEDULE_AHEAD_SECONDS) {
      if (!this.settings.muted) this.playStep(this.pattern[this.step]!, this.nextNoteTime);
      this.nextNoteTime += SECONDS_PER_STEP;
      this.step += 1;
      if (this.step >= STEPS_PER_BAR) { this.step = 0; this.bar += 1; this.pattern = breakbeatPattern(this.bar); }
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
    envelope.gain.exponentialRampToValueAtTime(0.72, at + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
    oscillator.connect(envelope).connect(this.musicGain!);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
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
    envelope.gain.exponentialRampToValueAtTime(0.32, at + 0.004);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.17);
    source.connect(band).connect(envelope).connect(this.musicGain!);
    source.onended = () => { source.disconnect(); band.disconnect(); envelope.disconnect(); };
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
    envelope.gain.exponentialRampToValueAtTime(open ? 0.13 : 0.075, at + 0.003);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + length);
    source.connect(high).connect(envelope).connect(this.musicGain!);
    source.onended = () => { source.disconnect(); high.disconnect(); envelope.disconnect(); };
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
    filter.Q.value = 1.4;
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.exponentialRampToValueAtTime(0.28, at + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + SECONDS_PER_STEP * 1.7);
    oscillator.connect(filter).connect(envelope).connect(this.musicGain!);
    oscillator.onended = () => { oscillator.disconnect(); filter.disconnect(); envelope.disconnect(); };
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
    envelope.gain.exponentialRampToValueAtTime(0.1, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    // Two detuned saws give the stab width without a second oscillator bank.
    for (const detune of [-7, 7]) {
      const oscillator = context.createOscillator();
      oscillator.type = "sawtooth";
      oscillator.frequency.setValueAtTime(semitonesToHz(semitones), at);
      oscillator.detune.setValueAtTime(detune, at);
      oscillator.connect(filter);
      oscillator.onended = () => {
        oscillator.disconnect();
        if (detune === 7) { filter.disconnect(); envelope.disconnect(); }
      };
      oscillator.start(at); oscillator.stop(at + 0.32);
    }
    filter.connect(envelope).connect(this.musicGain!);
  }

  private applyGain(): void {
    if (this.gain !== null && this.context !== null) {
      this.gain.gain.setTargetAtTime(this.settings.muted ? 0 : Math.min(1, Math.max(0, this.settings.volume)), this.context.currentTime, 0.025);
    }
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
