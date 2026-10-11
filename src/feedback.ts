import type { RaceEvent } from "./race";

export type AudioCue = "checkpoint" | "lap" | "finish" | "collision" | "blocked" | "crash" | "respawn" | "ghost-end" | "pickup" | "shield" | "impact" | "hazard-warning" | "hazard-active" | "hazard-hit" | "hazard-expire" | "boost" | "deslot-warning";
export type VisualEffect = "ring" | "banner" | "bump" | "lane-return" | "sparks" | "respawn" | "ghost-clear" | "pickup" | "shield-pop" | "impact" | "hazard-warning" | "hazard-active" | "hazard-hit" | "hazard-expire" | "boost" | "deslot-warning";

export interface EventFeedback {
  readonly eventId: string;
  readonly announcement: string;
  readonly audio: AudioCue;
  readonly effect: VisualEffect;
  readonly cameraImpulse: number;
  readonly sourceId: string | null;
}

export interface IdentifiedRaceEvent { readonly id: string; readonly event: RaceEvent }

/** Driver feedback includes both sides of contact, but excludes unrelated opponents. */
export function raceEventInvolvesCar(event: RaceEvent, carId: string): boolean {
  return "carId" in event && (event.carId === carId
    || event.type === "boosted_impact" && event.targetCarId === carId
    || event.type === "ordinary_collision" && event.leadingCarId === carId);
}

export class EventFeedbackConsumer {
  private raceId: string | null = null;
  private readonly seen = new Set<string>();

  consume(raceId: string, events: readonly IdentifiedRaceEvent[], reducedMotion: boolean): readonly EventFeedback[] {
    if (this.raceId !== raceId) { this.raceId = raceId; this.seen.clear(); }
    const feedback: EventFeedback[] = [];
    for (const identified of events) {
      if (this.seen.has(identified.id)) continue;
      this.seen.add(identified.id);
      feedback.push(feedbackForEvent(identified, reducedMotion));
    }
    return feedback;
  }
}

export function feedbackForEvent(identified: IdentifiedRaceEvent, reducedMotion: boolean): EventFeedback {
  const event = identified.event;
  const base = (() => {
    switch (event.type) {
      case "checkpoint": return ["Checkpoint crossed", "checkpoint", "ring", 0, event.checkpointId] as const;
      case "lap": return [`Lap ${event.lap} complete`, "lap", "banner", 0.08, event.carId] as const;
      case "finish": return ["Racer finished", "finish", "banner", 0.12, event.carId] as const;
      case "ordinary_collision": return ["Ordinary collision", "collision", "bump", 0.12, event.leadingCarId] as const;
      case "blocked_lane_change": return ["Lane change blocked", "blocked", "lane-return", 0.1, event.carId] as const;
      case "crash": return [`Crash: ${event.cause.replaceAll("_", " ")}`, "crash", "sparks", 0.3, event.sourceId] as const;
      case "respawn": return [`Respawned in Lane ${event.lane + 1}`, "respawn", "respawn", 0.08, event.carId] as const;
      case "ghost_end": return ["Ghost state ended", "ghost-end", "ghost-clear", 0, event.carId] as const;
      case "power_up_collected": return [`${event.effect} collected`, "pickup", "pickup", 0.06, event.opportunityId] as const;
      case "shield_consumed": return ["Shield consumed", "shield", "shield-pop", 0.12, event.sourceId] as const;
      case "boosted_impact": return ["Boosted impact", "impact", "impact", 0.24, event.targetCarId] as const;
      case "hazard_placed": return [`Hazard warning in Lane ${event.lane + 1}`, "hazard-warning", "hazard-warning", 0, event.hazardId] as const;
      case "hazard_activated": return ["Hazard active", "hazard-active", "hazard-active", 0.04, event.hazardId] as const;
      case "hazard_consumed": return ["Hazard collision", "hazard-hit", "hazard-hit", 0.2, event.hazardId] as const;
      case "hazard_removed": return ["Hazard expired", "hazard-expire", "hazard-expire", 0, event.hazardId] as const;
      case "boost_activated": return [`Boost spent, ${event.chargesRemaining} left`, "boost", "boost", 0.18, event.carId] as const;
      case "deslot_warning": return ["Carrying too much speed", "deslot-warning", "deslot-warning", 0.06, event.carId] as const;
    }
  })();
  return {
    eventId: identified.id,
    announcement: base[0], audio: base[1], effect: base[2],
    cameraImpulse: reducedMotion ? 0 : base[3], sourceId: base[4],
  };
}

export function resultTransitionFeedback(previous: "racing" | "finished" | "dnf" | null, current: "racing" | "finished" | "dnf"): string | null {
  if (previous === current || current === "racing") return null;
  return current === "finished" ? "Official finish recorded" : "Did not finish";
}
