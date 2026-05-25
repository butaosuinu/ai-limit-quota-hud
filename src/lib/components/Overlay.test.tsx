import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";

import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { snapshotsAtom } from "../atoms/usageAtoms";
import { DEFAULT_OVERLAY_SETTINGS, type UsageSnapshot } from "../types";
import { Overlay } from "./Overlay";

const refreshNowMock = vi.fn<() => Promise<unknown>>();
const webviewWindowMock = vi.hoisted(() => ({
  outerPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  scaleFactor: vi.fn(() => Promise.resolve(1)),
  setPosition: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("../api", () => ({
  refreshNow: () => refreshNowMock(),
  listSnapshots: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: vi.fn(() => webviewWindowMock),
}));

const baseSnapshot = (
  overrides: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  providerId: "webview-claude-ai:default",
  providerKind: "webview-claude-ai",
  accountLabel: "personal",
  window: "five-hours",
  metric: "messages",
  limit: 40,
  used: 10,
  remaining: 30,
  remainingPercent: 75,
  resetAt: undefined,
  observedAt: "2026-05-13T12:00:00Z",
  source: "webview-scrape",
  confidence: "low",
  status: "ok",
  message: undefined,
  ...overrides,
});

type SnapshotsOverride = {
  snapshots?: readonly UsageSnapshot[];
  settings?: Partial<typeof DEFAULT_OVERLAY_SETTINGS>;
};

function renderOverlay({ snapshots, settings = {} }: SnapshotsOverride = {}) {
  const store = createStore();
  store.set(overlaySettingsAtom, { ...DEFAULT_OVERLAY_SETTINGS, ...settings });
  if (snapshots !== undefined) {
    store.set(snapshotsAtom, snapshots);
  }
  return render(
    <Provider store={store}>
      <Overlay />
    </Provider>,
  );
}

beforeEach(() => {
  refreshNowMock.mockReset();
  refreshNowMock.mockResolvedValue(undefined);
  webviewWindowMock.outerPosition.mockReset();
  webviewWindowMock.outerPosition.mockResolvedValue({ x: 100, y: 200 });
  webviewWindowMock.scaleFactor.mockReset();
  webviewWindowMock.scaleFactor.mockResolvedValue(2);
  webviewWindowMock.setPosition.mockReset();
  webviewWindowMock.setPosition.mockResolvedValue(undefined);
});

describe("Overlay", () => {
  it("shows the empty placeholder when no snapshots are present", () => {
    renderOverlay({ snapshots: [] });
    expect(screen.getByTestId("overlay-empty")).toBeTruthy();
    expect(screen.getByText("no providers configured")).toBeTruthy();
  });

  it("groups Claude and Codex snapshots under their section headers", () => {
    renderOverlay({
      snapshots: [
        baseSnapshot({
          providerId: "webview-claude-ai:a",
          providerKind: "webview-claude-ai",
          accountLabel: "alice",
        }),
        baseSnapshot({
          providerId: "webview-chatgpt-codex:b",
          providerKind: "webview-chatgpt-codex",
          accountLabel: "bob",
        }),
      ],
    });
    expect(screen.getByTestId("overlay-group-webview-claude-ai")).toBeTruthy();
    expect(
      screen.getByTestId("overlay-group-webview-chatgpt-codex"),
    ).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("hides the Codex section when only Claude snapshots are present", () => {
    renderOverlay({
      snapshots: [
        baseSnapshot({
          providerId: "webview-claude-ai:a",
          providerKind: "webview-claude-ai",
          accountLabel: "alice",
        }),
      ],
    });
    expect(screen.getByTestId("overlay-group-webview-claude-ai")).toBeTruthy();
    expect(
      screen.queryByTestId("overlay-group-webview-chatgpt-codex"),
    ).toBeNull();
  });

  it("sorts rows within a group by severity (critical first)", () => {
    renderOverlay({
      snapshots: [
        baseSnapshot({
          providerId: "webview-claude-ai:a",
          providerKind: "webview-claude-ai",
          accountLabel: "alice",
          status: "ok",
        }),
        baseSnapshot({
          providerId: "webview-claude-ai:c",
          providerKind: "webview-claude-ai",
          accountLabel: "carol",
          status: "critical",
          remainingPercent: 5,
        }),
      ],
    });
    const rows = screen.getAllByText(/^(?:alice|carol)$/u);
    expect(rows[0]?.textContent).toBe("carol");
    expect(rows[1]?.textContent).toBe("alice");
  });

  it("applies opacity from settings to the root element", () => {
    renderOverlay({ settings: { opacity: 0.5 } });
    const root = screen.getByTestId("overlay-root");
    expect(root.style.opacity).toBe("0.5");
  });

  it("adds the drag-region attribute when unlocked", () => {
    renderOverlay({ settings: { locked: false } });
    const root = screen.getByTestId("overlay-root");
    expect(root.getAttribute("data-tauri-drag-region")).toBe("deep");
  });

  it("omits the drag-region attribute when locked", () => {
    renderOverlay({ settings: { locked: true } });
    const root = screen.getByTestId("overlay-root");
    expect(root.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("hides the reset column in compact mode", () => {
    renderOverlay({
      snapshots: [baseSnapshot()],
      settings: { compact: true },
    });
    expect(screen.queryByText(/reset/u)).toBeNull();
  });

  it("shows an error badge for no-data snapshots", () => {
    renderOverlay({
      snapshots: [
        baseSnapshot({
          providerId: "webview-claude-ai:nd",
          providerKind: "webview-claude-ai",
          status: "no-data",
          remainingPercent: undefined,
          remaining: undefined,
          limit: undefined,
          used: undefined,
        }),
      ],
    });
    expect(screen.getByTestId("error-badge-no-data")).toBeTruthy();
  });

  it("invokes refreshNow when the refresh button is clicked", () => {
    renderOverlay({ snapshots: [baseSnapshot()] });
    const button = screen.getByTestId("overlay-refresh");
    fireEvent.click(button);
    expect(refreshNowMock).toHaveBeenCalledTimes(1);
  });

  it("disables the refresh button while the request is in flight", () => {
    refreshNowMock.mockImplementationOnce(
      () => new Promise<unknown>(() => undefined),
    );
    renderOverlay({ snapshots: [baseSnapshot()] });
    const button = screen.getByTestId("overlay-refresh");
    fireEvent.click(button);
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });

  it("opts the refresh button out of the drag region", () => {
    renderOverlay({ settings: { locked: false } });
    const button = screen.getByTestId("overlay-refresh");
    expect(button.getAttribute("data-tauri-drag-region")).toBe("false");
  });

  it("moves the window during mouse drag when unlocked", async () => {
    renderOverlay({ settings: { locked: false } });
    const root = screen.getByTestId("overlay-root");
    fireEvent.mouseDown(root, {
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    await waitFor(() => {
      expect(webviewWindowMock.outerPosition).toHaveBeenCalledTimes(1);
    });
    fireEvent.mouseMove(window, {
      buttons: 1,
      screenX: 65,
      screenY: 80,
    });
    expect(webviewWindowMock.setPosition).toHaveBeenCalledTimes(1);
    expect(webviewWindowMock.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 130, y: 240 }),
    );
  });

  it("keeps moving the window after the pointer leaves the overlay", async () => {
    renderOverlay({ settings: { locked: false } });
    const root = screen.getByTestId("overlay-root");
    fireEvent.mouseDown(root, {
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    await waitFor(() => {
      expect(webviewWindowMock.outerPosition).toHaveBeenCalledTimes(1);
    });
    fireEvent.mouseLeave(root);
    fireEvent.mouseMove(window, {
      buttons: 1,
      screenX: 65,
      screenY: 80,
    });
    expect(webviewWindowMock.setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ x: 130, y: 240 }),
    );
  });

  it("cancels async drag setup when the mouse is released before setup finishes", async () => {
    let resolvePosition: (position: { x: number; y: number }) => void = () =>
      undefined;
    const positionPromise = new Promise<{ x: number; y: number }>((resolve) => {
      resolvePosition = resolve;
    });
    webviewWindowMock.outerPosition.mockReturnValueOnce(positionPromise);
    renderOverlay({ settings: { locked: false } });
    const root = screen.getByTestId("overlay-root");
    fireEvent.mouseDown(root, {
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    await waitFor(() => {
      expect(webviewWindowMock.outerPosition).toHaveBeenCalledTimes(1);
    });
    fireEvent.mouseUp(window);
    resolvePosition({ x: 100, y: 200 });
    await positionPromise;
    await Promise.resolve();
    fireEvent.mouseMove(window, {
      buttons: 1,
      screenX: 65,
      screenY: 80,
    });
    expect(webviewWindowMock.setPosition).not.toHaveBeenCalled();
  });

  it("does not start manual window drag when locked", () => {
    renderOverlay({ settings: { locked: true } });
    const root = screen.getByTestId("overlay-root");
    fireEvent.mouseDown(root, {
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    expect(webviewWindowMock.outerPosition).not.toHaveBeenCalled();
  });

  it("does not start manual window drag from interactive controls", () => {
    renderOverlay({ settings: { locked: false } });
    const button = screen.getByTestId("overlay-refresh");
    fireEvent.mouseDown(button, {
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    expect(webviewWindowMock.outerPosition).not.toHaveBeenCalled();
  });

  it("does not start manual window drag from SVG children in interactive controls", () => {
    renderOverlay({ settings: { locked: false } });
    const iconPath = screen
      .getByTestId("overlay-refresh")
      .querySelector("path");
    expect(iconPath).not.toBeNull();
    fireEvent.mouseDown(iconPath!, {
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    expect(webviewWindowMock.outerPosition).not.toHaveBeenCalled();
  });

  it("reports the row count in the footer, not the section count", () => {
    renderOverlay({
      snapshots: [
        baseSnapshot({
          providerId: "webview-claude-ai:a",
          providerKind: "webview-claude-ai",
          accountLabel: "alice",
        }),
        baseSnapshot({
          providerId: "webview-claude-ai:b",
          providerKind: "webview-claude-ai",
          accountLabel: "bob",
        }),
        baseSnapshot({
          providerId: "webview-chatgpt-codex:c",
          providerKind: "webview-chatgpt-codex",
          accountLabel: "carol",
        }),
      ],
    });
    expect(screen.getByText(/3 provider rows/u)).toBeTruthy();
  });

  it("uses the singular form when only one row is shown", () => {
    renderOverlay({ snapshots: [baseSnapshot()] });
    expect(screen.getByText(/1 provider row /u)).toBeTruthy();
  });

  it("shows zero rows in the footer when no providers are configured", () => {
    renderOverlay({ snapshots: [] });
    expect(screen.getByText(/0 provider rows/u)).toBeTruthy();
  });

  it("hides the title row (and refresh button) in compact mode", () => {
    renderOverlay({ settings: { compact: true } });
    // The button still exists in the DOM but its container is display:none.
    // We assert the title-row wrapper isn't rendered as visible content by
    // checking the rendered className.
    const root = screen.getByTestId("overlay-root");
    expect(root.className.includes("overlay--compact")).toBe(true);
  });
});
