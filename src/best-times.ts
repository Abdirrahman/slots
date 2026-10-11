import type { SoloRaceConfiguration } from "./multiplayer-config";
import type { CarProfile, RaceConfiguration } from "./race";

export interface BestTimeIdentity {
  readonly trackId: string;
  readonly trackVersion: string;
  readonly configuration: RaceConfiguration;
  readonly soloConfiguration: SoloRaceConfiguration | null;
  readonly carProfileId: string;
  readonly carProfile: CarProfile;
}

export interface BestTimeEligibility {
  readonly role: "racer" | "spectator";
  readonly result: "racing" | "finished" | "dnf";
  readonly bestTimeEligible: boolean;
  readonly finishedAtSeconds: number | null;
}

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function bestTimeKey(identity: BestTimeIdentity): string {
  const profile = identity.carProfile;
  return [
    "slots:best-time:v2", identity.trackId, identity.trackVersion,
    `laps=${identity.configuration.laps}`, `profile=${identity.carProfileId}`,
    profile.accelerationPerSecondSquared, profile.topSpeedPerSecond, profile.brakingPerSecondSquared, profile.laneChangeDurationTicks,
    `rules=${identity.configuration.rules ?? "legacy"}`, `assist=${identity.configuration.assist ?? true}`,
    `voltage=${identity.configuration.voltage ?? "legacy"}`,
    ...(identity.soloConfiguration === null ? [] : [
      `bots=${identity.soloConfiguration.botCount}`,
      `difficulty=${identity.soloConfiguration.botDifficulty}`,
    ]),
  ].map(String).join("|");
}

export function readBestTime(storage: StorageLike, key: string): number | null {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as unknown;
    return isObject(value) && hasExactKeys(value, ["version", "seconds"]) && value.version === 1
      && typeof value.seconds === "number" && Number.isFinite(value.seconds) && value.seconds > 0 && value.seconds <= 24 * 60 * 60
      ? value.seconds : null;
  } catch { return null; }
}

export function recordBestTime(storage: StorageLike, identity: BestTimeIdentity, eligibility: BestTimeEligibility): number | null {
  const seconds = eligibility.finishedAtSeconds;
  if (eligibility.role !== "racer" || eligibility.result !== "finished" || !eligibility.bestTimeEligible
    || seconds === null || !Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 60 * 60) return null;
  const key = bestTimeKey(identity);
  const previous = readBestTime(storage, key);
  if (previous !== null && previous <= seconds) return previous;
  try { storage.setItem(key, JSON.stringify({ version: 1, seconds })); } catch { return previous; }
  return seconds;
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
