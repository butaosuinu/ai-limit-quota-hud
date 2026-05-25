import { atom } from "jotai";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_CHANGED_EVENT,
  type OverlaySettings,
} from "../types";
import { normalizeOverlaySettings, type WireOverlaySettings } from "../wire";

export const MIN_OPACITY = 0.15;
export const MAX_OPACITY = 1.0;

export const overlaySettingsAtom = atom<OverlaySettings>(
  DEFAULT_OVERLAY_SETTINGS,
);

overlaySettingsAtom.onMount = (set) => {
  const mount = new AbortController();
  void bootstrapOverlaySync(set, mount.signal);
  return () => mount.abort();
};

async function bootstrapOverlaySync(
  set: (next: OverlaySettings) => void,
  signal: AbortSignal,
): Promise<void> {
  // Subscribe first so events emitted while we wait on `get_overlay_settings`
  // aren't lost. A fresh event aborts this guard so the initial snapshot —
  // which may already be stale — doesn't roll it back.
  const freshEvent = new AbortController();
  const unlisten = await listen<{ settings: WireOverlaySettings }>(
    OVERLAY_SETTINGS_CHANGED_EVENT,
    (event) => {
      freshEvent.abort();
      set(normalizeOverlaySettings(event.payload.settings));
    },
  ).catch((err: unknown) => {
    console.warn("overlay settings event subscription failed", err);
    return undefined;
  });
  if (signal.aborted) {
    if (unlisten !== undefined) unlisten();
    return;
  }
  if (unlisten !== undefined) {
    signal.addEventListener("abort", () => unlisten(), { once: true });
  }

  const wire = await invoke<WireOverlaySettings>("get_overlay_settings").catch(
    (err: unknown) => {
      console.warn("get_overlay_settings failed; staying on defaults", err);
      return undefined;
    },
  );
  if (signal.aborted) return;
  // A stubbed/empty IPC response can yield `undefined`; committing it would
  // crash any consumer that reads `settings.*`.
  const initial =
    wire === undefined ? undefined : normalizeOverlaySettings(wire);
  if (initial !== undefined && !freshEvent.signal.aborted) set(initial);
}

/**
 * Merge a partial settings change and forward it to Rust. The Rust side
 * normalizes + persists and emits `settings-changed`, which our `onMount`
 * listener picks up to update the atom — so we only do the optimistic set.
 */
export const updateOverlaySettingsAtom = atom(
  undefined,
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
