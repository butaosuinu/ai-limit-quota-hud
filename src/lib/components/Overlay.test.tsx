import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { snapshotsAtom } from "../atoms/usageAtoms";
import { DEFAULT_OVERLAY_SETTINGS, type UsageSnapshot } from "../types";
import { Overlay } from "./Overlay";

const baseSnapshot = (
  overrides: Partial<UsageSnapshot> = {},
): UsageSnapshot => ({
  providerId: "manual:row-1",
  providerKind: "manual",
  accountLabel: "personal",
  window: "five-hours",
  metric: "messages",
  limit: 40,
  used: 10,
  remaining: 30,
  remainingPercent: 75,
  resetAt: null,
  observedAt: "2026-05-13T12:00:00Z",
  source: "manual",
  confidence: "low",
  status: "ok",
  message: null,
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

describe("Overlay", () => {
  it("shows the empty placeholder when no snapshots are present", () => {
    renderOverlay({ snapshots: [] });
    expect(screen.getByTestId("overlay-empty")).toBeTruthy();
    expect(screen.getByText("no providers configured")).toBeTruthy();
  });

  it("renders one UsageRow per snapshot, sorted by severity", () => {
    renderOverlay({
      snapshots: [
        baseSnapshot({
          providerId: "manual:a",
          accountLabel: "alice",
          status: "ok",
        }),
        baseSnapshot({
          providerId: "manual:b",
          accountLabel: "bob",
          status: "critical",
          remainingPercent: 5,
        }),
      ],
    });
    const rows = screen.getAllByText(/^(?:alice|bob)$/u);
    // bob has critical status — should appear before alice in the DOM.
    expect(rows[0]?.textContent).toBe("bob");
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
    expect(root.getAttribute("data-tauri-drag-region")).toBe("true");
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
          providerId: "manual:nd",
          status: "no-data",
          remainingPercent: null,
          remaining: null,
          limit: null,
          used: null,
        }),
      ],
    });
    expect(screen.getByTestId("error-badge-no-data")).toBeTruthy();
  });
});
