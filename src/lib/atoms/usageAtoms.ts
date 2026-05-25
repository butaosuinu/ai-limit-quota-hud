import { atom } from "jotai";
import { listen } from "@tauri-apps/api/event";

import { listSnapshots } from "../api";
import {
  USAGE_UPDATED_EVENT,
  type ProviderKind,
  type SnapshotStatus,
  type UsageSnapshot,
} from "../types";
import { normalizeSnapshots, type WireUsageSnapshot } from "../wire";

export const snapshotsAtom = atom<readonly UsageSnapshot[]>([]);

type Lifecycle = {
  cancelled: boolean;
  unlisten: (() => void) | undefined;
};

snapshotsAtom.onMount = (set) => {
  const lifecycle: Lifecycle = { cancelled: false, unlisten: undefined };
  void bootstrapUsageSync(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
    if (lifecycle.unlisten !== undefined) lifecycle.unlisten();
  };
};

async function bootstrapUsageSync(
  set: (next: readonly UsageSnapshot[]) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  let receivedFreshEvent = false;
  const unlisten = await listen<readonly WireUsageSnapshot[]>(
    USAGE_UPDATED_EVENT,
    (event) => {
      receivedFreshEvent = true;
      set(normalizeSnapshots(event.payload));
    },
  ).catch((err: unknown) => {
    console.warn("usage subscription failed", err);
    return undefined;
  });
  if (lifecycle.cancelled) {
    if (unlisten !== undefined) unlisten();
    return;
  }
  lifecycle.unlisten = unlisten;

  const initial = await listSnapshots().catch((err: unknown) => {
    console.warn("list_snapshots failed", err);
    return undefined;
  });
  if (lifecycle.cancelled) return;
  if (initial !== undefined && !receivedFreshEvent) set(initial);
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

export type SnapshotGroupLabel = "Claude" | "Codex";

export type SnapshotGroup = {
  kind: ProviderKind;
  label: SnapshotGroupLabel;
  snapshots: readonly UsageSnapshot[];
};

const PROVIDER_GROUPS: ReadonlyArray<{
  kind: ProviderKind;
  label: SnapshotGroupLabel;
}> = [
  { kind: "webview-claude-ai", label: "Claude" },
  { kind: "webview-chatgpt-codex", label: "Codex" },
];

export const groupedSnapshotsAtom = atom((get): readonly SnapshotGroup[] => {
  const sorted = get(sortedSnapshotsAtom);
  const byKind = sorted.reduce<Map<ProviderKind, UsageSnapshot[]>>(
    (acc, snapshot) => {
      const bucket = acc.get(snapshot.providerKind);
      if (bucket === undefined) {
        acc.set(snapshot.providerKind, [snapshot]);
      } else {
        bucket.push(snapshot);
      }
      return acc;
    },
    new Map(),
  );
  return PROVIDER_GROUPS.flatMap(({ kind, label }) => {
    const snapshots = byKind.get(kind);
    return snapshots === undefined ? [] : [{ kind, label, snapshots }];
  });
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

const NO_RESET_LABEL = "--:--";

/**
 * Render `resetAt` as absolute local time: `HH:MM` on the same calendar
 * day as `now`, otherwise `M/D HH:MM`. Past timestamps render the same way
 * — the underlying snapshot may be stale and the next refresh will
 * replace it.
 */
export function formatResetCountdown(
  resetAt: string | undefined,
  now: number,
): string {
  if (resetAt === undefined) return NO_RESET_LABEL;
  const resetMs = new Date(resetAt).getTime();
  if (Number.isNaN(resetMs)) return NO_RESET_LABEL;
  const resetDate = new Date(resetMs);
  const nowDate = new Date(now);
  const hh = resetDate.getHours().toString().padStart(2, "0");
  const mm = resetDate.getMinutes().toString().padStart(2, "0");
  const sameDay =
    resetDate.getFullYear() === nowDate.getFullYear() &&
    resetDate.getMonth() === nowDate.getMonth() &&
    resetDate.getDate() === nowDate.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const mo = (resetDate.getMonth() + 1).toString();
  const da = resetDate.getDate().toString();
  return `${mo}/${da} ${hh}:${mm}`;
}
