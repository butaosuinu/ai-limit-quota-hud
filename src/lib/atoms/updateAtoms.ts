import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { atom } from "jotai";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

import { i18n } from "../i18n";
import { UPDATER_STATUS_EVENT, type UpdateStatusPayload } from "../types";

/**
 * Tauri 2 auto-updater bridge.
 *
 * - `updateStatusAtom` is the single source of truth for the UI. The state is
 *   a discriminated union so each rendering branch is exhaustive.
 * - `updater://status` events from the Rust side (e.g. the optional startup
 *   check) populate the atom; explicit user actions go through
 *   `checkForUpdatesAtom` / `downloadAndInstallAtom` / `relaunchAfterUpdateAtom`.
 * - We mirror the `providerSettingsAtom` Failure-sentinel pattern: no
 *   try/catch (forbidden by the project's eslint config), all errors flow
 *   through `.catch(...)` callbacks that return a localized message.
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export const updateStatusAtom = atom<UpdateStatus>({ kind: "idle" });
export const currentVersionAtom = atom<string | null>(null);

type Lifecycle = {
  cancelled: boolean;
  unlisten: (() => void) | null;
};

type StatusUpdater = UpdateStatus | ((prev: UpdateStatus) => UpdateStatus);
type StatusSetter = (next: StatusUpdater) => void;

updateStatusAtom.onMount = (set: StatusSetter) => {
  const lifecycle: Lifecycle = { cancelled: false, unlisten: null };
  void subscribeToBackendStatus(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
    if (lifecycle.unlisten !== null) lifecycle.unlisten();
  };
};

async function subscribeToBackendStatus(
  set: StatusSetter,
  lifecycle: Lifecycle,
): Promise<void> {
  const unlisten = await listen<UpdateStatusPayload>(
    UPDATER_STATUS_EVENT,
    (event) => {
      set((prev) => nextStatusFromBackend(prev, event.payload));
    },
  ).catch(() => null);
  if (unlisten === null) return;
  if (lifecycle.cancelled) {
    unlisten();
    return;
  }
  lifecycle.unlisten = unlisten;
}

function nextStatusFromBackend(
  prev: UpdateStatus,
  payload: UpdateStatusPayload,
): UpdateStatus {
  switch (payload.status) {
    case "noUpdate":
      return prev.kind === "idle" ? prev : { kind: "idle" };
    case "available":
      return {
        kind: "available",
        version: payload.version,
        notes: payload.notes,
      };
    case "error":
      return { kind: "error", message: payload.message };
  }
}

// Cache across mounts: the bundled version is immutable for the app's
// lifetime, so each remount of UpdatesPanel shouldn't re-issue the IPC.
let cachedVersion: string | null = null;

currentVersionAtom.onMount = (set: (next: string | null) => void) => {
  if (cachedVersion !== null) {
    set(cachedVersion);
    return;
  }
  const lifecycle: Lifecycle = { cancelled: false, unlisten: null };
  void (async () => {
    const v = await getVersion().catch(() => null);
    if (lifecycle.cancelled || v === null) return;
    cachedVersion = v;
    set(v);
  })();
  return () => {
    lifecycle.cancelled = true;
  };
};

// Sentinel-based Failure pattern (same as providerSettingsAtom): lets us
// thread errors through async pipelines without try/catch.
const FAILURE_MARKER = Symbol("update-atom-failure");
type Failure = { readonly [FAILURE_MARKER]: true; message: string };
const failure = (message: string): Failure => ({
  [FAILURE_MARKER]: true,
  message,
});
const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && FAILURE_MARKER in value;

const MSG = {
  checkFailed: msg`アップデート確認に失敗`,
  downloadFailed: msg`アップデートのダウンロードに失敗`,
};

function describeError(action: MessageDescriptor, err: unknown): string {
  const label = i18n._(action);
  if (typeof err === "string") return `${label}: ${err}`;
  if (err instanceof Error) return `${label}: ${err.message}`;
  return label;
}

/**
 * Holds the `Update` resource returned by `check()` so the install action can
 * be driven from a separate atom without re-running the check.
 */
const pendingUpdateAtom = atom<Update | null>(null);

/** Trigger an explicit "check now" round-trip. */
export const checkForUpdatesAtom = atom(null, async (_get, set) => {
  set(updateStatusAtom, { kind: "checking" });
  const result = await check().catch(
    (err: unknown): Failure => failure(describeError(MSG.checkFailed, err)),
  );
  if (isFailure(result)) {
    set(updateStatusAtom, { kind: "error", message: result.message });
    return;
  }
  if (result === null) {
    set(updateStatusAtom, { kind: "idle" });
    set(pendingUpdateAtom, null);
    return;
  }
  set(pendingUpdateAtom, result);
  set(updateStatusAtom, {
    kind: "available",
    version: result.version,
    notes: result.body ?? "",
  });
});

/**
 * Download + install the pending update. The plugin emits `Started`,
 * `Progress`, `Finished` events; we surface `Progress` as a running byte
 * count and `Finished` as `ready` (which unlocks the relaunch button).
 *
 * When the `available` status was published by the Rust startup check, the
 * `Update` resource lives in the backend's plugin instance, not in the
 * frontend's `pendingUpdateAtom`. Re-run `check()` to materialize it here
 * before kicking off the download.
 */
export const downloadAndInstallAtom = atom(null, async (get, set) => {
  let update = get(pendingUpdateAtom);
  if (update === null) {
    const recheck = await check().catch(
      (err: unknown): Failure =>
        failure(describeError(MSG.downloadFailed, err)),
    );
    if (isFailure(recheck)) {
      set(updateStatusAtom, { kind: "error", message: recheck.message });
      return;
    }
    if (recheck === null) {
      set(updateStatusAtom, { kind: "idle" });
      return;
    }
    update = recheck;
    set(pendingUpdateAtom, recheck);
  }

  set(updateStatusAtom, { kind: "downloading", progress: 0 });
  let downloaded = 0;
  const result = await update
    .downloadAndInstall((event) => {
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        set(updateStatusAtom, { kind: "downloading", progress: downloaded });
      } else if (event.event === "Finished") {
        set(updateStatusAtom, { kind: "ready" });
      }
    })
    .catch(
      (err: unknown): Failure =>
        failure(describeError(MSG.downloadFailed, err)),
    );
  if (isFailure(result)) {
    set(updateStatusAtom, { kind: "error", message: result.message });
  }
});

/** Relaunch the app once an update has finished installing. */
export const relaunchAfterUpdateAtom = atom(null, async () => {
  await relaunch();
});
