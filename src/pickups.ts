import type { LaneIndex, PowerUpOpportunityState, RaceState } from "./race";

export const PICKUP_RULES = Object.freeze({ warningTicks: 45, activeTicks: 600, retryTicks: 30, minimumClearance: 10 });

/** Server-only decisions. All clients see the same position, item and countdown. */
export function cyclePickups(race: RaceState): { opportunities: PowerUpOpportunityState[]; randomState: number } {
  let randomState = race.randomState;
  const random = (maximum: number): number => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return (randomState >>> 8) % maximum;
  };
  const opportunities = race.powerUpOpportunities.map((item) => ({ ...item }));
  const zones = race.track.powerUpOpportunities ?? [];
  for (const item of opportunities) {
    if ((item.ticksRemaining ?? 0) > 1) { item.ticksRemaining! -= 1; continue; }
    if (item.phase === "warning") {
      item.phase = "active"; item.collected = false; item.ticksRemaining = PICKUP_RULES.activeTicks;
      continue;
    }
    if (item.phase === "active") {
      item.phase = "cooldown"; item.collected = true; item.ticksRemaining = 180 + random(121);
      continue;
    }
    const authored = zones.find((zone) => zone.id === item.id)!;
    let found = false;
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const zone = zones[random(zones.length)]!;
      const radius = zone.spawnRadius ?? Math.min(12, race.track.length * 0.08);
      const progress = modulo(zone.progress + (random(2001) / 1000 - 1) * radius, race.track.length);
      const lane = random(4) as LaneIndex;
      if (!safePickupLocation(race, opportunities, item.id, progress, lane)) continue;
      item.progress = progress; item.lane = lane;
      item.effect = authored.allowedEffects[random(authored.allowedEffects.length)]!;
      item.phase = "warning"; item.collected = false; item.ticksRemaining = PICKUP_RULES.warningTicks;
      found = true; break;
    }
    if (!found) item.ticksRemaining = PICKUP_RULES.retryTicks;
  }
  return { opportunities, randomState };
}

export function safePickupLocation(race: RaceState, items: readonly PowerUpOpportunityState[], id: string, progress: number, lane: LaneIndex): boolean {
  const length = race.track.length;
  if ([race.track.startFinish, ...race.track.checkpoints.map((point) => point.progress)]
    .some((marker) => clearance(progress, marker, length) < 8)) return false;
  // Keep dynamic choices on the authored straights, away from blind entries and exits.
  if ((race.track.corners ?? []).some((corner) =>
    modulo(progress - corner.fromProgress, length) < modulo(corner.toProgress - corner.fromProgress, length)
    || clearance(progress, corner.fromProgress, length) < 6 || clearance(progress, corner.toProgress, length) < 6)) return false;
  if (race.cars.some((car) => car.result === "racing" && (
    clearance(progress, car.progress, length) < PICKUP_RULES.minimumClearance
    || modulo(progress - car.progress, length) < Math.max(12, car.profile.topSpeedPerSecond * 1.25 * 2)))) return false;
  if ((race.track.fixedObstacles ?? []).some((point) => point.lane === lane && clearance(progress, point.progress, length) < 8)
    || race.hazards.some((point) => clearance(progress, point.progress, length) < 10)) return false;
  return !items.some((item) => item.id !== id && item.phase !== "cooldown"
    && item.progress !== undefined && clearance(progress, item.progress, length) < 14);
}
function modulo(value: number, length: number): number { return ((value % length) + length) % length; }
function clearance(a: number, b: number, length: number): number { return Math.min(modulo(a - b, length), modulo(b - a, length)); }
