import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createStore } from "jotai";

import type { ManualRow, ManualRowInput } from "../types";
import {
  createManualRowAtom,
  deleteManualRowAtom,
  manualRowsAtom,
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
  it("creates the row and refetches the list", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "create_manual_row") {
        return sampleRow();
      }
      if (command === "list_manual_rows") {
        return [sampleRow()];
      }
      return undefined;
    });
    const store = createStore();
    await store.set(createManualRowAtom, sampleInput());
    const rows = store.get(manualRowsAtom);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("row-1");
    expect(mockedInvoke).toHaveBeenCalledWith("create_manual_row", {
      input: sampleInput(),
    });
    expect(mockedInvoke).toHaveBeenCalledWith("list_manual_rows");
  });
});

describe("updateManualRowAtom", () => {
  it("updates the row and refetches the list", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "update_manual_row") {
        return sampleRow({ note: "edited" });
      }
      if (command === "list_manual_rows") {
        return [sampleRow({ note: "edited" })];
      }
      return undefined;
    });
    const store = createStore();
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
});

describe("deleteManualRowAtom", () => {
  it("deletes the row and refetches an empty list", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "delete_manual_row") {
        return undefined;
      }
      if (command === "list_manual_rows") {
        return [];
      }
      return undefined;
    });
    const store = createStore();
    store.set(manualRowsAtom, [sampleRow()]);
    await store.set(deleteManualRowAtom, "row-1");
    expect(store.get(manualRowsAtom)).toHaveLength(0);
    expect(mockedInvoke).toHaveBeenCalledWith("delete_manual_row", {
      id: "row-1",
    });
  });
});

describe("manualRowsAtom failure tolerance", () => {
  it("falls back to an empty list when refetch errors out", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "create_manual_row") {
        return Promise.resolve(sampleRow());
      }
      if (command === "list_manual_rows") {
        return Promise.reject(new Error("backend down"));
      }
      return Promise.resolve(undefined);
    });
    const store = createStore();
    await store.set(createManualRowAtom, sampleInput());
    expect(store.get(manualRowsAtom)).toEqual([]);
  });
});
