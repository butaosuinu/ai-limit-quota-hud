import { invoke } from "@tauri-apps/api/core";
import { vi } from "vitest";

import { DEFAULT_OVERLAY_SETTINGS } from "../../lib/types";

type AsyncFn = (args?: unknown) => Promise<unknown>;
type InvokeMap = Record<string, unknown>;

const DEFAULTS: InvokeMap = {
  get_overlay_settings: { ...DEFAULT_OVERLAY_SETTINGS },
  get_provider_settings: { enabled: {} },
  list_snapshots: [],
  get_refresh_interval: 60,
  refresh_now: undefined,
  set_refresh_interval: undefined,
  set_provider_enabled: undefined,
  open_provider_login_window: undefined,
  delete_provider_data: undefined,
  update_overlay_settings: undefined,
};

/**
 * Detroit-style helper: registers per-command responses for `invoke` so tests
 * can drive the IPC boundary and then observe DOM / atom state — not call
 * histories.
 *
 * The map is merged onto a default that returns safe values for known atom
 * bootstrap commands, so a test only needs to declare the commands whose
 * behavior it wants to assert.
 */
export function setupInvoke(map: InvokeMap = {}): void {
  const merged: InvokeMap = { ...DEFAULTS, ...map };
  const mocked = vi.mocked(invoke);
  mocked.mockReset();
  mocked.mockImplementation(async (cmd: string, args?: unknown) => {
    if (!Object.hasOwn(merged, cmd)) return undefined;
    const entry = merged[cmd];
    if (typeof entry === "function") {
      return await (entry as AsyncFn)(args);
    }
    return entry;
  });
}

export function resetInvoke(): void {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async () => undefined);
}
