import { afterEach, describe, expect, it } from "vitest";
import { Provider, createStore } from "jotai";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { resetInvoke, setupInvoke } from "../helpers/invokeMock";
import { setupListen } from "../helpers/eventBus";
import { flush } from "../helpers/flush";
import { WebviewProvidersPanel } from "../../lib/components/WebviewProvidersPanel";

async function mountPanel() {
  const store = createStore();
  const rendered = render(
    <Provider store={store}>
      <WebviewProvidersPanel />
    </Provider>,
  );
  await act(async () => {
    await flush();
  });
  return { store, ...rendered };
}

afterEach(() => {
  resetInvoke();
});

describe("WebviewProvidersPanel — bootstrap", () => {
  it("populatesEnabledChipFromBackendSnapshot", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
    });
    await mountPanel();
    expect(
      screen.getByTestId("webview-status-webview-claude-ai").textContent,
    ).toBe("Enabled");
    expect(
      screen.getByTestId("webview-status-webview-chatgpt-codex").textContent,
    ).toBe("Disabled");
  });

  it("displaysErrorAlertWhenBootstrapRejectsWithErrorInstance", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: async () => {
        throw new Error("offline");
      },
    });
    await mountPanel();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("offline");
    expect(alert.textContent).toContain("プロバイダ設定の取得に失敗");
  });

  it("displaysErrorAlertWhenBootstrapRejectsWithStringError", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: async () => {
        throw "ipc lost";
      },
    });
    await mountPanel();
    expect(screen.getByRole("alert").textContent).toContain("ipc lost");
  });

  it("displaysFallbackErrorWhenBootstrapRejectionShapeUnknown", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: async () => {
        throw { weird: true };
      },
    });
    await mountPanel();
    expect(screen.getByRole("alert").textContent).toContain("failed");
  });

  it("rendersBothProviderEntries", async () => {
    setupListen();
    setupInvoke();
    await mountPanel();
    expect(
      screen.getByTestId("webview-provider-webview-claude-ai"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("webview-provider-webview-chatgpt-codex"),
    ).toBeTruthy();
  });
});

describe("WebviewProvidersPanel — enable toggle", () => {
  it("flipsChipToEnabledAfterToggleClickSucceeds", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: { enabled: {} },
      set_provider_enabled: undefined,
    });
    await mountPanel();
    const toggle = screen.getByTestId(
      "webview-toggle-webview-claude-ai",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    await act(async () => {
      fireEvent.click(toggle);
    });
    await flush();
    expect(
      screen.getByTestId("webview-status-webview-claude-ai").textContent,
    ).toBe("Enabled");
    // Login button gates on the toggle — it must be enabled now.
    const loginBtn = screen.getByTestId(
      "webview-login-webview-claude-ai",
    ) as HTMLButtonElement;
    expect(loginBtn.disabled).toBe(false);
  });

  it("surfacesErrorAlertWhenToggleWriteRejects", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: { enabled: {} },
      set_provider_enabled: async () => {
        throw new Error("write denied");
      },
    });
    await mountPanel();
    const toggle = screen.getByTestId(
      "webview-toggle-webview-claude-ai",
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.click(toggle);
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("write denied");
    // Chip must stay Disabled — the failed write should not optimistically flip.
    expect(
      screen.getByTestId("webview-status-webview-claude-ai").textContent,
    ).toBe("Disabled");
  });
});

describe("WebviewProvidersPanel — login button", () => {
  it("keepsLoginButtonDisabledWhileProviderDisabled", async () => {
    setupListen();
    setupInvoke({ get_provider_settings: { enabled: {} } });
    await mountPanel();
    const btn = screen.getByTestId(
      "webview-login-webview-chatgpt-codex",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("clearsPriorErrorAfterSuccessfulLoginClick", async () => {
    setupListen();
    let allowLogin = false;
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
      open_provider_login_window: async () => {
        if (!allowLogin) throw new Error("blocked");
        return undefined;
      },
    });
    await mountPanel();
    const btn = screen.getByTestId(
      "webview-login-webview-claude-ai",
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("blocked");
    allowLogin = true;
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfacesErrorWhenLoginInvocationRejects", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
      open_provider_login_window: async () => {
        throw new Error("no window");
      },
    });
    await mountPanel();
    const btn = screen.getByTestId(
      "webview-login-webview-claude-ai",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("no window");
  });
});

describe("WebviewProvidersPanel — delete data button", () => {
  it("clearsPriorErrorAfterSuccessfulDeleteClick", async () => {
    setupListen();
    let allowDelete = false;
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
      delete_provider_data: async () => {
        if (!allowDelete) throw new Error("busy");
        return undefined;
      },
    });
    await mountPanel();
    const btn = screen.getByTestId(
      "webview-delete-webview-claude-ai",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("busy");
    allowDelete = true;
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfacesErrorWhenDeleteInvocationRejects", async () => {
    setupListen();
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
      delete_provider_data: async () => {
        throw new Error("locked");
      },
    });
    await mountPanel();
    const btn = screen.getByTestId(
      "webview-delete-webview-claude-ai",
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("locked");
  });
});
