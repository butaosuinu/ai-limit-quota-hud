import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { atom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
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

/**
 * `true` when the running binary has the Tauri updater plugin compiled in
 * (CI builds with `TAURI_UPDATER_PUBKEY` configured). Builds without it
 * disable the Updates action buttons so a click can't surface a
 * "plugin not registered" runtime error.
 */
export const updaterAvailableAtom = atom<boolean>(false);

updaterAvailableAtom.onMount = (set) => {
  let cancelled = false;
  void (async () => {
    const available = await invoke<boolean>("updater_is_available").catch(
      () => false,
    );
    if (!cancelled) set(available);
  })();
  return () => {
    cancelled = true;
  };
};

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

  // The startup updater check may have emitted before we registered the
  // listener above (it runs from `setup()` in lib.rs, before the settings
  // webview mounts). Pull the persisted result so the UI doesn't miss it.
  const last = await invoke<UpdateStatusPayload | null>(
    "get_last_update_status",
  ).catch(() => null);
  if (lifecycle.cancelled || last == null) return;
  set((prev) => nextStatusFromBackend(prev, last));
}

function shouldIgnoreBackendUpdate(
  prev: UpdateStatus,
  payload: UpdateStatusPayload,
): boolean {
  // Manual operations (Check now / Download / Install) must win over backend
  // events. A late startup `noUpdate` arriving while the user is mid-check or
  // mid-download must not yank the UI back to idle and re-enable buttons.
  if (
    prev.kind === "checking" ||
    prev.kind === "downloading" ||
    prev.kind === "ready"
  ) {
    return true;
  }
  // An authoritative `available` (set by a manual check or by a fresher
  // backend snapshot) must not be downgraded by a stale `noUpdate` / `error`
  // arriving from an older startup check or from `get_last_update_status`.
  // A newer `available` payload still upgrades — handled in the case below.
  //
  // Similarly, a fresh manual `error` must not be silently cleared by a late
  // `noUpdate`; the user needs to see the failure. Backend `available` and
  // `error` payloads are still allowed to overwrite an existing error since
  // those represent strictly newer information.
  if (
    prev.kind === "available" &&
    (payload.status === "noUpdate" || payload.status === "error")
  ) {
    return true;
  }
  if (prev.kind === "error" && payload.status === "noUpdate") {
    return true;
  }
  return false;
}

function nextStatusFromBackend(
  prev: UpdateStatus,
  payload: UpdateStatusPayload,
): UpdateStatus {
  if (shouldIgnoreBackendUpdate(prev, payload)) return prev;
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

/**
 * `Update` is a Tauri Resource: the backend allocates a resource ID that
 * leaks until `close()` is called or the process exits. Repeatedly checking
 * for updates in a long-running session would accumulate dead handles, so
 * every replace / clear / consume site routes through this helper.
 */
async function closeUpdate(update: Update | null): Promise<void> {
  if (update === null) return;
  // Resource.close() is the real plugin's disposer; tolerate test doubles
  // that omit it, and swallow rejections so a release failure can't tank
  // the caller's state transition.
  if (typeof update.close !== "function") return;
  await update.close().catch(() => undefined);
}

/** Trigger an explicit "check now" round-trip. */
export const checkForUpdatesAtom = atom(null, async (get, set) => {
  set(updateStatusAtom, { kind: "checking" });
  const result = await check().catch(
    (err: unknown): Failure => failure(describeError(MSG.checkFailed, err)),
  );
  if (isFailure(result)) {
    // Even on failure, drop the previous handle: callers can't act on it
    // anymore (UI has moved to `error`), and leaving it open accumulates
    // backend resource IDs across repeated failed sessions.
    await closeUpdate(get(pendingUpdateAtom));
    set(pendingUpdateAtom, null);
    set(updateStatusAtom, { kind: "error", message: result.message });
    return;
  }
  // Whatever we hold now is about to be replaced; release its backend handle.
  await closeUpdate(get(pendingUpdateAtom));
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
  // Reserve the slot synchronously: the download button only renders in
  // `available` state, and the kind transition unmounts it. Without this
  // up-front write, rapid double-clicks fire before React unmounts the
  // button and queue overlapping `check()` / `downloadAndInstall()` IPCs.
  const status = get(updateStatusAtom);
  if (status.kind !== "available") return;
  const { version: displayedVersion } = status;
  set(updateStatusAtom, { kind: "downloading", progress: 0 });

  // The cached Update may be stale: a fresher backend `available` event can
  // overwrite the displayed version while leaving an older Update resource
  // in `pendingUpdateAtom`. Re-fetch unless the cached version matches what
  // the user is looking at, so we never install an older release than the
  // one shown on the panel.
  const cached = get(pendingUpdateAtom);
  let update =
    cached !== null && cached.version === displayedVersion ? cached : null;
  if (update === null) {
    // Release the stale handle (if any) before allocating a new one.
    if (cached !== null) await closeUpdate(cached);
    const recheck = await check().catch(
      (err: unknown): Failure =>
        failure(describeError(MSG.downloadFailed, err)),
    );
    if (isFailure(recheck)) {
      set(pendingUpdateAtom, null);
      set(updateStatusAtom, { kind: "error", message: recheck.message });
      return;
    }
    if (recheck === null) {
      set(pendingUpdateAtom, null);
      set(updateStatusAtom, { kind: "idle" });
      return;
    }
    update = recheck;
    set(pendingUpdateAtom, recheck);
  }

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
  // The handle is consumed regardless of outcome; drop it so future
  // `available` cycles allocate a fresh resource.
  await closeUpdate(update);
  set(pendingUpdateAtom, null);
  if (isFailure(result)) {
    set(updateStatusAtom, { kind: "error", message: result.message });
  }
});

/** Relaunch the app once an update has finished installing. */
export const relaunchAfterUpdateAtom = atom(null, async () => {
  await relaunch();
});
