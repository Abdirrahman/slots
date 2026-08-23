import { describe, expect, test } from "bun:test";
import { bestTimeKey, readBestTime, recordBestTime, type BestTimeIdentity, type StorageLike } from "../src/best-times";
import { DEFAULT_SETTINGS, normalizeVolume, panelVisibility, parseSoloRaceOptions, parseStoredSettings, raceControlsEnabled, serializeSettings } from "../src/settings";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

const identity: BestTimeIdentity = {
  trackId: "workshop-bench", trackVersion: "1.0.0", configuration: { laps: 3 }, soloConfiguration: null, carProfileId: "balanced-v1",
  carProfile: { accelerationPerSecondSquared: 24, topSpeedPerSecond: 30, brakingPerSecondSquared: 14, laneChangeDurationTicks: 12 },
};

describe("local settings and controls", () => {
  test("bounds volume and safely parses only exact current-version settings", () => {
    expect(normalizeVolume(-1)).toBe(0); expect(normalizeVolume(2)).toBe(1); expect(normalizeVolume(Number.NaN)).toBe(DEFAULT_SETTINGS.volume);
    expect(parseStoredSettings(serializeSettings({ muted: true, volume: 0.25 }))).toEqual({ muted: true, volume: 0.25 });
    for (const invalid of [null, "{", JSON.stringify({ version: 0, muted: false, volume: 1 }), JSON.stringify({ version: 1, muted: false, volume: 2 }), JSON.stringify({ version: 1, muted: false, volume: 1, extra: true })]) {
      expect(parseStoredSettings(invalid)).toEqual(DEFAULT_SETTINGS);
    }
  });

  test("parses only exact Solo Bot options from native control values", () => {
    expect(parseSoloRaceOptions("1", "easy")).toEqual({ botCount: 1, botDifficulty: "easy" });
    expect(parseSoloRaceOptions("2", "normal")).toEqual({ botCount: 2, botDifficulty: "normal" });
    expect(parseSoloRaceOptions("3", "hard")).toEqual({ botCount: 3, botDifficulty: "hard" });
    for (const [count, difficulty] of [["0", "easy"], ["4", "hard"], ["1.5", "normal"], ["2", "Normal"], ["2", "unknown"]]) {
      expect(parseSoloRaceOptions(count!, difficulty!)).toBeNull();
    }
  });

  test("keeps settings and credits panels deterministic and disables unavailable Race control", () => {
    expect(panelVisibility("closed", "settings")).toBe("settings");
    expect(panelVisibility("settings", "settings")).toBe("closed");
    expect(panelVisibility("settings", "credits")).toBe("credits");
    expect(raceControlsEnabled({ localRole: "racer", canControlRace: true, controller: "human", reclaimPending: false, connected: true })).toBe(true);
    for (const unavailable of [
      { localRole: "spectator" as const, canControlRace: false, controller: "none" as const, reclaimPending: false, connected: true },
      { localRole: "racer" as const, canControlRace: false, controller: "bot" as const, reclaimPending: true, connected: true },
      { localRole: "racer" as const, canControlRace: false, controller: "human" as const, reclaimPending: false, connected: false },
    ]) expect(raceControlsEnabled(unavailable)).toBe(false);
  });
});

describe("browser-local best times", () => {
  test("uses the complete composite key and isolates Track, version, laps, and profile", () => {
    const key = bestTimeKey(identity);
    expect(key).toContain("workshop-bench|1.0.0|laps=3|profile=balanced-v1|24|30|12");
    expect(bestTimeKey({ ...identity, trackVersion: "1.0.1" })).not.toBe(key);
    expect(bestTimeKey({ ...identity, configuration: { laps: 4 } })).not.toBe(key);
    expect(bestTimeKey({ ...identity, carProfileId: "speed-v1" })).not.toBe(key);
    const easyOne = bestTimeKey({ ...identity, soloConfiguration: { botCount: 1, botDifficulty: "easy" } });
    expect(easyOne).not.toBe(key);
    expect(bestTimeKey({ ...identity, soloConfiguration: { botCount: 2, botDifficulty: "easy" } })).not.toBe(easyOne);
    expect(bestTimeKey({ ...identity, soloConfiguration: { botCount: 1, botDifficulty: "hard" } })).not.toBe(easyOne);
  });

  test("records only a better valid uninterrupted human finish", () => {
    const storage = new MemoryStorage();
    const eligible = { role: "racer" as const, result: "finished" as const, bestTimeEligible: true, finishedAtSeconds: 80 };
    expect(recordBestTime(storage, identity, eligible)).toBe(80);
    expect(recordBestTime(storage, identity, { ...eligible, finishedAtSeconds: 90 })).toBe(80);
    expect(recordBestTime(storage, identity, { ...eligible, finishedAtSeconds: 70 })).toBe(70);
    expect(readBestTime(storage, bestTimeKey(identity))).toBe(70);
  });

  test("rejects DNF, Spectator, Bot-takeover/ineligible, incomplete, malformed, old, and out-of-range records", () => {
    const storage = new MemoryStorage();
    const base = { role: "racer" as const, result: "finished" as const, bestTimeEligible: true, finishedAtSeconds: 80 };
    expect(recordBestTime(storage, identity, { ...base, result: "dnf" })).toBeNull();
    expect(recordBestTime(storage, identity, { ...base, role: "spectator" })).toBeNull();
    expect(recordBestTime(storage, identity, { ...base, bestTimeEligible: false })).toBeNull();
    expect(recordBestTime(storage, identity, { ...base, finishedAtSeconds: null })).toBeNull();
    for (const value of ["{", JSON.stringify({ version: 0, seconds: 10 }), JSON.stringify({ version: 1, seconds: -1 }), JSON.stringify({ version: 1, seconds: 10, extra: true })]) {
      storage.values.set(bestTimeKey(identity), value);
      expect(readBestTime(storage, bestTimeKey(identity))).toBeNull();
    }
  });
});
