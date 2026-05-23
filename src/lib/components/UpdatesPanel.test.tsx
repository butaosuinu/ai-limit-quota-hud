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
 * Detroit 学派の統合テスト。Jotai store に初期状態を seed し、レンダリング
 * 結果を観測する。`@tauri-apps/plugin-updater` と `@tauri-apps/plugin-process`
 * は `src/test/setup.ts` でグローバルにモック済みで、ここではテスト単位で
 * `check()` の挙動だけ上書きしている。
 */

async function mountUpdatesPanel(initialStatus: UpdateStatus) {
  setupInvoke({
    get_overlay_settings: { ...DEFAULT_OVERLAY_SETTINGS },
    update_overlay_settings: undefined,
    get_last_update_status: null,
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
  vi.mocked(check).mockClear();
});

describe("UpdatesPanel — status ごとのレンダリング", () => {
  it("idle 状態では「今すぐ確認」ボタンが押せて待機中チップが出る", async () => {
    await mountUpdatesPanel({ kind: "idle" });
    const btn = screen.getByTestId("updates-check-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(screen.getByTestId("updates-status-chip").textContent).toContain(
      "待機中",
    );
  });

  it("checking 状態では確認中チップが出て「今すぐ確認」ボタンが無効化される", async () => {
    await mountUpdatesPanel({ kind: "checking" });
    const btn = screen.getByTestId("updates-check-button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByTestId("updates-status-chip").textContent).toContain(
      "確認中",
    );
  });

  it("available 状態ではリリースノートとダウンロードボタンが表示される", async () => {
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

  it("downloading 状態では progress 表示と「今すぐ確認」ボタンの無効化を行う", async () => {
    await mountUpdatesPanel({ kind: "downloading", progress: 12345 });
    expect(
      screen.getByTestId("updates-download-progress").textContent,
    ).toContain("12345");
    const btn = screen.getByTestId("updates-check-button") as HTMLButtonElement;
    // ダウンロード中も「今すぐ確認」を無効にすることで、ユーザーが二重の
    // IPC を発火させないようにしている。
    expect(btn.disabled).toBe(true);
  });

  it("ready 状態では「再起動して適用」ボタンが現れる", async () => {
    await mountUpdatesPanel({ kind: "ready" });
    expect(screen.getByTestId("updates-relaunch-button")).toBeTruthy();
  });

  it("error 状態でも panel 自体は unmount せずエラーバナーを表示する", async () => {
    await mountUpdatesPanel({ kind: "error", message: "boom" });
    expect(screen.getByTestId("updates-error").textContent).toContain("boom");
    expect(screen.getByTestId("updates-panel")).toBeTruthy();
    expect(screen.getByTestId("updates-check-button")).toBeTruthy();
  });
});

describe("UpdatesPanel — ユーザー操作", () => {
  it("「今すぐ確認」クリックで updater plugin の check() が呼ばれる", async () => {
    await mountUpdatesPanel({ kind: "idle" });
    const before = vi.mocked(check).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(vi.mocked(check).mock.calls.length).toBe(before + 1);
  });

  it("「起動時に確認」トグルを切り替えると update_overlay_settings が呼ばれる", async () => {
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

  it("check() が Update を返したとき status が available に遷移する", async () => {
    // 実際の Update class を経由せずに check() の resolve を直接駆動して、
    // atom への書き込み経路を観測する。
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

  it("check() が reject したとき翻訳済みエラーメッセージが atom に格納される", async () => {
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

describe("UpdatesPanel — 現在のバージョン表示", () => {
  it("getVersion plugin の戻り値で現在バージョン行が更新される", async () => {
    // currentVersionAtom は onMount でモック済み getVersion() を読み、
    // seed 値を上書きする。境界の契約を直接観測する。
    await mountUpdatesPanel({ kind: "idle" });
    expect(screen.getByTestId("updates-current-version").textContent).toBe(
      "0.0.0-test",
    );
  });
});
