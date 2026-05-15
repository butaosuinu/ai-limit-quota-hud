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

  it("renders mm:ss when resetAt is in the future", () => {
    const now = Date.UTC(2026, 4, 13, 12, 0, 0);
    renderWithSnapshot(
      baseSnapshot({
        resetAt: new Date(now + 125_000).toISOString(),
      }),
      false,
      now,
    );
    expect(screen.getByText(/reset 2:05/u)).toBeTruthy();
  });

  it("shows confidence and source badges for webview rows", () => {
    renderWithSnapshot(baseSnapshot());
    expect(screen.getByTestId("error-badge-confidence-low")).toBeTruthy();
    expect(
      screen.getByTestId("error-badge-source-webview-scrape"),
    ).toBeTruthy();
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
});
