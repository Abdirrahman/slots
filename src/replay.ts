import type { StorageLike } from "./best-times";

export interface GhostRun {
  readonly version: 1;
  readonly seconds: number;
  readonly length: number;
  readonly samples: readonly (readonly [number, number, number])[]; // seconds, unwrapped progress, lane
  readonly sectors: readonly number[]; // cumulative checkpoint/lap times
}
export function readGhost(storage: StorageLike, key: string, length: number): GhostRun | null {
  try {
    const value = JSON.parse(storage.getItem(`${key}|ghost`) ?? "null") as GhostRun;
    if (!value || value.version !== 1 || !Number.isFinite(value.seconds) || value.seconds <= 0 || value.seconds > 480
      || value.length !== length || !Array.isArray(value.samples) || value.samples.length < 2 || value.samples.length > 7202
      || !Array.isArray(value.sectors) || value.sectors.length > 400
      || !value.sectors.every((time, index) => Number.isFinite(time) && time > 0 && time <= value.seconds + 0.1 && (index === 0 || time > value.sectors[index - 1]!))) return null;
    if (!value.samples.every((sample, index) => Array.isArray(sample) && sample.length === 3
      && sample.every(Number.isFinite) && sample[0] >= 0 && sample[0] <= value.seconds + 0.1
      && sample[1] >= 0 && sample[1] <= length * 100 && sample[2] >= 0 && sample[2] <= 3
      && (index === 0 || sample[0] > value.samples[index - 1]![0] && sample[1] >= value.samples[index - 1]![1]))) return null;
    return value;
  } catch { return null; }
}
export function saveGhost(storage: StorageLike, key: string, run: GhostRun): void {
  const previous = readGhost(storage, key, run.length);
  if (previous !== null && previous.seconds <= run.seconds) return;
  try { storage.setItem(`${key}|ghost`, JSON.stringify(run)); } catch { /* The race remains playable without storage. */ }
}
export function sampleGhost(run: GhostRun, seconds: number): { progress: number; lane: number } | null {
  if (seconds < 0 || seconds > run.seconds) return null;
  let low = 0, high = run.samples.length - 1;
  while (low + 1 < high) { const mid = (low + high) >>> 1; if (run.samples[mid]![0] <= seconds) low = mid; else high = mid; }
  const a = run.samples[low]!, b = run.samples[high]!;
  const alpha = Math.max(0, Math.min(1, (seconds - a[0]) / (b[0] - a[0])));
  return { progress: (a[1] + (b[1] - a[1]) * alpha) % run.length, lane: a[2] + (b[2] - a[2]) * alpha };
}
export const CUP_POINTS = [10, 6, 3, 1] as const;
export function scoreCupRound(places: readonly { id: string; finished: boolean }[]): Record<string, number> {
  return Object.fromEntries(places.map((place, index) => [place.id, place.finished ? CUP_POINTS[index] ?? 0 : 0]));
}
