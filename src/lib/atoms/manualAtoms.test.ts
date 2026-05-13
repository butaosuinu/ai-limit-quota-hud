import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createStore } from "jotai";

import type { ManualRow, ManualRowInput } from "../types";
import {
  createManualRowAtom,
  deleteManualRowAtom,
  manualRowsAtom,
  manualRowsErrorAtom,
  refetchManualRowsAtom,
  updateManualRowAtom,
} from "./manualAtoms";

const mockedInvoke = vi.mocked(invoke);

const sampleRow = (overrides: Partial<ManualRow> = {}): ManualRow => ({
  id: "row-1",
  providerLabel: "ChatGPT",
  accountLabel: "personal",
  window: "five-hours",
  metric: "messages",
  limit: 40,
  used: 10,
  remaining: 30,
  resetAt: null,
  note: null,
  createdAt: "2026-05-01T00:00:00Z",
  updatedAt: "2026-05-13T12:00:00Z",
  ...overrides,
});

const sampleInput = (
  overrides: Partial<ManualRowInput> = {},
): ManualRowInput => ({
  providerLabel: "ChatGPT",
  accountLabel: "personal",
  window: "five-hours",
  metric: "messages",
  limit: 40,
  used: 10,
  remaining: 30,
  resetAt: null,
  note: null,
  ...overrides,
});

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async () => undefined);
});

afterEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async () => undefined);
});

describe("createManualRowAtom", () => {
  it("appends the returned row, returns true, and skips a list refetch", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "create_manual_row") {
        return sampleRow();
      }
      return undefined;
    });
    const store = createStore();
    const ok = await store.set(createManualRowAtom, sampleInput());
    expect(ok).toBe(true);
    const rows = store.get(manualRowsAtom);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row-1");
    expect(store.get(manualRowsErrorAtom)).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledWith("create_manual_row", {
      input: sampleInput(),
    });
    expect(
      mockedInvoke.mock.calls.find(([cmd]) => cmd === "list_manual_rows"),
    ).toBeUndefined();
  });

  it("returns false and surfaces the failure on create failure", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "create_manual_row") {
        return Promise.reject(new Error("sqlite is locked"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    store.set(manualRowsAtom, []);
    const ok = await store.set(createManualRowAtom, sampleInput());
    expect(ok).toBe(false);
    expect(store.get(manualRowsAtom)).toEqual([]);
    expect(store.get(manualRowsErrorAtom)).toMatchInlineSnapshot(
      `"行の追加に失敗: sqlite is locked"`,
    );
  });

  it("clears a prior error after a successful create", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "create_manual_row") {
        return sampleRow();
      }
      return undefined;
    });
    const store = createStore();
    store.set(manualRowsErrorAtom, "stale error");
    await store.set(createManualRowAtom, sampleInput());
    expect(store.get(manualRowsErrorAtom)).toBeNull();
  });
});

describe("updateManualRowAtom", () => {
  it("replaces the matching row and returns true", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "update_manual_row") {
        return sampleRow({ note: "edited" });
      }
      return undefined;
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow()]);
    const ok = await store.set(updateManualRowAtom, {
      id: "row-1",
      input: sampleInput({ note: "edited" }),
    });
    expect(ok).toBe(true);
    const rows = store.get(manualRowsAtom);
    expect(rows[0]?.note).toBe("edited");
    expect(mockedInvoke).toHaveBeenCalledWith("update_manual_row", {
      id: "row-1",
      input: sampleInput({ note: "edited" }),
    });
  });

  it("returns false and surfaces the failure on update failure", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "update_manual_row") {
        return Promise.reject(new Error("not found"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow()]);
    const ok = await store.set(updateManualRowAtom, {
      id: "row-1",
      input: sampleInput(),
    });
    expect(ok).toBe(false);
    expect(store.get(manualRowsErrorAtom)).toMatchInlineSnapshot(
      `"行の更新に失敗: not found"`,
    );
  });
});

