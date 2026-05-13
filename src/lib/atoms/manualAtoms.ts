import { atom } from "jotai";

import {
  createManualRow,
  deleteManualRow,
  listManualRows,
  updateManualRow,
} from "../api";
import type { ManualRow, ManualRowInput } from "../types";

/**
 * Manual rows + last-command error live in a single state atom so the
 * settings UI never sees a stale rows-list paired with a no-longer-relevant
 * error message, and so transient list_manual_rows failures don't blow away
 * the rows we already have.
 */
type ManualRowsState = {
  rows: readonly ManualRow[];
  error: string | null;
};

const stateAtom = atom<ManualRowsState>({ rows: [], error: null });

type Lifecycle = { cancelled: boolean };

stateAtom.onMount = (set) => {
  const lifecycle: Lifecycle = { cancelled: false };
  void bootstrap(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
  };
};

const FAILURE_MARKER = Symbol("manual-row-failure");
type Failure = { readonly [FAILURE_MARKER]: true; message: string };
const failure = (message: string): Failure => ({
  [FAILURE_MARKER]: true,
  message,
});
const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && FAILURE_MARKER in value;

function describeError(action: string, err: unknown): string {
  if (typeof err === "string") return `${action}: ${err}`;
  if (err instanceof Error) return `${action}: ${err.message}`;
  return `${action} failed`;
}

async function bootstrap(
  setState: (next: ManualRowsState) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  const result = await listManualRows().catch(
    (err: unknown): Failure => failure(describeError("行の取得に失敗", err)),
  );
  if (lifecycle.cancelled) return;
  if (isFailure(result)) {
    // First-load failure starts with no rows anyway; record the error so the
    // settings UI shows it instead of a silent empty state.
    setState({ rows: [], error: result.message });
    return;
  }
  setState({ rows: result, error: null });
}

export const manualRowsAtom = atom(
  (get) => get(stateAtom).rows,
  (get, set, next: readonly ManualRow[]) => {
    set(stateAtom, { ...get(stateAtom), rows: next });
  },
);

export const manualRowsErrorAtom = atom(
  (get) => get(stateAtom).error,
  (get, set, next: string | null) => {
    set(stateAtom, { ...get(stateAtom), error: next });
  },
);

export const refetchManualRowsAtom = atom(null, async (get, set) => {
  const result = await listManualRows().catch(
    (err: unknown): Failure => failure(describeError("行の取得に失敗", err)),
  );
  const prev = get(stateAtom);
  if (isFailure(result)) {
    // Preserve the existing rows so a transient fetch failure doesn't make
    // the UI look like everything was deleted.
    set(stateAtom, { rows: prev.rows, error: result.message });
    return;
  }
  set(stateAtom, { rows: result, error: null });
});

export const createManualRowAtom = atom(
  null,
  async (get, set, input: ManualRowInput) => {
    const result = await createManualRow(input).catch(
      (err: unknown): Failure => failure(describeError("行の追加に失敗", err)),
    );
    const prev = get(stateAtom);
    if (isFailure(result)) {
      console.warn("create_manual_row failed", result.message);
      set(stateAtom, { rows: prev.rows, error: result.message });
      return;
    }
    set(stateAtom, { rows: [...prev.rows, result], error: null });
  },
);

export const updateManualRowAtom = atom(
  null,
  async (get, set, payload: { id: string; input: ManualRowInput }) => {
    const result = await updateManualRow(payload.id, payload.input).catch(
      (err: unknown): Failure => failure(describeError("行の更新に失敗", err)),
    );
    const prev = get(stateAtom);
    if (isFailure(result)) {
      console.warn("update_manual_row failed", result.message);
      set(stateAtom, { rows: prev.rows, error: result.message });
      return;
    }
    set(stateAtom, {
      rows: prev.rows.map((row) => (row.id === result.id ? result : row)),
      error: null,
    });
  },
);

export const deleteManualRowAtom = atom(null, async (get, set, id: string) => {
  const result = await deleteManualRow(id).catch(
    (err: unknown): Failure => failure(describeError("行の削除に失敗", err)),
  );
  const prev = get(stateAtom);
  if (isFailure(result)) {
    console.warn("delete_manual_row failed", result.message);
    set(stateAtom, { rows: prev.rows, error: result.message });
    return;
  }
  set(stateAtom, {
    rows: prev.rows.filter((row) => row.id !== id),
    error: null,
  });
});
