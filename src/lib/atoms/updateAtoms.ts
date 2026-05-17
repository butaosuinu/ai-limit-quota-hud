import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { atom } from "jotai";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

import { i18n } from "../i18n";

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

/** Mirrors `UpdateStatusPayload` on the Rust side (camelCase + status tag). */
type BackendStatusPayload =
  | { status: "checking" }
  | { status: "noUpdate" }
  | { status: "available"; version: string; notes: string }
  | { status: "error"; message: string };

export const UPDATER_STATUS_EVENT = "updater://status";

export const updateStatusAtom = atom<UpdateStatus>({ kind: "idle" });
export const currentVersionAtom = atom<string | null>(null);

type StatusSetter = (next: UpdateStatus) => void;

updateStatusAtom.onMount = (set: StatusSetter) => {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  void (async () => {
    const off = await listen<BackendStatusPayload>(
      UPDATER_STATUS_EVENT,
      (event) => {
        applyBackendStatus(set, event.payload);
      },
    ).catch(() => null);
    if (off === null) return;
    if (cancelled) off();
    else unlisten = off;
  })();

  return () => {
    cancelled = true;
    if (unlisten !== null) unlisten();
  };
};

function applyBackendStatus(
  set: StatusSetter,
  payload: BackendStatusPayload,
): void {
  if (payload.status === "checking") {
    set({ kind: "checking" });
    return;
  }
  if (payload.status === "noUpdate") {
    set({ kind: "idle" });
    return;
  }
  if (payload.status === "available") {
    set({
      kind: "available",
      version: payload.version,
      notes: payload.notes,
    });
    return;
  }
  set({ kind: "error", message: payload.message });
}

type VersionSetter = (next: string | null) => void;

currentVersionAtom.onMount = (set: VersionSetter) => {
  let cancelled = false;
  void (async () => {
    const v = await getVersion().catch(() => null);
    if (!cancelled && v !== null) set(v);
  })();
  return () => {
    cancelled = true;
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
 */
export const downloadAndInstallAtom = atom(null, async (get, set) => {
  const update = get(pendingUpdateAtom);
  if (update === null) return;
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
