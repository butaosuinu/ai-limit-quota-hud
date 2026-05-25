import { describe, expect, it } from "vitest";
import { createStore } from "jotai";

import type { UsageSnapshot } from "../types";
import {
  formatResetCountdown,
  snapshotsAtom,
  sortedSnapshotsAtom,
  statusCountsAtom,
} from "./usageAtoms";

const baseSnapshot = (
  overrides: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  providerId: "webview-claude-ai:default",
  providerKind: "webview-claude-ai",
  accountLabel: "personal",
  window: "five-hours",
  metric: "messages",
  limit: 40,
  used: 10,
  remaining: 30,
  remainingPercent: 75,
  resetAt: undefined,
  observedAt: "2026-05-13T12:00:00Z",
  source: "webview-scrape",
  confidence: "low",
  status: "ok",
  message: undefined,
  ...overrides,
});

describe("sortedSnapshotsAtom", () => {
  it("orders snapshots by status severity then account label", () => {
    const store = createStore();
    store.set(snapshotsAtom, [
      baseSnapshot({ providerId: "a", accountLabel: "alice", status: "ok" }),
      baseSnapshot({
        providerId: "b",
        accountLabel: "bob",
        status: "critical",
      }),
      baseSnapshot({
        providerId: "c",
        accountLabel: "carol",
        status: "warning",
      }),
      baseSnapshot({
        providerId: "d",
        accountLabel: "dan",
        status: "no-data",
      }),
      baseSnapshot({
        providerId: "e",
        accountLabel: "alex",
        status: "warning",
      }),
    ]);
    const sorted = store.get(sortedSnapshotsAtom);
    expect(sorted.map((s) => s.providerId)).toEqual([
      "b", // critical
      "e", // warning + alex
      "c", // warning + carol
      "a", // ok
      "d", // no-data
    ]);
  });
});

describe("statusCountsAtom", () => {
  it("aggregates counts by status", () => {
    const store = createStore();
    store.set(snapshotsAtom, [
      baseSnapshot({ providerId: "a", status: "ok" }),
      baseSnapshot({ providerId: "b", status: "warning" }),
      baseSnapshot({ providerId: "c", status: "warning" }),
      baseSnapshot({ providerId: "d", status: "critical" }),
      baseSnapshot({ providerId: "e", status: "no-data" }),
      baseSnapshot({ providerId: "f", status: "error" }),
    ]);
    expect(store.get(statusCountsAtom)).toEqual({
      ok: 1,
      warning: 2,
      critical: 1,
      noData: 1,
      error: 1,
    });
  });
});

describe("formatResetCountdown", () => {
  const now = Date.UTC(2026, 4, 13, 12, 0, 0);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const localHm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  it("returns --:-- when resetAt is undefined", () => {
    expect(formatResetCountdown(undefined, now)).toBe("--:--");
  });

  it("returns --:-- when resetAt is unparseable", () => {
    expect(formatResetCountdown("not a date", now)).toBe("--:--");
  });

  it("renders HH:MM in local time when reset is later today", () => {
    // +2 hours from `now`; in any TZ within ±10h of UTC this stays on the
    // same calendar day, which is the regime we care about. Compute the
    // expected label from the same Date the function will see so the test
    // is timezone-independent.
    const reset = new Date(now + 2 * 60 * 60 * 1000);
    expect(formatResetCountdown(reset.toISOString(), now)).toBe(localHm(reset));
  });

  it("prefixes M/D when reset falls on a later day", () => {
    // +3 days lands on a different calendar day in every realistic TZ.
    const reset = new Date(now + 3 * 24 * 60 * 60 * 1000);
    const expected = `${(reset.getMonth() + 1).toString()}/${reset.getDate().toString()} ${localHm(reset)}`;
    expect(formatResetCountdown(reset.toISOString(), now)).toBe(expected);
  });

  it("still shows the absolute time when the reset is in the past", () => {
    // Past resets keep displaying the scheduled time (HH:MM today) rather
    // than collapsing to a placeholder — the underlying snapshot may be
    // stale and the next refresh will replace the timestamp.
    const reset = new Date(now - 10 * 60 * 1000);
    expect(formatResetCountdown(reset.toISOString(), now)).toBe(localHm(reset));
  });
});
