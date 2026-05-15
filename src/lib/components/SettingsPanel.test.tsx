import { invoke } from "@tauri-apps/api/core";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { Provider, createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_OVERLAY_SETTINGS, type ProviderSettings } from "../types";

import { SettingsPanel } from "./SettingsPanel";

const mockedInvoke = vi.mocked(invoke);

/**
 * Default IPC responses for commands the SettingsPanel touches at mount.
 *
 * `get_overlay_settings` must return a real `OverlaySettings` object — the
 * default `undefined` from `setup.ts` would otherwise overwrite the
 * default atom state with `undefined` and trigger a render-time crash in
 * `SettingsPanel` (it reads `settings.opacity` synchronously).
 */
function applyDefaultIpcMock() {
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "get_overlay_settings") return DEFAULT_OVERLAY_SETTINGS;
    if (command === "get_provider_settings") return { enabled: {} };
    if (command === "list_manual_rows") return [];
    return undefined;
  });
}

function renderPanel() {
  const store = createStore();
  return {
    store,
    ...render(
      <Provider store={store}>
        <SettingsPanel />
      </Provider>,
    ),
  };
}

/**
 * Narrow a `getByTestId` result to `HTMLButtonElement` so we can read
 * `.disabled` without an unchecked cast. Matches the runtime-validated
 * pattern used by `ManualRowsPanel.test.tsx`.
 */
function asButton(testId: string): HTMLButtonElement {
  const el = screen.getByTestId(testId);
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`${testId} is not a button element`);
  }
  return el;
}

beforeEach(() => {
  mockedInvoke.mockReset();
  applyDefaultIpcMock();
});

afterEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async () => undefined);
});

describe("SettingsPanel WebView providers section", () => {
  it("renders the WebView providers panel inside the settings UI", () => {
    renderPanel();
    expect(screen.getByTestId("webview-providers-panel")).toBeTruthy();
    expect(screen.getByTestId("webview-row-webview-chatgpt-codex")).toBeTruthy();
  });

  it("starts with the Codex toggle off so login/delete buttons are disabled", () => {
    renderPanel();
    expect(asButton("webview-row-webview-chatgpt-codex-login").disabled).toBe(
      true,
    );
    expect(asButton("webview-row-webview-chatgpt-codex-delete").disabled).toBe(
      true,
    );
  });

  it("reflects the bootstrap-fetched enable state on the Codex toggle", async () => {
    const settings: ProviderSettings = {
      enabled: { "webview-chatgpt-codex": true },
    };
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "get_overlay_settings") return DEFAULT_OVERLAY_SETTINGS;
      if (command === "get_provider_settings") return settings;
      if (command === "list_manual_rows") return [];
      return undefined;
    });
    renderPanel();
    await waitFor(() => {
      expect(
        asButton("webview-row-webview-chatgpt-codex-login").disabled,
      ).toBe(false);
    });
    expect(asButton("webview-row-webview-chatgpt-codex-delete").disabled).toBe(
      false,
    );
  });

  it("invokes set_provider_enabled when the user enables the Codex toggle", async () => {
    renderPanel();

    const toggle = screen.getByLabelText(/Codex \(ChatGPT\)/u);
    if (!(toggle instanceof HTMLInputElement)) {
      throw new Error("Codex toggle is not an input element");
    }
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.some(
          ([command, args]) =>
            command === "set_provider_enabled" &&
            (args as { kind?: string; enabled?: boolean })?.kind ===
              "webview-chatgpt-codex" &&
            (args as { kind?: string; enabled?: boolean })?.enabled === true,
        ),
      ).toBe(true);
    });
  });
});
