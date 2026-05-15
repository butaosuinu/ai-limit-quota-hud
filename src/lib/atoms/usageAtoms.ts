import { atom } from "jotai";
import { listen } from "@tauri-apps/api/event";

import { listSnapshots } from "../api";
import {
  USAGE_UPDATED_EVENT,
  type SnapshotStatus,
  type UsageSnapshot,
} from "../types";

export const snapshotsAtom = atom<readonly UsageSnapshot[]>([]);

type Lifecycle = {
  cancelled: boolean;
  unlisten: (() => void) | null;
};

snapshotsAtom.onMount = (set) => {
  const lifecycle: Lifecycle = { cancelled: false, unlisten: null };
  void bootstrapUsageSync(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
    if (lifecycle.unlisten !== null) lifecycle.unlisten();
  };
};

async function bootstrapUsageSync(
  set: (next: readonly UsageSnapshot[]) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  let receivedFreshEvent = false;
  const unlisten = await listen<readonly UsageSnapshot[]>(
    USAGE_UPDATED_EVENT,
    (event) => {
      receivedFreshEvent = true;
      set(event.payload);
    },
  ).catch((err: unknown) => {
    console.warn("usage subscription failed", err);
    return null;
  });
  if (lifecycle.cancelled) {
    if (unlisten !== null) unlisten();
    return;
  }
  lifecycle.unlisten = unlisten;

  const initial = await listSnapshots().catch((err: unknown) => {
    console.warn("list_snapshots failed", err);
    return null;
  });
  if (lifecycle.cancelled) return;
  if (initial !== null && !receivedFreshEvent) set(initial);
}

const STATUS_PRIORITY: Record<SnapshotStatus, number> = {
  critical: 0,
  warning: 1,
  ok: 2,
  "no-data": 3,
  error: 4,
};

export const sortedSnapshotsAtom = atom((get) => {
  const snapshots = [...get(snapshotsAtom)];
  snapshots.sort((a, b) => {
    const priorityDiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (priorityDiff !== 0) return priorityDiff;
    return a.accountLabel.localeCompare(b.accountLabel);
  });
  return snapshots;
});

export type StatusCounts = {
  ok: number;
  warning: number;
  critical: number;
  noData: number;
  error: number;
};

const STATUS_TO_COUNT_KEY: Record<SnapshotStatus, keyof StatusCounts> = {
  ok: "ok",
  warning: "warning",
  critical: "critical",
  "no-data": "noData",
  error: "error",
};

function incrementByStatus(
  acc: StatusCounts,
  status: SnapshotStatus,
): StatusCounts {
  const { [status]: key } = STATUS_TO_COUNT_KEY;
  return { ...acc, [key]: acc[key] + 1 };
}

export const statusCountsAtom = atom(
  (get): StatusCounts =>
    get(snapshotsAtom).reduce<StatusCounts>(
      (acc, snapshot) => incrementByStatus(acc, snapshot.status),
      { ok: 0, warning: 0, critical: 0, noData: 0, error: 0 },
    ),
);

const TICK_INTERVAL_MS = 1000;

export const nowAtom = atom<number>(Date.now());
nowAtom.onMount = (set) => {
  const id = setInterval(() => {
    set(Date.now());
  }, TICK_INTERVAL_MS);
  return () => {
    clearInterval(id);
  };
};

const SECONDS_PER_MINUTE = 60;
const PADDED_SECOND_WIDTH = 2;
const NO_RESET_LABEL = "--:--";

/**
 * Render a `resetAt` ISO-8601 string as `m:ss` relative to `now` ms. Inlined
 * into `UsageRow` instead of an `atomFamily` so per-row atoms don't outlive
 * the snapshots they describe.
 */
export function formatResetCountdown(
  resetAt: string | null,
  now: number,
): string {
  if (resetAt === null) return NO_RESET_LABEL;
  const resetTime = new Date(resetAt).getTime();
  if (Number.isNaN(resetTime)) return NO_RESET_LABEL;
  const remainingMs = resetTime - now;
  if (remainingMs <= 0) return "0:00";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${minutes.toString()}:${seconds.toString().padStart(PADDED_SECOND_WIDTH, "0")}`;
}
