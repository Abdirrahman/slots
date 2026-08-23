import type { LaneChangeDirection } from "./race";

interface KeyboardTarget {
  readonly tagName: string;
  readonly isContentEditable: boolean;
}

export function isLaneControlKey(code: string): boolean {
  return code === "KeyA" || code === "ArrowLeft" || code === "KeyD" || code === "ArrowRight";
}

export function laneIntentForKey(code: string, repeat: boolean): LaneChangeDirection | undefined {
  if (repeat) return undefined;
  if (code === "KeyA" || code === "ArrowLeft") return -1;
  if (code === "KeyD" || code === "ArrowRight") return 1;
  return undefined;
}

export function isBoostControlKey(code: string): boolean {
  return code === "Space" || code === "KeyW" || code === "ArrowUp";
}

/** Boost is spent on the key's leading edge only, so holding it cannot drain the meter. */
export function boostIntentForKey(code: string, repeat: boolean): true | undefined {
  return !repeat && isBoostControlKey(code) ? true : undefined;
}

export function isEditingControl(target: KeyboardTarget | null): boolean {
  return target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName));
}
