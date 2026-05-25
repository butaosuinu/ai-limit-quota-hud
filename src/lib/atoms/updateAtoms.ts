import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { atom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

import { i18n } from "../i18n";
import {
  UPDATER_STATUS_EVENT,
  type UpdateStatusEvent,
  type UpdateStatusPayload,
} from "../types";

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
export const currentVersionAtom = atom<string | undefined>(undefined);

type Lifecycle = {
  cancelled: boolean;
  unlisten: (() => void) | undefined;
};

type StatusUpdater = UpdateStatus | ((prev: UpdateStatus) => UpdateStatus);
type StatusSetter = (next: StatusUpdater) => void;

updateStatusAtom.onMount = (set: StatusSetter) => {
  const lifecycle: Lifecycle = { cancelled: false, unlisten: undefined };
  void subscribeToBackendStatus(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
    if (lifecycle.unlisten !== undefined) lifecycle.unlisten();
  };
};

async function subscribeToBackendStatus(
  set: StatusSetter,
  lifecycle: Lifecycle,
): Promise<void> {
  const unlisten = await listen<UpdateStatusEvent>(
    UPDATER_STATUS_EVENT,
    (event) => {
      // Live events are the freshest backend knowledge. A `daily` check is
      // authoritative (see `shouldIgnoreBackendUpdate`); a `startup` check is
      // treated conservatively because it can race a manual "check now".
      const isDailyCheck = event.payload.source === "daily";
      set((prev) => nextStatusFromBackend(prev, event.payload, isDailyCheck));
    },
  ).catch(() => undefined);
  if (unlisten === undefined) return;
  if (lifecycle.cancelled) {
    unlisten();
    return;
  }
  lifecycle.unlisten = unlisten;

  // The startup updater check may have emitted before we registered the
  // listener above (it runs from `setup()` in lib.rs, before the settings
  // webview mounts). Pull the persisted result so the UI doesn't miss it.
  // Rust returns `Option<UpdateStatusPayload>` (JSON null when absent); a
  // stubbed IPC can resolve undefined — coalesce both to undefined.
  const last =
    (await invoke<UpdateStatusPayload | null>("get_last_update_status").catch(
      () => undefined,
    )) ?? undefined;
  if (lifecycle.cancelled || last === undefined) return;
  // A bootstrap replay can be stale relative to a manual check the user has
  // already run, so it is never treated as an authoritative daily result.
  set((prev) => nextStatusFromBackend(prev, last, false));
}

// Manual operations (Check now / Download / Install) must win over backend
// events: a late `noUpdate` arriving while the user is mid-check or
// mid-download must not yank the UI back to idle and re-enable buttons.
function isManualOperationActive(prev: UpdateStatus): boolean {
  return (
    prev.kind === "checking" ||
    prev.kind === "downloading" ||
    prev.kind === "ready"
  );
}

// An authoritative `available` (set by a manual check or a fresher backend
// snapshot) must not be downgraded by a stale `noUpdate` / `error` arriving
// from a concurrent startup check or from `get_last_update_status`; a newer
// `available` still upgrades. Likewise a fresh manual `error` must not be
// silently cleared by a late `noUpdate` — the user needs to see the failure.
function downgradesAuthoritativeState(
  prev: UpdateStatus,
  payload: UpdateStatusPayload,
): boolean {
  if (
    prev.kind === "available" &&
    (payload.status === "noUpdate" || payload.status === "error")
  ) {
    return true;
  }
  return prev.kind === "error" && payload.status === "noUpdate";
}

function shouldIgnoreBackendUpdate(
  prev: UpdateStatus,
  payload: UpdateStatusPayload,
  isDailyCheck: boolean,
): boolean {
  if (isManualOperationActive(prev)) return true;
  // A daily check is the freshest backend knowledge: a definitive `noUpdate`
  // (the release was withdrawn, or the user updated by other means) must clear
  // a now-stale `available`/`error` instead of leaving it stuck on screen. A
  // daily `error`, by contrast, is a transient failure (network blip) and is
  // left to the conservative guard below so it cannot hide a known `available`.
  if (isDailyCheck && payload.status === "noUpdate") return false;
  return downgradesAuthoritativeState(prev, payload);
}

function nextStatusFromBackend(
  prev: UpdateStatus,
  payload: UpdateStatusPayload,
  isDailyCheck: boolean,
): UpdateStatus {
  if (shouldIgnoreBackendUpdate(prev, payload, isDailyCheck)) return prev;
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

// The bundled version is fixed for the app's lifetime, so resolve it once on
// the first mount and share the promise across every later UpdatesPanel mount
// (remounts then don't re-issue the IPC). `undefined` = lookup failed (e.g. the
// non-Tauri test env); the version row then renders "—".
const versionCache: { promise?: Promise<string | undefined> } = {};
const loadBundledVersion = (): Promise<string | undefined> =>
  (versionCache.promise ??= getVersion().catch(() => undefined));

currentVersionAtom.onMount = (set: (next: string | undefined) => void) => {
  const lifecycle = { cancelled: false };
  void (async () => {
    const v = await loadBundledVersion();
    if (lifecycle.cancelled || v === undefined) return;
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
const pendingUpdateAtom = atom<Update | undefined>(undefined);

/**
 * `Update` is a Tauri Resource: the backend allocates a resource ID that
 * leaks until `close()` is called or the process exits. Repeatedly checking
 * for updates in a long-running session would accumulate dead handles, so
 * every replace / clear / consume site routes through this helper.
 */
async function closeUpdate(update: Update | undefined): Promise<void> {
  if (update === undefined) return;
  // Resource.close() is the real plugin's disposer; tolerate test doubles
  // that omit it, and swallow rejections so a release failure can't tank
  // the caller's state transition.
  if (typeof update.close !== "function") return;
  await update.close().catch(() => undefined);
}

/**
 * Resolve the `Update` handle to install. Reuses the cached handle when it
 * matches the version shown on the panel; otherwise releases the stale handle
 * and re-runs `check()` so a fresher backend `available` is never installed as
 * an older release. Returns `undefined` when no update is available.
 */
async function resolveUpdateHandle(
  cached: Update | undefined,
  displayedVersion: string,
): Promise<Update | Failure | undefined> {
  if (cached?.version === displayedVersion) return cached;
  if (cached !== undefined) await closeUpdate(cached);
  // `check()` resolves null when no update is available; normalize to undefined.
  const checked = await check().catch(
    (err: unknown): Failure => failure(describeError(MSG.downloadFailed, err)),
  );
  return checked ?? undefined;
}

/** Trigger an explicit "check now" round-trip. */
export const checkForUpdatesAtom = atom(undefined, async (get, set) => {
  set(updateStatusAtom, { kind: "checking" });
  const result = await check().catch(
    (err: unknown): Failure => failure(describeError(MSG.checkFailed, err)),
  );
  if (isFailure(result)) {
    // Even on failure, drop the previous handle: callers can't act on it
    // anymore (UI has moved to `error`), and leaving it open accumulates
    // backend resource IDs across repeated failed sessions.
    await closeUpdate(get(pendingUpdateAtom));
    set(pendingUpdateAtom, undefined);
    set(updateStatusAtom, { kind: "error", message: result.message });
    return;
  }
  // Whatever we hold now is about to be replaced; release its backend handle.
  await closeUpdate(get(pendingUpdateAtom));
  // `check()` resolves null when no update is available; normalize to undefined.
  const update = result ?? undefined;
  if (update === undefined) {
    set(updateStatusAtom, { kind: "idle" });
    set(pendingUpdateAtom, undefined);
    return;
  }
  set(pendingUpdateAtom, update);
  set(updateStatusAtom, {
    kind: "available",
    version: update.version,
    notes: update.body ?? "",
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
export const downloadAndInstallAtom = atom(undefined, async (get, set) => {
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
  // in `pendingUpdateAtom`. `resolveUpdateHandle` re-fetches unless the cached
  // version matches what the user is looking at.
  const cached = get(pendingUpdateAtom);
  const resolved = await resolveUpdateHandle(cached, displayedVersion);
  if (isFailure(resolved)) {
    set(pendingUpdateAtom, undefined);
    set(updateStatusAtom, { kind: "error", message: resolved.message });
    return;
  }
  if (resolved === undefined) {
    set(pendingUpdateAtom, undefined);
    set(updateStatusAtom, { kind: "idle" });
    return;
  }
  const update = resolved;
  // A freshly re-checked handle (≠ cached) becomes the new pending resource.
  if (update !== cached) set(pendingUpdateAtom, update);

  const result = await update
    .downloadAndInstall((event) => {
      if (event.event === "Progress") {
        set(updateStatusAtom, (prev) =>
          prev.kind === "downloading"
            ? {
                kind: "downloading",
                progress: prev.progress + event.data.chunkLength,
              }
            : prev,
        );
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
  set(pendingUpdateAtom, undefined);
  if (isFailure(result)) {
    set(updateStatusAtom, { kind: "error", message: result.message });
  }
});

/** Relaunch the app once an update has finished installing. */
export const relaunchAfterUpdateAtom = atom(undefined, async () => {
  await relaunch();
});
