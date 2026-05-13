/**
 * Jotai atoms for the overlay state. The source of truth lives on the Rust
 * side; these atoms cache the latest known state for fast reads inside React
 * components and dispatch updates back through Tauri commands.
 *
 * Bootstrap flow on first subscription:
 *   1. `invoke('get_overlay_settings')` to pull the persisted state.
 *   2. `listen('overlay://settings-changed')` so Rust pushes (tray clicks,
 *      global shortcut, position drag) propagate back to the UI.
 */

import { atom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_CHANGED_EVENT,
  type OverlaySettings,
  type SettingsChangedPayload,
} from "../types";

const MIN_OPACITY = 0.15;
const MAX_OPACITY = 1.0;

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
  const initial = await invoke<OverlaySettings>("get_overlay_settings").catch(
    (err: unknown) => {
      console.warn("get_overlay_settings failed; staying on defaults", err);
      return null;
    },
  );
  if (lifecycle.cancelled) return;
  if (initial !== null) set(initial);

  const unlisten = await listen<SettingsChangedPayload>(
    OVERLAY_SETTINGS_CHANGED_EVENT,
    (event) => {
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
}

/** Merge a partial settings change, push it to Rust, and update the atom. */
export const updateOverlaySettingsAtom = atom(
  null,
  async (get, set, partial: Partial<OverlaySettings>) => {
    const current = get(overlaySettingsAtom);
    const next: OverlaySettings = {
      ...current,
      ...partial,
      opacity: clampOpacity(partial.opacity ?? current.opacity),
    };
    set(overlaySettingsAtom, next);
    const stored = await invoke<OverlaySettings>("update_overlay_settings", {
      settings: next,
    }).catch((err: unknown) => {
      console.warn("update_overlay_settings failed", err);
      return next;
    });
    set(overlaySettingsAtom, stored);
  },
);

export const opacityAtom = atom(
  (get) => get(overlaySettingsAtom).opacity,
  (_get, set, value: number) => {
    void set(updateOverlaySettingsAtom, { opacity: value });
  },
);

export const compactAtom = atom(
  (get) => get(overlaySettingsAtom).compact,
  (_get, set, value: boolean) => {
    void set(updateOverlaySettingsAtom, { compact: value });
  },
);

export const clickThroughAtom = atom(
  (get) => get(overlaySettingsAtom).clickThrough,
  (_get, set, value: boolean) => {
    void set(updateOverlaySettingsAtom, { clickThrough: value });
  },
);

export const lockedAtom = atom(
  (get) => get(overlaySettingsAtom).locked,
  (_get, set, value: boolean) => {
    void set(updateOverlaySettingsAtom, { locked: value });
  },
);

export const visibleAtom = atom(
  (get) => get(overlaySettingsAtom).visible,
  (_get, set, value: boolean) => {
    void set(updateOverlaySettingsAtom, { visible: value });
  },
);

export const resetSettingsAtom = atom(null, (_get, set) => {
  void set(updateOverlaySettingsAtom, DEFAULT_OVERLAY_SETTINGS);
});

export function clampOpacity(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_OVERLAY_SETTINGS.opacity;
  if (value < MIN_OPACITY) return MIN_OPACITY;
  if (value > MAX_OPACITY) return MAX_OPACITY;
  return value;
}
