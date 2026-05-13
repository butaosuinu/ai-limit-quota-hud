import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import {
  createManualRow,
  deleteManualRow,
  getRefreshInterval,
  listManualRows,
  listSnapshots,
  refreshNow,
  setRefreshInterval,
  updateManualRow,
} from "./api";
import type { ManualRowInput } from "./types";

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

  it("listManualRows invokes list_manual_rows", async () => {
    mockedInvoke.mockResolvedValueOnce([]);
    await listManualRows();
    expect(mockedInvoke).toHaveBeenCalledWith("list_manual_rows");
  });

  it("createManualRow forwards the input object", async () => {
    const input: ManualRowInput = {
      providerLabel: "ChatGPT",
      accountLabel: "me",
      window: "five-hours",
      metric: "messages",
      limit: 40,
      used: null,
      remaining: 12,
      resetAt: null,
      note: null,
    };
    mockedInvoke.mockResolvedValueOnce({});
    await createManualRow(input);
    expect(mockedInvoke).toHaveBeenCalledWith("create_manual_row", { input });
  });

  it("updateManualRow forwards id and input", async () => {
    const input: ManualRowInput = {
      providerLabel: "ChatGPT",
      accountLabel: "me",
      window: "five-hours",
      metric: "messages",
      limit: 40,
      used: null,
      remaining: 12,
      resetAt: null,
      note: null,
    };
    mockedInvoke.mockResolvedValueOnce({});
    await updateManualRow("row-id", input);
    expect(mockedInvoke).toHaveBeenCalledWith("update_manual_row", {
      id: "row-id",
      input,
    });
  });

  it("deleteManualRow forwards the id", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    await deleteManualRow("row-id");
    expect(mockedInvoke).toHaveBeenCalledWith("delete_manual_row", {
      id: "row-id",
    });
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
