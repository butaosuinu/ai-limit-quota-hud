import { afterEach, describe, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";

import { resetInvoke, setupInvoke } from "../../__tests__/helpers/invokeMock";
import { flush } from "../../__tests__/helpers/flush";
import { withI18n } from "../../test/i18nTestUtils";
import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import {
  type UpdateStatus,
  updateStatusAtom,
  currentVersionAtom,
} from "../atoms/updateAtoms";
import { DEFAULT_OVERLAY_SETTINGS } from "../types";
import { UpdatesPanel } from "./UpdatesPanel";

/**
 * Detroit-style integration tests for UpdatesPanel. We seed atom state via a
 * Jotai store (no internals mocked) and observe the rendered DOM. The
 * `@tauri-apps/plugin-updater` and `@tauri-apps/plugin-process` modules are
 * mocked globally in `src/test/setup.ts`; here we only override `check()` per
 * test to drive the "check now" branch.
 */

async function mountUpdatesPanel(initialStatus: UpdateStatus) {
  setupInvoke({
    get_overlay_settings: { ...DEFAULT_OVERLAY_SETTINGS },
    update_overlay_settings: undefined,
  });
  const store = createStore();
  store.set(overlaySettingsAtom, { ...DEFAULT_OVERLAY_SETTINGS });
  store.set(updateStatusAtom, initialStatus);
  store.set(currentVersionAtom, "1.2.3");
  const rendered = render(
    withI18n(
      <Provider store={store}>
        <UpdatesPanel />
      </Provider>,
    ),
  );
  await act(async () => {
    await flush();
  });
  return { store, ...rendered };
}

afterEach(() => {
  resetInvoke();
  vi.mocked(check).mockReset();
  vi.mocked(check).mockResolvedValue(null);
});

describe("UpdatesPanel — renders by status kind", () => {
  it("rendersIdleStateWithCheckButtonEnabled", async () => {
    await mountUpdatesPanel({ kind: "idle" });
    const btn = screen.getByTestId("updates-check-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByTestId("updates-status-chip").textContent).toContain(
      "待機中",
    );
  });

  it("rendersCheckingStateWithDisabledCheckButton", async () => {
    await mountUpdatesPanel({ kind: "checking" });
    const btn = screen.getByTestId("updates-check-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("updates-status-chip").textContent).toContain(
      "確認中",
    );
  });

  it("rendersAvailableStateWithDownloadActionAndReleaseNotes", async () => {
    await mountUpdatesPanel({
      kind: "available",
      version: "2.0.0",
      notes: "fixed crash on launch",
    });
    expect(screen.getByTestId("updates-available-row")).toBeTruthy();
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    expect(screen.getByTestId("updates-release-notes").textContent).toContain(
      "fixed crash on launch",
    );
    expect(screen.getByTestId("updates-download-button")).toBeTruthy();
  });

  it("rendersDownloadingStateWithProgressLabel", async () => {
    await mountUpdatesPanel({ kind: "downloading", progress: 12345 });
    expect(
      screen.getByTestId("updates-download-progress").textContent,
    ).toContain("12345");
    const btn = screen.getByTestId("updates-check-button") as HTMLButtonElement;
    // Downloading also disables the check button so the user can't kick off a
    // second IPC round-trip mid-download.
    expect(btn.disabled).toBe(true);
  });

  it("rendersReadyStateWithRelaunchButton", async () => {
    await mountUpdatesPanel({ kind: "ready" });
    expect(screen.getByTestId("updates-relaunch-button")).toBeTruthy();
  });

  it("rendersErrorStateBannerWithoutCrashingPanel", async () => {
    await mountUpdatesPanel({ kind: "error", message: "boom" });
    expect(screen.getByTestId("updates-error").textContent).toContain("boom");
    // Root still mounted: the panel and the check button are reachable.
    expect(screen.getByTestId("updates-panel")).toBeTruthy();
    expect(screen.getByTestId("updates-check-button")).toBeTruthy();
  });
});

describe("UpdatesPanel — actions", () => {
  it("invokesPluginCheckWhenCheckNowClicked", async () => {
    await mountUpdatesPanel({ kind: "idle" });
    const before = vi.mocked(check).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(vi.mocked(check).mock.calls.length).toBe(before + 1);
  });

  it("invokesUpdateOverlaySettingsWhenStartupToggleFlipped", async () => {
    await mountUpdatesPanel({ kind: "idle" });
    const toggle = screen.getByTestId(
      "updates-startup-toggle",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
      await flush();
    });
    const invokeCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "update_overlay_settings");
    expect(invokeCalls.length).toBeGreaterThan(0);
    const lastArgs = invokeCalls.at(-1)?.[1] as {
      settings?: { checkUpdatesOnStartup?: boolean };
    };
    expect(lastArgs.settings?.checkUpdatesOnStartup).toBe(false);
  });

  it("transitionsCheckResultToAvailableWhenPluginReturnsUpdate", async () => {
    // Drive the check() resolution directly so we can observe the atom write
    // path without needing the real Update class.
    const fakeUpdate = {
      version: "9.9.9",
      body: "release notes here",
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate);
    const { store } = await mountUpdatesPanel({ kind: "idle" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    const status = store.get(updateStatusAtom);
    expect(status.kind).toBe("available");
    if (status.kind === "available") {
      expect(status.version).toBe("9.9.9");
      expect(status.notes).toBe("release notes here");
    }
  });

  it("storesLocalizedErrorWhenCheckRejects", async () => {
    vi.mocked(check).mockRejectedValueOnce(new Error("network down"));
    const { store } = await mountUpdatesPanel({ kind: "idle" });
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    const status = store.get(updateStatusAtom);
    expect(status.kind).toBe("error");
    if (status.kind === "error") {
      expect(status.message).toContain("network down");
    }
  });
});

describe("UpdatesPanel — current version", () => {
  it("rendersCurrentVersionFromGetVersionPlugin", async () => {
    // The atom subscribes onMount and overwrites any pre-seeded value with the
    // mocked `getVersion()` result; we assert on that boundary's contract.
    await mountUpdatesPanel({ kind: "idle" });
    expect(screen.getByTestId("updates-current-version").textContent).toBe(
      "0.0.0-test",
    );
  });
});
