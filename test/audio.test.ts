import { describe, expect, test } from "bun:test";

import { breakbeatPattern, semitonesToHz } from "../src/audio";

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
