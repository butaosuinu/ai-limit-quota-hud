import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { atom } from "jotai";

import {
  deleteProviderData,
  getProviderSettings,
  openProviderLoginWindow,
  setProviderEnabled,
} from "../api";
import { i18n } from "../i18n";
import {
  DEFAULT_PROVIDER_SETTINGS,
  type ProviderKind,
  type ProviderSettings,
} from "../types";

/**
 * Frontend cache of per-provider opt-in state (PROJECT_SPEC §8.7).
 *
 * Mirrors `provider_settings.json` on the Rust side. The cache exists so the
 * settings UI can render toggles synchronously after first mount; writes
 * round-trip through the Tauri command before the cache reflects the new
 * value, so an IPC failure leaves the UI consistent with disk.
 *
 * `generation` increments on every user-triggered write so a slow bootstrap
 * fetch that resolves after a toggle can detect that in-memory state is
 * fresher than the fetched payload — matches the pattern used by
 * `manualAtoms`.
 */
type ProviderSettingsState = {
  settings: ProviderSettings;
  error: string | null;
  generation: number;
};

const INITIAL_GENERATION = 0;

const stateAtom = atom<ProviderSettingsState>({
  settings: DEFAULT_PROVIDER_SETTINGS,
  error: null,
  generation: INITIAL_GENERATION,
});

type Lifecycle = { cancelled: boolean };

stateAtom.onMount = (set) => {
  const lifecycle: Lifecycle = { cancelled: false };
  void bootstrap(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
  };
};

// Sentinel-based Failure pattern (same as manualAtoms.ts): lets us thread
// errors through async pipelines without try/catch, which the project's
// eslint config forbids.
const FAILURE_MARKER = Symbol("provider-settings-failure");
type Failure = { readonly [FAILURE_MARKER]: true; message: string };
const failure = (message: string): Failure => ({
  [FAILURE_MARKER]: true,
  message,
});
const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && FAILURE_MARKER in value;

const MSG = {
  fetchFailed: msg`プロバイダ設定の取得に失敗`,
  toggleFailed: msg`プロバイダの有効化に失敗`,
  loginFailed: msg`ログインウィンドウを開けませんでした`,
  deleteFailed: msg`プロバイダデータの削除に失敗`,
};

// Localized at call time via the live i18n singleton. Locale changes after the
// error has been written into atom state will not retranslate the stored
// string — acceptable trade-off since errors are transient.
function describeError(action: MessageDescriptor, err: unknown): string {
  const label = i18n._(action);
  if (typeof err === "string") return `${label}: ${err}`;
  if (err instanceof Error) return `${label}: ${err.message}`;
  return label;
}

async function bootstrap(
  setState: (
    next:
      | ProviderSettingsState
      | ((prev: ProviderSettingsState) => ProviderSettingsState),
  ) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  const result = await getProviderSettings().catch(
    (err: unknown): Failure => failure(describeError(MSG.fetchFailed, err)),
  );
  if (lifecycle.cancelled) return;
  if (isFailure(result)) {
    setState((prev) => ({ ...prev, error: result.message }));
    return;
  }
  setState((prev) => {
    // A user mutation happened during the fetch. Keep the fresher state and
    // discard the stale bootstrap payload.
    if (prev.generation !== INITIAL_GENERATION) return prev;
    return { ...prev, settings: result };
  });
}

/** Read-only view of the cached provider settings. */
export const providerSettingsAtom = atom((get) => get(stateAtom).settings);

/** Latest error from any bootstrap / write attempt, or `null` if clean. */
export const providerSettingsErrorAtom = atom((get) => get(stateAtom).error);

/** Derived helper for "is this WebView provider enabled in the cache?". */
export const isProviderEnabledAtom = atom(
  (get) =>
    (kind: ProviderKind): boolean =>
      get(stateAtom).settings.enabled[kind] ?? false,
);

/**
 * Write atom: persist a toggle change and refresh the cache.
 *
 * On IPC failure the cache is left untouched and the error message is stored
 * on the state. The caller should treat the returned promise as success /
 * failure (it never throws) and let the UI render `providerSettingsErrorAtom`.
 */
export const setProviderEnabledAtom = atom(
  null,
  async (
    _get,
    set,
    payload: { kind: ProviderKind; enabled: boolean },
  ): Promise<void> => {
    const result = await setProviderEnabled(
      payload.kind,
      payload.enabled,
    ).catch(
      (err: unknown): Failure => failure(describeError(MSG.toggleFailed, err)),
    );
    if (isFailure(result)) {
      set(stateAtom, (prev) => ({ ...prev, error: result.message }));
      return;
    }
    set(stateAtom, (prev) => ({
      settings: {
        enabled: { ...prev.settings.enabled, [payload.kind]: payload.enabled },
      },
      error: null,
      generation: prev.generation + 1,
    }));
  },
);

/**
 * Write atom: trigger the provider's first-party login window.
 *
 * Backed by the `open_provider_login_window` Tauri command, which is a stub
 * in the foundation PR — it surfaces an error pointing at the issue that
 * wires up the real WebView. The atom keeps the same shape so the eventual
 * UI work doesn't need to be rewritten when the backend lands.
 */
export const openProviderLoginAtom = atom(
  null,
  async (_get, set, kind: ProviderKind): Promise<void> => {
    const result = await openProviderLoginWindow(kind).catch(
      (err: unknown): Failure => failure(describeError(MSG.loginFailed, err)),
    );
    if (isFailure(result)) {
      set(stateAtom, (prev) => ({ ...prev, error: result.message }));
      return;
    }
    set(stateAtom, (prev) => ({ ...prev, error: null }));
  },
);

/**
 * Write atom: clear the provider's persistent session data (cookie store,
 * `WKWebsiteDataStore`, etc.). Forces re-login on the next refresh.
 *
 * Stubbed in the foundation PR, same as `openProviderLoginAtom`.
 */
export const deleteProviderDataAtom = atom(
  null,
  async (_get, set, kind: ProviderKind): Promise<void> => {
    const result = await deleteProviderData(kind).catch(
      (err: unknown): Failure => failure(describeError(MSG.deleteFailed, err)),
    );
    if (isFailure(result)) {
      set(stateAtom, (prev) => ({ ...prev, error: result.message }));
      return;
    }
    set(stateAtom, (prev) => ({ ...prev, error: null }));
  },
);
