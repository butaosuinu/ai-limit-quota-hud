import { describe, expect, it } from "vitest";
import { createStore } from "jotai";

import type { UsageSnapshot } from "../types";
import {
  nowAtom,
  resetCountdownAtomFamily,
  snapshotsAtom,
  sortedSnapshotsAtom,
  statusCountsAtom,
} from "./usageAtoms";

const baseSnapshot = (
  overrides: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  providerId: "manual:row-1",
  providerKind: "manual",
  accountLabel: "personal",
  window: "five-hours",
  metric: "messages",
  limit: 40,
  used: 10,
  remaining: 30,
  remainingPercent: 75,
  resetAt: null,
  observedAt: "2026-05-13T12:00:00Z",
  source: "manual",
  confidence: "low",
  status: "ok",
  message: null,
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

describe("resetCountdownAtomFamily", () => {
  it("returns --:-- when resetAt is null", () => {
    const store = createStore();
    store.set(snapshotsAtom, [
      baseSnapshot({ providerId: "a", resetAt: null }),
    ]);
    expect(store.get(resetCountdownAtomFamily("a"))).toBe("--:--");
  });

  it("returns --:-- for an unknown provider id", () => {
    const store = createStore();
    store.set(snapshotsAtom, []);
    expect(store.get(resetCountdownAtomFamily("missing"))).toBe("--:--");
  });

  it("renders mm:ss when resetAt is in the future", () => {
    const store = createStore();
    const now = Date.UTC(2026, 4, 13, 12, 0, 0);
    store.set(nowAtom, now);
    store.set(snapshotsAtom, [
      baseSnapshot({
        providerId: "a",
        resetAt: new Date(now + 125_000).toISOString(),
      }),
    ]);
    expect(store.get(resetCountdownAtomFamily("a"))).toBe("2:05");
  });

  it("returns 0:00 when the reset time has passed", () => {
    const store = createStore();
    const now = Date.UTC(2026, 4, 13, 12, 0, 0);
    store.set(nowAtom, now);
    store.set(snapshotsAtom, [
      baseSnapshot({
        providerId: "a",
        resetAt: new Date(now - 10_000).toISOString(),
      }),
    ]);
    expect(store.get(resetCountdownAtomFamily("a"))).toBe("0:00");
  });
});