describe("deleteManualRowAtom", () => {
  it("removes the row, returns true, and skips a list refetch", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "delete_manual_row") {
        return undefined;
      }
      return undefined;
    });
    const store = createStore();
    store.set(manualRowsAtom, [
      sampleRow({ id: "row-1" }),
      sampleRow({ id: "row-2", accountLabel: "work" }),
    ]);
    const ok = await store.set(deleteManualRowAtom, "row-1");
    expect(ok).toBe(true);
    const rows = store.get(manualRowsAtom);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row-2");
    expect(store.get(manualRowsErrorAtom)).toBeNull();
    expect(
      mockedInvoke.mock.calls.find(([cmd]) => cmd === "list_manual_rows"),
    ).toBeUndefined();
  });

  it("returns false and surfaces the failure when delete fails", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "delete_manual_row") {
        return Promise.reject(new Error("sqlite is busy"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow({ id: "row-1" })]);
    const ok = await store.set(deleteManualRowAtom, "row-1");
    expect(ok).toBe(false);
    expect(store.get(manualRowsAtom)).toHaveLength(1);
    expect(store.get(manualRowsErrorAtom)).toMatchInlineSnapshot(
      `"行の削除に失敗: sqlite is busy"`,
    );
  });
});

describe("bootstrap race", () => {
  it("does not overwrite rows that a CRUD mutation wrote during the initial fetch", async () => {
    const resolverRef: {
      resolve: ((rows: ManualRow[]) => void) | null;
    } = { resolve: null };
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_manual_rows") {
        return new Promise<ManualRow[]>((resolve) => {
          resolverRef.resolve = resolve;
        });
      }
      if (command === "create_manual_row") {
        return Promise.resolve(sampleRow({ id: "user-row" }));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    // Subscribing mounts the underlying state atom, which kicks off bootstrap.
    const unsub = store.sub(manualRowsAtom, () => undefined);
    // Let onMount + the bootstrap function start.
    await Promise.resolve();
    expect(resolverRef.resolve).not.toBeNull();
    // User creates a row while list_manual_rows is still in flight.
    await store.set(createManualRowAtom, sampleInput());
    expect(store.get(manualRowsAtom).map((r) => r.id)).toEqual(["user-row"]);
    // Bootstrap now resolves with stale data — it must not clobber `user-row`.
    if (resolverRef.resolve !== null) {
      resolverRef.resolve([sampleRow({ id: "stale" })]);
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get(manualRowsAtom).map((r) => r.id)).toEqual(["user-row"]);
    unsub();
  });
});

describe("refetchManualRowsAtom", () => {
  it("preserves existing rows when list_manual_rows fails", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "list_manual_rows") {
        return Promise.reject(new Error("ipc closed"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    const existing = [
      sampleRow({ id: "row-a", accountLabel: "alice" }),
      sampleRow({ id: "row-b", accountLabel: "bob" }),
    ];
    store.set(manualRowsAtom, existing);
    await store.set(refetchManualRowsAtom);
    // Rows must not be wiped just because the fetch failed.
    expect(store.get(manualRowsAtom).map((r) => r.id)).toEqual([
      "row-a",
      "row-b",
    ]);
    expect(store.get(manualRowsErrorAtom)).toMatchInlineSnapshot(
      `"行の取得に失敗: ipc closed"`,
    );
  });

  it("replaces rows and clears error on a successful refetch", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "list_manual_rows") {
        return [sampleRow({ id: "row-fresh" })];
      }
      return undefined;
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow({ id: "stale" })]);
    store.set(manualRowsErrorAtom, "previous error");
    await store.set(refetchManualRowsAtom);
    expect(store.get(manualRowsAtom).map((r) => r.id)).toEqual(["row-fresh"]);
    expect(store.get(manualRowsErrorAtom)).toBeNull();
  });
});
