import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createStore } from "jotai";

import type { ManualRow, ManualRowInput } from "../types";
import {
  createManualRowAtom,
  deleteManualRowAtom,
  manualRowsAtom,
  manualRowsErrorAtom,
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
  it("appends the returned row without a follow-up list_manual_rows fetch", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "create_manual_row") {
        return sampleRow();
      }
      return undefined;
    });
    const store = createStore();
    await store.set(createManualRowAtom, sampleInput());
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

  it("surfaces the failure into manualRowsErrorAtom on create failure", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "create_manual_row") {
        return Promise.reject(new Error("sqlite is locked"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    store.set(manualRowsAtom, []);
    await store.set(createManualRowAtom, sampleInput());
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
  it("replaces the matching row with the returned payload", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "update_manual_row") {
        return sampleRow({ note: "edited" });
      }
      return undefined;
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow()]);
    await store.set(updateManualRowAtom, {
      id: "row-1",
      input: sampleInput({ note: "edited" }),
    });
    const rows = store.get(manualRowsAtom);
    expect(rows[0]?.note).toBe("edited");
    expect(mockedInvoke).toHaveBeenCalledWith("update_manual_row", {
      id: "row-1",
      input: sampleInput({ note: "edited" }),
    });
  });

  it("surfaces the failure into manualRowsErrorAtom on update failure", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "update_manual_row") {
        return Promise.reject(new Error("not found"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow()]);
    await store.set(updateManualRowAtom, {
      id: "row-1",
      input: sampleInput(),
    });
    expect(store.get(manualRowsErrorAtom)).toMatchInlineSnapshot(
      `"行の更新に失敗: not found"`,
    );
  });
});

describe("deleteManualRowAtom", () => {
  it("removes the row locally without a follow-up list fetch", async () => {
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
    await store.set(deleteManualRowAtom, "row-1");
    const rows = store.get(manualRowsAtom);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row-2");
    expect(store.get(manualRowsErrorAtom)).toBeNull();
    expect(
      mockedInvoke.mock.calls.find(([cmd]) => cmd === "list_manual_rows"),
    ).toBeUndefined();
  });

  it("keeps the row and surfaces the failure when delete fails", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "delete_manual_row") {
        return Promise.reject(new Error("sqlite is busy"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow({ id: "row-1" })]);
    await store.set(deleteManualRowAtom, "row-1");
    expect(store.get(manualRowsAtom)).toHaveLength(1);
    expect(store.get(manualRowsErrorAtom)).toMatchInlineSnapshot(
      `"行の削除に失敗: sqlite is busy"`,
    );
  });
});
