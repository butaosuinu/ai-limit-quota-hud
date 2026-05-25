import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "jotai";

import { resetInvoke, setupInvoke } from "../../__tests__/helpers/invokeMock";
import { flush as waitForState } from "../../__tests__/helpers/flush";
import {
  deleteProviderDataAtom,
  isProviderEnabledAtom,
  openProviderLoginAtom,
  providerSettingsAtom,
  providerSettingsErrorAtom,
  setProviderEnabledAtom,
} from "./providerSettingsAtom";

afterEach(() => {
  resetInvoke();
});

describe("providerSettingsAtom — bootstrap", () => {
  it("populatesSettingsFromBackendOnFirstSubscribe", async () => {
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsAtom, () => {});
    await waitForState();
    expect(store.get(providerSettingsAtom).enabled["webview-claude-ai"]).toBe(
      true,
    );
    expect(store.get(providerSettingsErrorAtom)).toBeUndefined();
    unsub();
  });

  it("storesErrorMessageWhenBootstrapRejectsWithErrorInstance", async () => {
    setupInvoke({
      get_provider_settings: async () => {
        throw new Error("offline");
      },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    expect(store.get(providerSettingsErrorAtom)).toBe(
      "プロバイダ設定の取得に失敗: offline",
    );
    unsub();
  });

  it("storesErrorMessageWhenBootstrapRejectsWithString", async () => {
    setupInvoke({
      get_provider_settings: async () => {
        throw "ipc lost";
      },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    expect(store.get(providerSettingsErrorAtom)).toBe(
      "プロバイダ設定の取得に失敗: ipc lost",
    );
    unsub();
  });

  it("storesFallbackErrorMessageWhenRejectionShapeIsUnknown", async () => {
    setupInvoke({
      get_provider_settings: async () => {
        throw { weird: true };
      },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    // Unknown error shape: fallback is just the localized label, no suffix.
    expect(store.get(providerSettingsErrorAtom)).toBe(
      "プロバイダ設定の取得に失敗",
    );
    unsub();
  });

  it("discardsStaleBootstrapResultWhenUserTogglePersistedFirst", async () => {
    // Delay bootstrap so the user-triggered write resolves first and bumps
    // generation. The later bootstrap result must NOT overwrite it.
    let releaseBootstrap: () => void = () => {};
    const bootstrapHeld = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    setupInvoke({
      get_provider_settings: async () => {
        await bootstrapHeld;
        return { enabled: { "webview-claude-ai": true } };
      },
      set_provider_enabled: undefined,
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsAtom, () => {});
    // Drive a user toggle while bootstrap is still suspended.
    await store.set(setProviderEnabledAtom, {
      kind: "webview-chatgpt-codex",
      enabled: true,
    });
    expect(
      store.get(providerSettingsAtom).enabled["webview-chatgpt-codex"],
    ).toBe(true);
    // Now let the stale bootstrap resolve.
    releaseBootstrap();
    await waitForState();
    const finalSettings = store.get(providerSettingsAtom);
    expect(finalSettings.enabled["webview-chatgpt-codex"]).toBe(true);
    // The stale bootstrap result (`webview-claude-ai: true`) must be ignored.
    expect(finalSettings.enabled["webview-claude-ai"]).toBeUndefined();
    unsub();
  });
});

describe("providerSettingsAtom — write atoms", () => {
  it("setProviderEnabledAtomAppliesNewValueOnSuccess", async () => {
    setupInvoke({
      get_provider_settings: { enabled: {} },
      set_provider_enabled: undefined,
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsAtom, () => {});
    await waitForState();
    await store.set(setProviderEnabledAtom, {
      kind: "webview-claude-ai",
      enabled: true,
    });
    expect(store.get(providerSettingsAtom).enabled["webview-claude-ai"]).toBe(
      true,
    );
    expect(store.get(providerSettingsErrorAtom)).toBeUndefined();
    unsub();
  });

  it("setProviderEnabledAtomStoresErrorAndKeepsExistingSettingsOnFailure", async () => {
    setupInvoke({
      get_provider_settings: { enabled: {} },
      set_provider_enabled: async () => {
        throw new Error("write denied");
      },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsAtom, () => {});
    await waitForState();
    await store.set(setProviderEnabledAtom, {
      kind: "webview-claude-ai",
      enabled: true,
    });
    expect(
      store.get(providerSettingsAtom).enabled["webview-claude-ai"],
    ).toBeUndefined();
    expect(store.get(providerSettingsErrorAtom)).toBe(
      "プロバイダの有効化に失敗: write denied",
    );
    unsub();
  });

  it("openProviderLoginAtomClearsPriorErrorOnSuccess", async () => {
    setupInvoke({
      get_provider_settings: async () => {
        throw new Error("boot fail");
      },
      open_provider_login_window: undefined,
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    expect(store.get(providerSettingsErrorAtom)).toContain("boot fail");
    await store.set(openProviderLoginAtom, "webview-claude-ai");
    expect(store.get(providerSettingsErrorAtom)).toBeUndefined();
    unsub();
  });

  it("openProviderLoginAtomStoresErrorOnFailure", async () => {
    setupInvoke({
      get_provider_settings: { enabled: {} },
      open_provider_login_window: async () => {
        throw new Error("no window");
      },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    await store.set(openProviderLoginAtom, "webview-claude-ai");
    expect(store.get(providerSettingsErrorAtom)).toBe(
      "ログインウィンドウを開けませんでした: no window",
    );
    unsub();
  });

  it("deleteProviderDataAtomClearsPriorErrorOnSuccess", async () => {
    setupInvoke({
      get_provider_settings: async () => {
        throw new Error("boot fail");
      },
      delete_provider_data: undefined,
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    expect(store.get(providerSettingsErrorAtom)).toContain("boot fail");
    await store.set(deleteProviderDataAtom, "webview-chatgpt-codex");
    expect(store.get(providerSettingsErrorAtom)).toBeUndefined();
    unsub();
  });

  it("deleteProviderDataAtomStoresErrorOnFailure", async () => {
    setupInvoke({
      get_provider_settings: { enabled: {} },
      delete_provider_data: async () => {
        throw new Error("locked");
      },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsErrorAtom, () => {});
    await waitForState();
    await store.set(deleteProviderDataAtom, "webview-claude-ai");
    expect(store.get(providerSettingsErrorAtom)).toBe(
      "プロバイダデータの削除に失敗: locked",
    );
    unsub();
  });
});

describe("providerSettingsAtom — derived", () => {
  it("isProviderEnabledAtomReturnsFalseForMissingKey", async () => {
    setupInvoke({ get_provider_settings: { enabled: {} } });
    const store = createStore();
    const unsub = store.sub(providerSettingsAtom, () => {});
    await waitForState();
    const isEnabled = store.get(isProviderEnabledAtom);
    expect(isEnabled("webview-claude-ai")).toBe(false);
    unsub();
  });

  it("isProviderEnabledAtomReflectsCachedTrueValue", async () => {
    setupInvoke({
      get_provider_settings: { enabled: { "webview-claude-ai": true } },
    });
    const store = createStore();
    const unsub = store.sub(providerSettingsAtom, () => {});
    await waitForState();
    expect(store.get(providerSettingsAtom).enabled["webview-claude-ai"]).toBe(
      true,
    );
    const isEnabled = store.get(isProviderEnabledAtom);
    expect(isEnabled("webview-claude-ai")).toBe(true);
    expect(isEnabled("webview-chatgpt-codex")).toBe(false);
    unsub();
  });
});
