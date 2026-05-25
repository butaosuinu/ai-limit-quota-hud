import { invoke } from "@tauri-apps/api/core";

import type { ProviderKind, ProviderSettings, UsageSnapshot } from "./types";
import { normalizeSnapshots, type WireUsageSnapshot } from "./wire";

export const listSnapshots = async (): Promise<UsageSnapshot[]> =>
  normalizeSnapshots(await invoke<WireUsageSnapshot[]>("list_snapshots"));

export const refreshNow = async (): Promise<unknown> =>
  await invoke<unknown>("refresh_now");

export const getRefreshInterval = async (): Promise<number> =>
  await invoke<number>("get_refresh_interval");

export const setRefreshInterval = async (seconds: number): Promise<unknown> =>
  await invoke<unknown>("set_refresh_interval", { seconds });

// WebView-backed provider opt-in (PROJECT_SPEC §8).

export const getProviderSettings = async (): Promise<ProviderSettings> =>
  await invoke<ProviderSettings>("get_provider_settings");

export const setProviderEnabled = async (
  kind: ProviderKind,
  enabled: boolean,
): Promise<unknown> =>
  await invoke<unknown>("set_provider_enabled", { kind, enabled });

export const openProviderLoginWindow = async (
  kind: ProviderKind,
): Promise<unknown> =>
  await invoke<unknown>("open_provider_login_window", { kind });

export const deleteProviderData = async (
  kind: ProviderKind,
): Promise<unknown> => await invoke<unknown>("delete_provider_data", { kind });
