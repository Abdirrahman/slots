import { describe, expect, test } from "bun:test";

import { breakbeatPattern, RaceAudio, semitonesToHz } from "../src/audio";

describe("original breakbeat soundtrack", () => {
  test("a bar is sixteen steps and is derived, not stored", () => {
    const bar = breakbeatPattern(0);
    expect(bar).toHaveLength(16);
    expect(breakbeatPattern(0)).toEqual(bar);
    // Bars wrap through four variations, in both directions.
    expect(breakbeatPattern(4)).toEqual(bar);
    expect(breakbeatPattern(-4)).toEqual(bar);
  });

  test("every bar keeps a downbeat kick and backbeat snares", () => {
    for (let bar = 0; bar < 4; bar += 1) {
      const steps = breakbeatPattern(bar);
      expect(steps[0]!.kick).toBe(true);
      expect(steps[4]!.snare).toBe(true);
      expect(steps[12]!.snare).toBe(true);
      expect(steps.filter((step) => step.hat).length).toBe(8);
    }
  });

  test("the four variations are actually different from one another", () => {
    const rendered = [0, 1, 2, 3].map((bar) => JSON.stringify(breakbeatPattern(bar)));
    expect(new Set(rendered).size).toBe(4);
  });

  test("stabs answer only in the second half of alternate bars", () => {
    expect(breakbeatPattern(0).every((step) => step.stab === null)).toBe(true);
    const answering = breakbeatPattern(1);
    expect(answering.slice(0, 8).every((step) => step.stab === null)).toBe(true);
    expect(answering.slice(8).some((step) => step.stab !== null)).toBe(true);
  });

  test("semitones map onto equal temperament from the bass root", () => {
    expect(semitonesToHz(0)).toBeCloseTo(55, 10);
    expect(semitonesToHz(12)).toBeCloseTo(110, 10);
    expect(semitonesToHz(-12)).toBeCloseTo(27.5, 10);
    expect(semitonesToHz(7)).toBeCloseTo(55 * 2 ** (7 / 12), 10);
  });
});

test("motor voices persist across renders, ramp with speed, and obey audio lifecycle", async () => {
  class Parameter {
    value = 0;
    setValueAtTime(value: number): void { this.value = value; }
    exponentialRampToValueAtTime(value: number): void { this.value = value; }
    setTargetAtTime(value: number): void { this.value = value; }
    cancelScheduledValues(): void {}
  }
  class Node {
    readonly gain = new Parameter();
    readonly frequency = new Parameter();
    readonly detune = new Parameter();
    readonly Q = new Parameter();
    readonly threshold = new Parameter();
    readonly knee = new Parameter();
    readonly ratio = new Parameter();
    readonly attack = new Parameter();
    readonly release = new Parameter();
    type = "";
    buffer: unknown;
    loop = false;
    stopped = false;
    onended: (() => void) | null = null;
    connect(node: Node): Node { return node; }
    disconnect(): void {}
    start(): void {}
    stop(): void { this.stopped = true; }
  }
  class Context {
    static latest: Context;
    currentTime = 0;
    state = "suspended";
    sampleRate = 32;
    readonly destination = new Node();
    readonly gains: Node[] = [];
    readonly oscillators: Node[] = [];
    readonly sources: Node[] = [];
    constructor() { Context.latest = this; }
    createGain(): Node { const node = new Node(); this.gains.push(node); return node; }
    createOscillator(): Node { const node = new Node(); this.oscillators.push(node); return node; }
    createBufferSource(): Node { const node = new Node(); this.sources.push(node); return node; }
    createBiquadFilter(): Node { return new Node(); }
    createDynamicsCompressor(): Node { return new Node(); }
    createBuffer(): { getChannelData: () => Float32Array } { return { getChannelData: () => new Float32Array(32) }; }
    async resume(): Promise<void> { this.state = "running"; }
    async close(): Promise<void> { this.state = "closed"; }
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  Object.defineProperty(globalThis, "AudioContext", { value: Context, configurable: true });
  const audio = new RaceAudio({ muted: false, volume: 0.7 });
  try {
    audio.updateEngine(20, 40, false, false, true);
    await audio.activate();
    const context = Context.latest;
    expect(context.oscillators).toHaveLength(2);
    expect(context.sources).toHaveLength(1);
    expect(context.gains).toHaveLength(8);
    const motor = context.oscillators[0]!;
    const initialPitch = motor.frequency.value;
    for (let index = 0; index < 120; index += 1) {
      context.currentTime += 1 / 60;
      audio.updateEngine(20 + index / 6, 40, false, false, true);
    }
    expect(context.oscillators).toHaveLength(2);
    expect(context.sources).toHaveLength(1);
    expect(context.gains).toHaveLength(8);
    expect(motor.frequency.value).toBeGreaterThan(initialPitch);
    audio.updateEngine(NaN, 0, true, true, false);
    expect(Number.isFinite(motor.frequency.value)).toBe(true);
    expect(context.gains[2]!.gain.value).toBe(0);
    audio.setSettings({ muted: true, volume: 1 });
    expect(context.gains[0]!.gain.value).toBe(0);
    audio.play("finish");
    audio.playCountdown(0);
    audio.playMenu();
    expect(context.oscillators).toHaveLength(2);
    audio.update({ muted: false, volume: 0.4 });
    audio.playCountdown(3);
    expect(context.oscillators).toHaveLength(3);
    audio.setMusic(true);
    expect(context.gains[1]!.gain.value).toBeGreaterThan(0);
    audio.setMusic(false);
    expect(context.gains[1]!.gain.value).toBe(0);
    audio.dispose();
    expect(context.state).toBe("closed");
    expect(context.oscillators[0]!.stopped).toBe(true);
    expect(context.oscillators[1]!.stopped).toBe(true);
    expect(context.sources[0]!.stopped).toBe(true);
  } finally {
    audio.dispose();
    if (previous !== undefined) Object.defineProperty(globalThis, "AudioContext", previous);
    else Reflect.deleteProperty(globalThis, "AudioContext");
  }
});
