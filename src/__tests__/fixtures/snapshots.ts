import type { UsageSnapshot } from "../../lib/types";

const BASE: UsageSnapshot = {
  providerId: "webview-claude-ai:weekly",
  providerKind: "webview-claude-ai",
  accountLabel: "Claude",
  window: "weekly",
  metric: "percent",
  limit: 100,
  used: 25,
  remaining: 75,
  remainingPercent: 75,
  resetAt: "2026-05-13T18:00:00Z",
  observedAt: "2026-05-13T12:00:00Z",
  source: "webview-scrape",
  confidence: "low",
  status: "ok",
  message: null,
};

export function makeSnapshot(
  overrides: Partial<UsageSnapshot> = {},
): UsageSnapshot {
  return { ...BASE, ...overrides };
}
