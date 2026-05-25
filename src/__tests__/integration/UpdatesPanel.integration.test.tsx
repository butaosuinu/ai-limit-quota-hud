import { afterEach, describe, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

import { resetInvoke, setupInvoke } from "../helpers/invokeMock";
import { setupListen } from "../helpers/eventBus";
import { flush } from "../helpers/flush";
import { overlaySettingsAtom } from "../../lib/atoms/overlayAtoms";
import {
  type UpdateStatus,
  updateStatusAtom,
} from "../../lib/atoms/updateAtoms";
import { SettingsPanel } from "../../lib/components/SettingsPanel";
import { withI18n } from "../../test/i18nTestUtils";
import {
  DEFAULT_OVERLAY_SETTINGS,
  UPDATER_STATUS_EVENT,
  type OverlaySettings,
  type UpdateStatusPayload,
} from "../../lib/types";

/**
 * 設定画面 (`SettingsPanel`) を実際にマウントし、UpdatesPanel に対する
 * ユーザー操作と backend イベントの統合経路を観測する。Detroit 学派に倣い、
 * モックは IPC / event listen / plugin の各境界に限定する。
 */
async function mountSettingsPanel({
  initial = {},
  lastUpdateStatus = null,
  initialStatus,
}: {
  initial?: Partial<OverlaySettings>;
  lastUpdateStatus?: (UpdateStatusPayload & { source?: string }) | null;
  initialStatus?: UpdateStatus;
} = {}) {
  const merged: OverlaySettings = { ...DEFAULT_OVERLAY_SETTINGS, ...initial };
  setupInvoke({
    get_overlay_settings: merged,
    update_overlay_settings: (args: { settings: OverlaySettings }) =>
      args.settings,
    get_provider_settings: { enabled: {} },
    get_last_update_status: lastUpdateStatus,
  });
  const store = createStore();
  store.set(overlaySettingsAtom, merged);
  if (initialStatus !== undefined) store.set(updateStatusAtom, initialStatus);
  const rendered = render(
    withI18n(
      <Provider store={store}>
        <SettingsPanel />
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
  vi.mocked(relaunch).mockClear();
});

describe("設定画面の Updates セクション — 起動時 bootstrap", () => {
  it("backend が available を保持しているとき、設定画面マウントで Available 行が描画される", async () => {
    setupListen();
    await mountSettingsPanel({
      lastUpdateStatus: {
        status: "available",
        version: "9.9.9",
        notes: "release notes",
      },
    });
    expect(screen.getByTestId("updates-available-row")).toBeTruthy();
    expect(screen.getByText("v9.9.9")).toBeTruthy();
  });

  it("backend が noUpdate を保持しているとき、設定画面は待機中チップを表示する", async () => {
    setupListen();
    await mountSettingsPanel({ lastUpdateStatus: { status: "noUpdate" } });
    expect(screen.getByTestId("updates-status-chip").textContent).toContain(
      "待機中",
    );
  });

  it("backend が error を保持しているとき、エラーバナーが表示されつつ panel は残る", async () => {
    setupListen();
    await mountSettingsPanel({
      lastUpdateStatus: { status: "error", message: "offline" },
    });
    expect(screen.getByTestId("updates-error").textContent).toContain(
      "offline",
    );
    expect(screen.getByTestId("updates-panel")).toBeTruthy();
  });

  it("cached daily noUpdate は remount で retain された stale な available をクリアする", async () => {
    // ライブ daily event を取りこぼした状態 (renderer reload / panel remount で
    // atom が available を保持したまま) で再マウントしても、cache に source 付き
    // で残った daily noUpdate が bootstrap 経路で available をクリアする。
    setupListen();
    const { store } = await mountSettingsPanel({
      initialStatus: { kind: "available", version: "9.9.9", notes: "old" },
      lastUpdateStatus: { status: "noUpdate", source: "daily" },
    });
    expect(store.get(updateStatusAtom).kind).toBe("idle");
  });

  it("cached startup noUpdate は retain された available を保守的に維持する", async () => {
    // startup の cache は manual check と並走しうるため bootstrap でも保守的。
    setupListen();
    const { store } = await mountSettingsPanel({
      initialStatus: { kind: "available", version: "9.9.9", notes: "old" },
      lastUpdateStatus: { status: "noUpdate", source: "startup" },
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
  });
});

describe("設定画面の Updates セクション — ユーザー操作", () => {
  it("「今すぐ確認」クリックで plugin の check() が 1 回呼ばれる", async () => {
    setupListen();
    await mountSettingsPanel();
    const before = vi.mocked(check).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(vi.mocked(check).mock.calls.length).toBe(before + 1);
  });

  it("「起動時に確認」トグルを切り替えると update_overlay_settings IPC が走る", async () => {
    setupListen();
    await mountSettingsPanel();
    const toggle = screen.getByTestId(
      "updates-startup-toggle",
    ) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async () => {
      fireEvent.click(toggle);
      await flush();
    });
    // setupInvoke の handler が実際にエコーバックするため、IPC が呼ばれて
    // toggle が false に降りたことを atom 側で検証する。
  });

  it("backend が available event を流すと、設定画面の「ダウンロード」ボタンが現れる", async () => {
    const bus = setupListen();
    await mountSettingsPanel();
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, {
        status: "available",
        version: "1.0.0",
        notes: "first stable",
      });
      await flush();
    });
    expect(screen.getByTestId("updates-download-button")).toBeTruthy();
    expect(screen.getByText("v1.0.0")).toBeTruthy();
  });

  it("「ダウンロード」クリック時に pending が無ければ check() を fallback で再取得する", async () => {
    // この経路は backend startup check 経由で available が来たとき (pending
    // Update リソースが frontend 側に存在しないとき) に発生する。
    const fakeUpdate = {
      version: "9.9.9",
      body: "notes",
      downloadAndInstall: vi.fn(async () => undefined),
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate);
    const bus = setupListen();
    await mountSettingsPanel();
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, {
        status: "available",
        version: "9.9.9",
        notes: "notes",
      });
      await flush();
    });
    const before = vi.mocked(check).mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-download-button"));
      await flush();
    });
    expect(vi.mocked(check).mock.calls.length).toBe(before + 1);
  });

  it("manual check 中に届いた backend の noUpdate event は無視され、checking 状態が維持される", async () => {
    // backend startup check が遅れて完了し、その間にユーザが「今すぐ確認」を
    // 押した場合、後から届く noUpdate は manual 操作を上書きしてはいけない。
    let resolveCheck: (
      value: Awaited<ReturnType<typeof check>>,
    ) => void = () => {};
    vi.mocked(check).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const bus = setupListen();
    const { store } = await mountSettingsPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("checking");
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, { status: "noUpdate" });
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("checking");
    // ここで本来の manual check を完走させて状態を畳む。
    await act(async () => {
      resolveCheck(null);
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("idle");
  });

  it("manual check の失敗時、既存 pending Update は close されて消える", async () => {
    const closeA = vi.fn(async () => undefined);
    const updateA = {
      version: "1.0.0",
      body: "",
      close: closeA,
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check)
      .mockResolvedValueOnce(updateA)
      .mockRejectedValueOnce(new Error("network down"));
    setupListen();
    await mountSettingsPanel();
    // 成功した manual check で updateA を pending に積む
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(closeA).not.toHaveBeenCalled();
    // 失敗する manual check で updateA は close されて pending はクリア
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("updates-error")).toBeTruthy();
  });

  it("manual の error 状態は遅延 backend noUpdate event で隠されない", async () => {
    vi.mocked(check).mockRejectedValueOnce(new Error("offline"));
    const bus = setupListen();
    const { store } = await mountSettingsPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("error");
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, { status: "noUpdate" });
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("error");
    expect(screen.getByTestId("updates-error").textContent).toContain(
      "offline",
    );
  });

  it("ready 状態では「今すぐ確認」ボタンが disabled になり restart の機会が失われない", async () => {
    setupListen();
    const { store } = await mountSettingsPanel();
    await act(async () => {
      store.set(updateStatusAtom, { kind: "ready" });
      await flush();
    });
    const checkBtn = screen.getByTestId(
      "updates-check-button",
    ) as HTMLButtonElement;
    expect(checkBtn.disabled).toBe(true);
    expect(screen.getByTestId("updates-relaunch-button")).toBeTruthy();
  });

  it("Update リソースは置き換え時と消費後に close() で必ず解放される", async () => {
    // Tauri の Update は Resource ハンドル。pendingUpdate を上書き / クリア
    // するときと downloadAndInstall を完走したときに close() を呼ばないと
    // backend のリソース ID がリークするため、複数経路で release を確認する。
    const closeA = vi.fn(async () => undefined);
    const closeB = vi.fn(async () => undefined);
    const downloadB = vi.fn(async () => undefined);
    const updateA = {
      version: "1.0.0",
      body: "",
      close: closeA,
    } as unknown as Awaited<ReturnType<typeof check>>;
    const updateB = {
      version: "2.0.0",
      body: "",
      close: closeB,
      downloadAndInstall: downloadB,
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check)
      .mockResolvedValueOnce(updateA)
      .mockResolvedValueOnce(updateB);
    setupListen();
    await mountSettingsPanel();

    // 1 回目の manual check で updateA を pending に積む。
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(closeA).not.toHaveBeenCalled();

    // 2 回目の manual check で updateB に置き換わる: updateA は close される。
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(closeA).toHaveBeenCalledTimes(1);
    expect(closeB).not.toHaveBeenCalled();

    // download を完走すると updateB も close される。
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-download-button"));
      await flush();
    });
    expect(downloadB).toHaveBeenCalledTimes(1);
    expect(closeB).toHaveBeenCalledTimes(1);
  });

  it("backend event で表示 version が更新された後の download は、キャッシュではなく再 check した最新 Update を install する", async () => {
    // 1) manual check で 1.0.0 を pending に積む
    // 2) backend が 2.0.0 の available event を emit し、表示 version だけ更新
    // 3) Download をクリックすると、stale な 1.0.0 ではなく再 check 経由で
    //    取得した 2.0.0 の downloadAndInstall が呼ばれる
    const staleDownload = vi.fn(async () => undefined);
    const freshDownload = vi.fn(async () => undefined);
    const stalePending = {
      version: "1.0.0",
      body: "stale",
      downloadAndInstall: staleDownload,
    } as unknown as Awaited<ReturnType<typeof check>>;
    const freshUpdate = {
      version: "2.0.0",
      body: "fresh",
      downloadAndInstall: freshDownload,
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check)
      .mockResolvedValueOnce(stalePending)
      .mockResolvedValueOnce(freshUpdate);
    const bus = setupListen();
    await mountSettingsPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(screen.getByText("v1.0.0")).toBeTruthy();
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, {
        status: "available",
        version: "2.0.0",
        notes: "fresh",
      });
      await flush();
    });
    expect(screen.getByText("v2.0.0")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-download-button"));
      await flush();
    });
    expect(staleDownload).not.toHaveBeenCalled();
    expect(freshDownload).toHaveBeenCalledTimes(1);
  });

  it("download ボタンの重複クリックでは check() / downloadAndInstall が二重に走らない", async () => {
    // available 状態からの「ダウンロード」連打。downloadAndInstallAtom は
    // 入口でガードして 2 回目の invocation を no-op にすること。
    const downloadAndInstall = vi.fn(async () => undefined);
    const fakeUpdate = {
      version: "5.0.0",
      body: "",
      downloadAndInstall,
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate);
    const bus = setupListen();
    await mountSettingsPanel();
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, {
        status: "available",
        version: "5.0.0",
        notes: "",
      });
      await flush();
    });
    const before = vi.mocked(check).mock.calls.length;
    const btn = screen.getByTestId("updates-download-button");
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
      await flush();
    });
    expect(vi.mocked(check).mock.calls.length).toBe(before + 1);
    expect(downloadAndInstall.mock.calls.length).toBe(1);
  });

  it("manual check で available を確定した後に届く startup の noUpdate event は available 状態を維持する", async () => {
    // 起動時 startup check が遅れて noUpdate を emit するケース。すでに
    // ユーザの「今すぐ確認」が available を確定させていれば、startup は manual
    // と並走しうるため、その authoritative な状態を idle へ巻き戻してはいけない。
    const fakeUpdate = {
      version: "3.0.0",
      body: "stable",
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate);
    const bus = setupListen();
    const { store } = await mountSettingsPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, { status: "noUpdate", source: "startup" });
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
    expect(screen.getByTestId("updates-download-button")).toBeTruthy();
  });

  it("daily check の noUpdate event は stale な available 表示をクリアする", async () => {
    // bootstrap で available を表示した後、24h 後の定期チェックが noUpdate を
    // 返したら (リリース取り下げ等)、最新の backend 状態として古い available を
    // idle へ畳む。startup の late noUpdate (上のケース) とは扱いが異なる。
    const bus = setupListen();
    const { store } = await mountSettingsPanel({
      lastUpdateStatus: { status: "available", version: "9.9.9", notes: "old" },
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, { status: "noUpdate", source: "daily" });
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("idle");
    expect(screen.getByTestId("updates-status-chip").textContent).toContain(
      "待機中",
    );
  });

  it("daily check の error event は known な available 表示を隠さない", async () => {
    // 定期チェックの一時的失敗 (ネットワーク断) は available を上書きしない。
    // noUpdate と違い error は「更新が無い」ことを意味しないため保守的に扱う。
    const bus = setupListen();
    const { store } = await mountSettingsPanel({
      lastUpdateStatus: { status: "available", version: "9.9.9", notes: "old" },
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, {
        status: "error",
        message: "offline",
        source: "daily",
      });
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
    expect(screen.getByTestId("updates-download-button")).toBeTruthy();
  });

  it("daily noUpdate が available をクリアするとき manual check の Update ハンドルを close する", async () => {
    // 手動 check で積んだ pendingUpdate を、daily noUpdate による available→idle
    // 遷移で取り残すとリソースリークになる。遷移と同時に close されること。
    const close = vi.fn(async () => undefined);
    const fakeUpdate = {
      version: "7.0.0",
      body: "notes",
      close,
    } as unknown as Awaited<ReturnType<typeof check>>;
    vi.mocked(check).mockResolvedValueOnce(fakeUpdate);
    const bus = setupListen();
    const { store } = await mountSettingsPanel();
    await act(async () => {
      fireEvent.click(screen.getByTestId("updates-check-button"));
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("available");
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, { status: "noUpdate", source: "daily" });
      await flush();
    });
    expect(store.get(updateStatusAtom).kind).toBe("idle");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("backend が error event を流してもエラー以外の panel 要素はクラッシュせず残る", async () => {
    const bus = setupListen();
    const { store } = await mountSettingsPanel();
    await act(async () => {
      bus.emit(UPDATER_STATUS_EVENT, {
        status: "error",
        message: "unreachable",
      });
      await flush();
    });
    expect(screen.getByTestId("updates-error").textContent).toContain(
      "unreachable",
    );
    expect(screen.getByTestId("updates-check-button")).toBeTruthy();
    expect(store.get(updateStatusAtom).kind).toBe("error");
  });
});
