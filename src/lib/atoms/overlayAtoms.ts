import { atom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_CHANGED_EVENT,
  type OverlaySettings,
  type SettingsChangedPayload,
} from "../types";

export const MIN_OPACITY = 0.15;
export const MAX_OPACITY = 1.0;

export const overlaySettingsAtom = atom<OverlaySettings>(
  DEFAULT_OVERLAY_SETTINGS,
);

type Lifecycle = {
  cancelled: boolean;
  unlisten: (() => void) | null;
};

overlaySettingsAtom.onMount = (set) => {
  const lifecycle: Lifecycle = { cancelled: false, unlisten: null };
  void bootstrapOverlaySync(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
    if (lifecycle.unlisten !== null) lifecycle.unlisten();
  };
};

async function bootstrapOverlaySync(
  set: (next: OverlaySettings) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  // Subscribe first so events emitted while we wait on `get_overlay_settings`
  // aren't lost. Track whether a fresher event has already landed so the
  // initial snapshot — which may already be stale — doesn't roll it back.
  let receivedFreshEvent = false;
  const unlisten = await listen<SettingsChangedPayload>(
    OVERLAY_SETTINGS_CHANGED_EVENT,
    (event) => {
      receivedFreshEvent = true;
      set(event.payload.settings);
    },
  ).catch((err: unknown) => {
    console.warn("overlay settings event subscription failed", err);
    return null;
  });
  if (lifecycle.cancelled) {
    if (unlisten !== null) unlisten();
    return;
  }
  lifecycle.unlisten = unlisten;

  const initial = await invoke<OverlaySettings>("get_overlay_settings").catch(
    (err: unknown) => {
      console.warn("get_overlay_settings failed; staying on defaults", err);
      return null;
    },
  );
  if (lifecycle.cancelled) return;
  if (initial !== null && !receivedFreshEvent) set(initial);
}

/**
 * Merge a partial settings change and forward it to Rust. The Rust side
 * normalizes + persists and emits `settings-changed`, which our `onMount`
 * listener picks up to update the atom — so we only do the optimistic set.
 */
export const updateOverlaySettingsAtom = atom(
  null,
  async (get, set, partial: Partial<OverlaySettings>) => {
    const current = get(overlaySettingsAtom);
    const next: OverlaySettings = {
      ...current,
      ...partial,
      opacity: clampOpacity(partial.opacity ?? current.opacity),
    };
    if (next === current) return;
    set(overlaySettingsAtom, next);
    await invoke("update_overlay_settings", { settings: next }).catch(
      (err: unknown) => {
        console.warn("update_overlay_settings failed", err);
      },
    );
  },
);

export function clampOpacity(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_OVERLAY_SETTINGS.opacity;
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, value));
}
