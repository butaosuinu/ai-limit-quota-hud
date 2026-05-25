import { describe, expect, it } from "vitest";

import {
  normalizeOverlaySettings,
  normalizeSnapshot,
  normalizeSnapshots,
  type WireOverlaySettings,
  type WireUsageSnapshot,
} from "./wire";

// wire 形は Rust の `Option<T>` = JSON `null` をそのまま表す。境界の入力として
// のみ `null` を使い、正規化後に `undefined` へ変換されることを検証する。
const wireSnapshot = (
  overrides: Partial<WireUsageSnapshot> = {},
): WireUsageSnapshot => ({
  providerId: "webview-claude-ai:weekly",
  providerKind: "webview-claude-ai",
  accountLabel: "Claude",
  window: "weekly",
  metric: "percent",
  limit: null,
  used: null,
  remaining: null,
  remainingPercent: null,
  resetAt: null,
  observedAt: "2026-05-13T12:00:00Z",
  source: "webview-scrape",
  confidence: "low",
  status: "no-data",
  message: null,
  ...overrides,
});

const wireSettings = (
  position: WireOverlaySettings["position"],
): WireOverlaySettings => ({
  opacity: 0.72,
  compact: false,
  clickThrough: false,
  locked: true,
  visible: true,
  alwaysOnTop: true,
  corner: "top-right",
  marginX: 24,
  marginY: 24,
  position,
  menuBarSummary: "off",
  checkUpdatesOnStartup: true,
});

describe("normalizeSnapshot", () => {
  it("converts every null wire field to undefined", () => {
    const result = normalizeSnapshot(wireSnapshot());
    expect(result.limit).toBeUndefined();
    expect(result.used).toBeUndefined();
    expect(result.remaining).toBeUndefined();
    expect(result.remainingPercent).toBeUndefined();
    expect(result.resetAt).toBeUndefined();
    expect(result.message).toBeUndefined();
  });

  it("preserves present values", () => {
    const result = normalizeSnapshot(
      wireSnapshot({ limit: 100, used: 25, message: "warn" }),
    );
    expect(result.limit).toBe(100);
    expect(result.used).toBe(25);
    expect(result.message).toBe("warn");
  });
});

describe("normalizeSnapshots", () => {
  it("normalizes each element independently", () => {
    const result = normalizeSnapshots([
      wireSnapshot({ providerId: "a" }),
      wireSnapshot({ providerId: "b", limit: 50 }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.limit).toBeUndefined();
    expect(result[1]?.limit).toBe(50);
  });
});

describe("normalizeOverlaySettings", () => {
  it("converts a null position to undefined", () => {
    expect(
      normalizeOverlaySettings(wireSettings(null)).position,
    ).toBeUndefined();
  });

  it("preserves a present position", () => {
    expect(
      normalizeOverlaySettings(wireSettings({ x: 1, y: 2 })).position,
    ).toEqual({ x: 1, y: 2 });
  });
});
