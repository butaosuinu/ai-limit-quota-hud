import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Provider, createStore } from "jotai";

import { manualRowsAtom, manualRowsErrorAtom } from "../atoms/manualAtoms";
import type { ManualRow } from "../types";
import { ManualRowsPanel } from "./ManualRowsPanel";

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

function renderPanel(initialRows: ManualRow[] = []) {
  const store = createStore();
  store.set(manualRowsAtom, initialRows);
  return {
    store,
    ...render(
      <Provider store={store}>
        <ManualRowsPanel />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async () => undefined);
});

afterEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async () => undefined);
});

describe("ManualRowsPanel", () => {
  it("shows the empty placeholder when no rows are stored", () => {
    renderPanel();
    expect(screen.getByTestId("manual-rows-empty")).toBeTruthy();
  });

  it("lists existing rows", () => {
    renderPanel([
      sampleRow({ id: "row-a", accountLabel: "alice" }),
      sampleRow({ id: "row-b", accountLabel: "bob" }),
    ]);
    expect(screen.getByTestId("manual-row-row-a")).toBeTruthy();
    expect(screen.getByTestId("manual-row-row-b")).toBeTruthy();
  });

  it("calls create_manual_row when submitting the add form", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "create_manual_row") return sampleRow();
      if (command === "list_manual_rows") return [sampleRow()];
      return undefined;
    });
    renderPanel();
    fireEvent.change(screen.getByTestId("manual-form-provider-label"), {
      target: { value: "ChatGPT" },
    });
    fireEvent.change(screen.getByTestId("manual-form-account-label"), {
      target: { value: "personal" },
    });
    fireEvent.change(screen.getByTestId("manual-form-limit"), {
      target: { value: "40" },
    });
    fireEvent.click(screen.getByTestId("manual-form-submit"));
    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.find(([cmd]) => cmd === "create_manual_row"),
      ).toBeTruthy();
    });
    const createCall = mockedInvoke.mock.calls.find(
      ([cmd]) => cmd === "create_manual_row",
    );
    expect(createCall?.[1]).toMatchObject({
      input: { providerLabel: "ChatGPT", accountLabel: "personal", limit: 40 },
    });
  });

  it("ignores submissions with empty required fields", () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("manual-form-submit"));
    expect(
      mockedInvoke.mock.calls.find(([cmd]) => cmd === "create_manual_row"),
    ).toBeUndefined();
  });

  it("calls delete_manual_row when the Delete button is clicked", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "delete_manual_row") return undefined;
      if (command === "list_manual_rows") return [];
      return undefined;
    });
    renderPanel([sampleRow({ id: "row-x" })]);
    const deleteButton = screen
      .getByTestId("manual-row-row-x")
      .querySelector("button:last-of-type");
    expect(deleteButton).toBeTruthy();
    fireEvent.click(deleteButton as HTMLButtonElement);
    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.find(([cmd]) => cmd === "delete_manual_row"),
      ).toBeTruthy();
    });
    const deleteCall = mockedInvoke.mock.calls.find(
      ([cmd]) => cmd === "delete_manual_row",
    );
    expect(deleteCall?.[1]).toEqual({ id: "row-x" });
  });

  it("rejects non-integer numeric input and shows a form error", () => {
    renderPanel();
    fireEvent.change(screen.getByTestId("manual-form-provider-label"), {
      target: { value: "ChatGPT" },
    });
    fireEvent.change(screen.getByTestId("manual-form-account-label"), {
      target: { value: "personal" },
    });
    fireEvent.change(screen.getByTestId("manual-form-limit"), {
      target: { value: "12.9" },
    });
    fireEvent.click(screen.getByTestId("manual-form-submit"));
    expect(screen.getByTestId("manual-rows-form-error")).toBeTruthy();
    expect(
      mockedInvoke.mock.calls.find(([cmd]) => cmd === "create_manual_row"),
    ).toBeUndefined();
  });

  it("surfaces backend errors from manualRowsErrorAtom", () => {
    const store = createStore();
    store.set(manualRowsErrorAtom, "行の追加に失敗: sqlite is locked");
    render(
      <Provider store={store}>
        <ManualRowsPanel />
      </Provider>,
    );
    const banner = screen.getByTestId("manual-rows-error");
    expect(banner.textContent).toContain("sqlite is locked");
  });

  it("keeps the typed form values when the create command fails", async () => {
    mockedInvoke.mockImplementation((command) => {
      if (command === "create_manual_row") {
        return Promise.reject(new Error("sqlite is locked"));
      }
      return Promise.resolve(undefined);
    });
    renderPanel();
    const asInput = (testId: string): HTMLInputElement => {
      const el = screen.getByTestId(testId);
      if (!(el instanceof HTMLInputElement)) {
        throw new Error(`${testId} is not an HTMLInputElement`);
      }
      return el;
    };
    const providerInput = asInput("manual-form-provider-label");
    const accountInput = asInput("manual-form-account-label");
    const limitInput = asInput("manual-form-limit");
    fireEvent.change(providerInput, { target: { value: "ChatGPT" } });
    fireEvent.change(accountInput, { target: { value: "personal" } });
    fireEvent.change(limitInput, { target: { value: "40" } });
    fireEvent.click(screen.getByTestId("manual-form-submit"));
    await waitFor(() => {
      expect(
        mockedInvoke.mock.calls.find(([cmd]) => cmd === "create_manual_row"),
      ).toBeTruthy();
    });
    // The async create promise rejects → form must retain values so the user
    // can fix and retry without re-typing.
    expect(providerInput.value).toBe("ChatGPT");
    expect(accountInput.value).toBe("personal");
    expect(limitInput.value).toBe("40");
  });
});
