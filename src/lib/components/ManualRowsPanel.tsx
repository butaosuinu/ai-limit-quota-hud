import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useState } from "react";

import {
  createManualRowAtom,
  deleteManualRowAtom,
  manualRowsAtom,
  selectedManualRowIdAtom,
  updateManualRowAtom,
} from "../atoms/manualAtoms";
import type {
  ManualRow,
  ManualRowInput,
  UsageMetric,
  UsageWindow,
} from "../types";

const WINDOWS: readonly UsageWindow[] = [
  "one-minute",
  "five-hours",
  "daily",
  "weekly",
  "monthly",
  "api",
  "unknown",
];

const METRICS: readonly UsageMetric[] = [
  "requests",
  "tokens",
  "input-tokens",
  "output-tokens",
  "messages",
  "percent",
  "unknown",
];

type FormState = {
  providerLabel: string;
  accountLabel: string;
  window: UsageWindow;
  metric: UsageMetric;
  limit: string;
  used: string;
  remaining: string;
  resetAt: string;
  note: string;
};

const EMPTY_FORM: FormState = {
  providerLabel: "",
  accountLabel: "",
  window: "five-hours",
  metric: "messages",
  limit: "",
  used: "",
  remaining: "",
  resetAt: "",
  note: "",
};

function rowToForm(row: ManualRow): FormState {
  return {
    providerLabel: row.providerLabel,
    accountLabel: row.accountLabel,
    window: row.window,
    metric: row.metric,
    limit: row.limit === null ? "" : row.limit.toString(),
    used: row.used === null ? "" : row.used.toString(),
    remaining: row.remaining === null ? "" : row.remaining.toString(),
    resetAt: row.resetAt ?? "",
    note: row.note ?? "",
  };
}

function formToInput(state: FormState): ManualRowInput {
  const parseInteger = (raw: string): number | null => {
    if (raw.trim() === "") return null;
    const value = Number.parseInt(raw, 10);
    return Number.isNaN(value) ? null : value;
  };
  return {
    providerLabel: state.providerLabel.trim(),
    accountLabel: state.accountLabel.trim(),
    window: state.window,
    metric: state.metric,
    limit: parseInteger(state.limit),
    used: parseInteger(state.used),
    remaining: parseInteger(state.remaining),
    resetAt: state.resetAt.trim() === "" ? null : state.resetAt,
    note: state.note.trim() === "" ? null : state.note,
  };
}

export function ManualRowsPanel() {
  const rows = useAtomValue(manualRowsAtom);
  const [selectedId, setSelectedId] = useAtom(selectedManualRowIdAtom);
  const createRow = useSetAtom(createManualRowAtom);
  const updateRow = useSetAtom(updateManualRowAtom);
  const deleteRow = useSetAtom(deleteManualRowAtom);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  useEffect(() => {
    if (selectedId === null) {
      setForm(EMPTY_FORM);
      return;
    }
    const row = rows.find((r) => r.id === selectedId);
    if (row !== undefined) {
      setForm(rowToForm(row));
    }
  }, [selectedId, rows]);

  const submit = (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const input = formToInput(form);
    if (input.providerLabel === "" || input.accountLabel === "") return;
    if (selectedId === null) {
      void createRow(input);
    } else {
      void updateRow({ id: selectedId, input });
      setSelectedId(null);
    }
    setForm(EMPTY_FORM);
  };

  const startEdit = (id: string) => {
    setSelectedId(id);
  };

  const cancelEdit = () => {
    setSelectedId(null);
    setForm(EMPTY_FORM);
  };

  const remove = (id: string) => {
    if (selectedId === id) setSelectedId(null);
    void deleteRow(id);
  };

  const updateField =
    <K extends keyof FormState>(field: K) =>
    (value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [field]: value }));
    };

  return (
    <div className="manual-rows" data-testid="manual-rows-panel">
      <header className="manual-rows__header">
        <h3>Manual rows</h3>
        <p className="manual-rows__hint">
          UI から手動行を追加・編集・削除できます。confidence は常に
          <code>low</code> です。
        </p>
      </header>

      {rows.length === 0 ? (
        <p className="manual-rows__empty" data-testid="manual-rows-empty">
          まだ手動行がありません。下のフォームから追加してください。
        </p>
      ) : (
        <ul className="manual-rows__list">
          {rows.map((row) => (
            <li
              key={row.id}
              className="manual-rows__item"
              data-testid={`manual-row-${row.id}`}
            >
              <span className="manual-rows__item-label">
                {row.providerLabel} · {row.accountLabel}
              </span>
              <span className="manual-rows__item-detail">
                {row.metric} / {row.window}
              </span>
              <button
                type="button"
                onClick={() => {
                  startEdit(row.id);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => {
                  remove(row.id);
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="manual-rows__form" onSubmit={submit}>
        <h4>
          {selectedId === null ? "Add a manual row" : "Edit selected row"}
        </h4>
        <label className="manual-rows__field">
          Provider label
          <input
            type="text"
            value={form.providerLabel}
            onChange={(event) => {
              updateField("providerLabel")(event.currentTarget.value);
            }}
            data-testid="manual-form-provider-label"
            required
          />
        </label>
        <label className="manual-rows__field">
          Account label
          <input
            type="text"
            value={form.accountLabel}
            onChange={(event) => {
              updateField("accountLabel")(event.currentTarget.value);
            }}
            data-testid="manual-form-account-label"
            required
          />
        </label>
        <label className="manual-rows__field">
          Window
          <select
            value={form.window}
            onChange={(event) => {
              updateField("window")(event.currentTarget.value as UsageWindow);
            }}
            data-testid="manual-form-window"
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label className="manual-rows__field">
          Metric
          <select
            value={form.metric}
            onChange={(event) => {
              updateField("metric")(event.currentTarget.value as UsageMetric);
            }}
            data-testid="manual-form-metric"
          >
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="manual-rows__field">
          Limit
          <input
            type="number"
            inputMode="numeric"
            value={form.limit}
            onChange={(event) => {
              updateField("limit")(event.currentTarget.value);
            }}
            data-testid="manual-form-limit"
          />
        </label>
        <label className="manual-rows__field">
          Used
          <input
            type="number"
            inputMode="numeric"
            value={form.used}
            onChange={(event) => {
              updateField("used")(event.currentTarget.value);
            }}
            data-testid="manual-form-used"
          />
        </label>
        <label className="manual-rows__field">
          Remaining
          <input
            type="number"
            inputMode="numeric"
            value={form.remaining}
            onChange={(event) => {
              updateField("remaining")(event.currentTarget.value);
            }}
            data-testid="manual-form-remaining"
          />
        </label>
        <label className="manual-rows__field">
          Reset at (ISO 8601)
          <input
            type="text"
            placeholder="2026-05-13T17:00:00Z"
            value={form.resetAt}
            onChange={(event) => {
              updateField("resetAt")(event.currentTarget.value);
            }}
            data-testid="manual-form-reset-at"
          />
        </label>
        <label className="manual-rows__field">
          Note
          <input
            type="text"
            value={form.note}
            onChange={(event) => {
              updateField("note")(event.currentTarget.value);
            }}
            data-testid="manual-form-note"
          />
        </label>
        <div className="manual-rows__actions">
          <button type="submit" data-testid="manual-form-submit">
            {selectedId === null ? "Add" : "Save"}
          </button>
          {selectedId !== null && (
            <button
              type="button"
              onClick={cancelEdit}
              data-testid="manual-form-cancel"
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
