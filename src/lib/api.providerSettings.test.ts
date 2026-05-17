import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import {
  deleteProviderData,
  getProviderSettings,
  openProviderLoginWindow,
  setProviderEnabled,
} from "./api";
import type { ProviderKind, ProviderSettings } from "./types";

const mockedInvoke = vi.mocked(invoke);

describe("api wrappers — provider settings", () => {
  afterEach(() => {
    mockedInvoke.mockReset();
    mockedInvoke.mockImplementation(async () => undefined);
  });

  it("getProviderSettingsReturnsDecodedSettings", async () => {
    const payload: ProviderSettings = {
      enabled: { "webview-claude-ai": true },
    };
    mockedInvoke.mockResolvedValueOnce(payload);
    const result = await getProviderSettings();
    expect(result).toEqual(payload);
  });

  it("setProviderEnabledResolvesWithBackendResult", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const kind: ProviderKind = "webview-claude-ai";
    const result = await setProviderEnabled(kind, true);
    expect(result).toBeUndefined();
  });

  it("openProviderLoginWindowResolvesWithBackendResult", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const kind: ProviderKind = "webview-chatgpt-codex";
    const result = await openProviderLoginWindow(kind);
    expect(result).toBeUndefined();
  });

  it("deleteProviderDataResolvesWithBackendResult", async () => {
    mockedInvoke.mockResolvedValueOnce(undefined);
    const kind: ProviderKind = "webview-claude-ai";
    const result = await deleteProviderData(kind);
    expect(result).toBeUndefined();
  });

  it("getProviderSettingsPropagatesRejection", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("boom"));
    await expect(getProviderSettings()).rejects.toThrow("boom");
  });

  it("setProviderEnabledPropagatesRejection", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("write failed"));
    await expect(setProviderEnabled("webview-claude-ai", true)).rejects.toThrow(
      "write failed",
    );
  });

  it("openProviderLoginWindowPropagatesRejection", async () => {
    mockedInvoke.mockRejectedValueOnce("string err");
    await expect(openProviderLoginWindow("webview-chatgpt-codex")).rejects.toBe(
      "string err",
    );
  });

  it("deleteProviderDataPropagatesRejection", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("nope"));
    await expect(deleteProviderData("webview-claude-ai")).rejects.toThrow(
      "nope",
    );
  });
});
