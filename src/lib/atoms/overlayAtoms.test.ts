import { describe, expect, it } from "vitest";

import { DEFAULT_OVERLAY_SETTINGS } from "../types";
import { clampOpacity } from "./overlayAtoms";

describe("clampOpacity", () => {
  it("returns the default when given NaN", () => {
    expect(clampOpacity(Number.NaN)).toBe(DEFAULT_OVERLAY_SETTINGS.opacity);
  });

  it("floors low values to the minimum visible level", () => {
    expect(clampOpacity(-0.5)).toBe(0.15);
    expect(clampOpacity(0)).toBe(0.15);
  });

  it("caps values above 1.0", () => {
    expect(clampOpacity(1.5)).toBe(1);
    expect(clampOpacity(2)).toBe(1);
  });

  it("preserves values inside the visible range", () => {
    expect(clampOpacity(0.42)).toBe(0.42);
    expect(clampOpacity(0.72)).toBe(0.72);
  });
});
