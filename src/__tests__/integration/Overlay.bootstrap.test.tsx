import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { act, render, screen } from "@testing-library/react";

import { resetInvoke, setupInvoke } from "../helpers/invokeMock";
import { setupListen } from "../helpers/eventBus";
import { flush } from "../helpers/flush";
import { overlaySettingsAtom } from "../../lib/atoms/overlayAtoms";
import { snapshotsAtom, nowAtom } from "../../lib/atoms/usageAtoms";
import { Overlay } from "../../lib/components/Overlay";
import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_CHANGED_EVENT,
  USAGE_UPDATED_EVENT,
  type UsageSnapshot,
} from "../../lib/types";
import { makeSnapshot } from "../fixtures/snapshots";

function mountOverlay() {
  const store = createStore();
  const rendered = render(
    <Provider store={store}>
      <Overlay />
    </Provider>,
  );
  return { store, ...rendered };
}

afterEach(() => {
  resetInvoke();
});

describe("Overlay bootstrap — snapshots", () => {
  it("populatesRowsFromListSnapshotsWhenNoEventArrivesFirst", async () => {
    setupListen();
    const fixture: UsageSnapshot = makeSnapshot({
      providerId: "webview-claude-ai:weekly",
      accountLabel: "alice",
      remainingPercent: 80,
    });
    setupInvoke({ list_snapshots: [fixture] });
    const { store } = mountOverlay();
    await act(async () => {
      await flush();
    });
    expect(store.get(snapshotsAtom).length).toBe(1);
    expect(screen.queryByTestId("overlay-empty")).toBeNull();
  });

  it("prefersEventPayloadWhenItArrivesBeforeListResolves", async () => {
    const bus = setupListen();
    let resolveList: (v: UsageSnapshot[]) => void = () => {};
    const listPending = new Promise<UsageSnapshot[]>((resolve) => {
      resolveList = resolve;
    });
    const eventSnapshot = makeSnapshot({
      providerId: "p:e",
      accountLabel: "from-event",
    });
    const listSnapshot = makeSnapshot({
      providerId: "p:l",
      accountLabel: "from-list",
    });
    setupInvoke({
      list_snapshots: async () => await listPending,
    });
    const { store } = mountOverlay();
    await act(async () => {
      bus.emit(USAGE_UPDATED_EVENT, [eventSnapshot]);
      await flush();
    });
    await act(async () => {
      resolveList([listSnapshot]);
      await flush();
    });
    // Event arrived first: list result must be discarded so the stale snapshot
    // doesn't roll back fresher data.
    const rows = store.get(snapshotsAtom);
    expect(rows.length).toBe(1);
    expect(rows[0]?.accountLabel).toBe("from-event");
  });

  it("fallsBackToListInvokeWhenListenSubscriptionRejects", async () => {
    const bus = setupListen();
    bus.failNext(new Error("listen denied"));
    const fixture = makeSnapshot({ accountLabel: "bob" });
    setupInvoke({ list_snapshots: [fixture] });
    const { store } = mountOverlay();
    await act(async () => {
      await flush();
    });
    expect(store.get(snapshotsAtom).length).toBe(1);
    expect(store.get(snapshotsAtom)[0]?.accountLabel).toBe("bob");
  });

  it("doesNotApplyListResultWhenUnmountedBeforeItResolves", async () => {
    setupListen();
    let resolveList: (v: UsageSnapshot[]) => void = () => {};
    setupInvoke({
      list_snapshots: async () =>
        await new Promise<UsageSnapshot[]>((resolve) => {
          resolveList = resolve;
        }),
    });
    const { store, unmount } = mountOverlay();
    expect(store.get(snapshotsAtom).length).toBe(0);
    unmount();
    await act(async () => {
      resolveList([makeSnapshot({ accountLabel: "late" })]);
      await flush();
    });
    // Lifecycle.cancelled guard must prevent the late list result from
    // hitting an unmounted atom (no leaked state into a fresh subscription).
    expect(store.get(snapshotsAtom).length).toBe(0);
  });
});

describe("Overlay bootstrap — settings event", () => {
  it("appliesOpacityFromSettingsChangedEvent", async () => {
    const bus = setupListen();
    setupInvoke();
    const { store } = mountOverlay();
    await act(async () => {
      await flush();
    });
    await act(async () => {
      bus.emit(OVERLAY_SETTINGS_CHANGED_EVENT, {
        settings: { ...DEFAULT_OVERLAY_SETTINGS, opacity: 0.21 },
      });
      await flush();
    });
    const root = screen.getByTestId("overlay-root");
    expect(root.style.opacity).toBe("0.21");
    expect(store.get(overlaySettingsAtom).opacity).toBeCloseTo(0.21);
  });
});

describe("Overlay bootstrap — nowAtom tick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("advancesNowAtomEverySecondViaSetInterval", () => {
    setupInvoke();
    setupListen();
    const store = createStore();
    // Subscribing mounts nowAtom and starts its interval.
    const unsub = store.sub(nowAtom, () => {});
    const before = store.get(nowAtom);
    vi.advanceTimersByTime(3000);
    const after = store.get(nowAtom);
    expect(after).toBeGreaterThanOrEqual(before + 3000);
    unsub();
  });

  it("clearsIntervalOnUnmountSoNowAtomStopsAdvancing", () => {
    setupInvoke();
    setupListen();
    const store = createStore();
    const unsub = store.sub(nowAtom, () => {});
    vi.advanceTimersByTime(1000);
    const valueAfterFirstTick = store.get(nowAtom);
    unsub();
    vi.advanceTimersByTime(5000);
    // After unsub, the cleanup callback clearInterval — Jotai unmounts the
    // atom on the next microtask flush, then reads return the cached value.
    expect(store.get(nowAtom)).toBe(valueAfterFirstTick);
  });
});
