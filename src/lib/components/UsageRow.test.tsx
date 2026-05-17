import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

import { snapshotsAtom, nowAtom } from "../atoms/usageAtoms";
import type { UsageSnapshot } from "../types";
import { UsageRow } from "./UsageRow";

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
  resetAt: null,
  observedAt: "2026-05-13T12:00:00Z",
  source: "webview-scrape",
  confidence: "low",
  status: "ok",
  message: null,
  ...overrides,
});

function renderWithSnapshot(
  snapshot: UsageSnapshot,
  compact = false,
  now?: number,
) {
  const store = createStore();
  store.set(snapshotsAtom, [snapshot]);
  if (now !== undefined) store.set(nowAtom, now);
  return render(
    <Provider store={store}>
      <ul>
        <UsageRow snapshot={snapshot} compact={compact} />
      </ul>
    </Provider>,
  );
}

describe("UsageRow", () => {
  it("renders account label and formatted percent for ok status", () => {
    renderWithSnapshot(baseSnapshot());
    expect(screen.getByText("personal")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
  });

  it("uses remaining + metric unit when percent is missing", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: null,
        metric: "requests",
        remaining: 59,
      }),
    );
    expect(screen.getByText("59 req")).toBeTruthy();
  });

  it("falls back to raw used + unit when only used is set (webview snapshot fallback)", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: null,
        remaining: null,
        limit: null,
        used: 3,
        metric: "requests",
        source: "webview-scrape",
        confidence: "low",
        status: "no-data",
      }),
    );
    expect(screen.getByText("3 req")).toBeTruthy();
  });

  it("renders raw used count without a unit suffix for unknown metric", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: null,
        remaining: null,
        limit: null,
        used: 7,
        metric: "unknown",
        status: "no-data",
      }),
    );
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("renders em dash when no usage data is available", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: null,
        remaining: null,
        used: null,
        limit: null,
        status: "no-data",
        message: "no data yet",
      }),
    );
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByTestId("error-badge-no-data")).toBeTruthy();
  });

  it("applies a status-specific CSS class for critical rows", () => {
    renderWithSnapshot(
      baseSnapshot({
        providerId: "webview-claude-ai:crit",
        remainingPercent: 5,
        status: "critical",
      }),
    );
    const row = screen.getByTestId("usage-row-webview-claude-ai:crit");
    expect(row.className.includes("overlay__row--critical")).toBe(true);
  });

  it("hides reset column in compact mode", () => {
    renderWithSnapshot(baseSnapshot(), true);
    expect(screen.queryByText(/reset/)).toBeNull();
  });

  it("renders the reset countdown placeholder when resetAt is null", () => {
    renderWithSnapshot(baseSnapshot());
    expect(screen.getByText(/reset --:--/u)).toBeTruthy();
  });

  it("renders absolute HH:MM when resetAt is in the future", () => {
    const now = Date.UTC(2026, 4, 13, 12, 0, 0);
    // +2 hours from `now`; in any TZ within ±10h of UTC this stays on the
    // same calendar day, which is the regime the row's short format
    // expects. Computing the expected label from the same Date object the
    // component will see keeps the assertion timezone-independent.
    const reset = new Date(now + 2 * 60 * 60 * 1000);
    const hh = reset.getHours().toString().padStart(2, "0");
    const mm = reset.getMinutes().toString().padStart(2, "0");
    renderWithSnapshot(
      baseSnapshot({
        resetAt: reset.toISOString(),
      }),
      false,
      now,
    );
    expect(screen.getByText(new RegExp(`reset ${hh}:${mm}`, "u"))).toBeTruthy();
  });

  it("does not render confidence or source pills on ok rows", () => {
    const { container } = renderWithSnapshot(baseSnapshot());
    expect(screen.queryByTestId("error-badge-confidence-low")).toBeNull();
    expect(
      screen.queryByTestId("error-badge-source-webview-scrape"),
    ).toBeNull();
    expect(container.querySelector(".error-badge-group")).toBeNull();
  });

  it("propagates the error message into the badge group tooltip", () => {
    const { container } = renderWithSnapshot(
      baseSnapshot({
        status: "error",
        source: "unavailable",
        message: "provider unavailable: timeout",
      }),
    );
    const group = container.querySelector(".error-badge-group");
    expect(group?.getAttribute("title")).toBe("provider unavailable: timeout");
  });

  it("renders a usage bar whose fill width matches remainingPercent for ok rows", () => {
    renderWithSnapshot(baseSnapshot());
    const fill = screen.getByTestId("usage-bar-fill");
    expect(fill.style.width).toBe("75%");
  });

  it("draws the bar fill under a critical row with the matching width", () => {
    renderWithSnapshot(
      baseSnapshot({
        providerId: "webview-claude-ai:crit",
        remainingPercent: 5,
        status: "critical",
      }),
    );
    const row = screen.getByTestId("usage-row-webview-claude-ai:crit");
    expect(row.className.includes("overlay__row--critical")).toBe(true);
    const fill = screen.getByTestId("usage-bar-fill");
    expect(fill.style.width).toBe("5%");
    expect(row.contains(fill)).toBe(true);
  });

  it("derives bar width from limit/used when remainingPercent is missing", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: null,
        limit: 40,
        used: 10,
      }),
    );
    const fill = screen.getByTestId("usage-bar-fill");
    expect(fill.style.width).toBe("75%");
  });

  it("renders an empty track without a fill for no-data rows", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: null,
        remaining: null,
        used: null,
        limit: null,
        status: "no-data",
        message: "no data yet",
      }),
    );
    expect(screen.getByTestId("usage-bar")).toBeTruthy();
    expect(screen.queryByTestId("usage-bar-fill")).toBeNull();
  });

  it("renders the bar in compact mode", () => {
    renderWithSnapshot(baseSnapshot(), true);
    expect(screen.getByTestId("usage-bar")).toBeTruthy();
    expect(screen.getByTestId("usage-bar-fill")).toBeTruthy();
  });

  it("clamps remainingPercent above 100 to a full bar", () => {
    renderWithSnapshot(
      baseSnapshot({
        remainingPercent: 142,
      }),
    );
    const fill = screen.getByTestId("usage-bar-fill");
    expect(fill.style.width).toBe("100%");
  });

  it("renders row children flat without a row-main wrapper (subgrid alignment)", () => {
    const { container } = renderWithSnapshot(baseSnapshot());
    expect(container.querySelector(".overlay__row-main")).toBeNull();
    const row = screen.getByTestId("usage-row-webview-claude-ai:default");
    expect(row.querySelector(":scope > .overlay__row-label")).not.toBeNull();
    expect(row.querySelector(":scope > .overlay__row-detail")).not.toBeNull();
    expect(row.querySelector(":scope > .overlay__bar")).not.toBeNull();
  });
});
