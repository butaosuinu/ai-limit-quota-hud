import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import {
  getRefreshInterval,
  listSnapshots,
  refreshNow,
  setRefreshInterval,
} from "./api";

const mockedInvoke = vi.mocked(invoke);

describe("api wrappers", () => {
  afterEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async () => undefined);
  });

  it("listSnapshots invokes list_snapshots with no args", async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    await listSnapshots();
    expect(mockedInvoke).toHaveBeenCalledWith("list_snapshots");
  });

  it("refreshNow invokes refresh_now", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await refreshNow();
    expect(mockedInvoke).toHaveBeenCalledWith("refresh_now");
  });

  it("getRefreshInterval invokes get_refresh_interval", async () => {
    mockedInvoke.mockResolvedValueOnce(60);
    const result = await getRefreshInterval();
    expect(result).toBe(60);
    expect(mockedInvoke).toHaveBeenCalledWith("get_refresh_interval");
  });

  it("setRefreshInterval forwards the seconds payload", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await setRefreshInterval(120);
    expect(mockedInvoke).toHaveBeenCalledWith("set_refresh_interval", {
      seconds: 120,
    });
  });
});
