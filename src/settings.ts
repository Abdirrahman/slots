import type { SoloRaceConfiguration } from "./multiplayer-config";

export interface LocalSettings { readonly muted: boolean; readonly volume: number }
export const DEFAULT_SETTINGS: LocalSettings = Object.freeze({ muted: false, volume: 0.7 });

export function normalizeVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : DEFAULT_SETTINGS.volume;
}

export function parseStoredSettings(text: string | null): LocalSettings {
  if (text === null) return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(text) as unknown;
    if (!isObject(value) || !hasExactKeys(value, ["version", "muted", "volume"])
      || value.version !== 1 || typeof value.muted !== "boolean" || typeof value.volume !== "number"
      || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 1) return DEFAULT_SETTINGS;
    return Object.freeze({ muted: value.muted, volume: value.volume });
  } catch { return DEFAULT_SETTINGS; }
}

export function serializeSettings(settings: LocalSettings): string {
  return JSON.stringify({ version: 1, muted: settings.muted, volume: normalizeVolume(settings.volume) });
}

export function parseSoloRaceOptions(botCount: string, botDifficulty: string): SoloRaceConfiguration | null {
  if ((botCount !== "1" && botCount !== "2" && botCount !== "3")
    || (botDifficulty !== "easy" && botDifficulty !== "normal" && botDifficulty !== "hard")) return null;
  return { botCount: Number(botCount), botDifficulty };
}

export function panelVisibility(current: "closed" | "settings" | "credits", requested: "settings" | "credits"): "closed" | "settings" | "credits" {
  return current === requested ? "closed" : requested;
}

export function raceControlsEnabled(state: {
  readonly localRole: "racer" | "spectator" | null;
  readonly canControlRace: boolean;
  readonly controller: "human" | "bot" | "none";
  readonly reclaimPending: boolean;
  readonly connected: boolean;
}): boolean {
  return state.localRole === "racer" && state.canControlRace && state.controller === "human" && !state.reclaimPending && state.connected;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
