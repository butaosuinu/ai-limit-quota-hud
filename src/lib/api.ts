import { invoke } from "@tauri-apps/api/core";

import type { UsageSnapshot } from "./types";

export const listSnapshots = async (): Promise<UsageSnapshot[]> =>
  await invoke<UsageSnapshot[]>("list_snapshots");

export const refreshNow = async (): Promise<unknown> =>
  await invoke<unknown>("refresh_now");

export const getRefreshInterval = async (): Promise<number> =>
  await invoke<number>("get_refresh_interval");

export const setRefreshInterval = async (seconds: number): Promise<unknown> =>
  await invoke<unknown>("set_refresh_interval", { seconds });
