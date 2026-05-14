import { invoke } from "@tauri-apps/api/core";

import type {
  ManualRow,
  ManualRowInput,
  ProviderKind,
  ProviderSettings,
  UsageSnapshot,
} from "./types";

export const listSnapshots = async (): Promise<UsageSnapshot[]> =>
  await invoke<UsageSnapshot[]>("list_snapshots");

export const refreshNow = async (): Promise<unknown> =>
  await invoke<unknown>("refresh_now");

export const listManualRows = async (): Promise<ManualRow[]> =>
  await invoke<ManualRow[]>("list_manual_rows");

export const createManualRow = async (
  input: ManualRowInput,
): Promise<ManualRow> =>
  await invoke<ManualRow>("create_manual_row", { input });

export const updateManualRow = async (
  id: string,
  input: ManualRowInput,
): Promise<ManualRow> =>
  await invoke<ManualRow>("update_manual_row", { id, input });

export const deleteManualRow = async (id: string): Promise<unknown> =>
  await invoke<unknown>("delete_manual_row", { id });

export const getRefreshInterval = async (): Promise<number> =>
  await invoke<number>("get_refresh_interval");

export const setRefreshInterval = async (seconds: number): Promise<unknown> =>
  await invoke<unknown>("set_refresh_interval", { seconds });

// WebView-backed provider opt-in (PROJECT_SPEC §8.7). The login and delete
// commands are stubs in the foundation PR — they currently return an error
// pointing at issues #30 / #31. Keeping the function signatures stable lets
// the eventual SettingsPanel UI be written against the final IPC contract.

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
