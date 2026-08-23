import { describe, expect, test } from "bun:test";
import { isEditingControl, isLaneControlKey, laneIntentForKey } from "../src/controls";

describe("Lane keyboard intent", () => {
  test("maps only A/left and D/right to one adjacent Lane edge", () => {
    expect(laneIntentForKey("KeyA", false)).toBe(-1);
    expect(laneIntentForKey("ArrowLeft", false)).toBe(-1);
    expect(laneIntentForKey("KeyD", false)).toBe(1);
    expect(laneIntentForKey("ArrowRight", false)).toBe(1);
    expect(laneIntentForKey("KeyW", false)).toBeUndefined();
    expect(laneIntentForKey("ArrowUp", false)).toBeUndefined();
    expect(laneIntentForKey("Space", false)).toBeUndefined();
    expect(isLaneControlKey("ArrowLeft")).toBe(true);
    expect(isLaneControlKey("KeyD")).toBe(true);
    expect(isLaneControlKey("ArrowUp")).toBe(false);
    expect(isLaneControlKey("KeyW")).toBe(false);
  });

  test("ignores browser key repeat", () => {
    expect(laneIntentForKey("KeyA", true)).toBeUndefined();
    expect(laneIntentForKey("ArrowRight", true)).toBeUndefined();
  });

  test("identifies native editing controls and content-editable targets", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "BUTTON"]) {
      expect(isEditingControl({ tagName, isContentEditable: false })).toBe(true);
    }
    expect(isEditingControl({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditingControl({ tagName: "CANVAS", isContentEditable: false })).toBe(false);
    expect(isEditingControl(null)).toBe(false);
  });
});
