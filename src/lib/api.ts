import { invoke } from "@tauri-apps/api/core";

import type { ManualRow, ManualRowInput, UsageSnapshot } from "./types";

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
