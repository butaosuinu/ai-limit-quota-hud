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
 *
 * `generation` increments on every user-triggered write so a slow bootstrap
 * fetch that resolves after the user has already mutated state can tell that
 * the in-memory state is fresher than the fetched payload. Inferring
 * freshness from `rows.length === 0` is not enough because a user can
 * legitimately create-then-delete down to an empty list while the initial
 * fetch is still in flight.
 */
type ManualRowsState = {
  rows: readonly ManualRow[];
  error: string | null;
  generation: number;
};

const INITIAL_GENERATION = 0;

const stateAtom = atom<ManualRowsState>({
  rows: [],
  error: null,
  generation: INITIAL_GENERATION,
});

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
  setState: (
    next: ManualRowsState | ((prev: ManualRowsState) => ManualRowsState),
  ) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  const result = await listManualRows().catch(
    (err: unknown): Failure => failure(describeError("行の取得に失敗", err)),
  );
  if (lifecycle.cancelled) return;
  if (isFailure(result)) {
    setState((prev) => {
      // A user mutation happened during the fetch. Don't paper over their
      // latest action with the bootstrap-time error; surface it via console
      // and let the next refetch attempt re-surface if still broken.
      if (prev.generation !== INITIAL_GENERATION) return prev;
      return {
        rows: prev.rows,
        error: result.message,
        generation: prev.generation,
      };
    });
    return;
  }
  const fetched: readonly ManualRow[] = Array.isArray(result) ? result : [];
  setState((prev) => {
    if (prev.generation !== INITIAL_GENERATION) return prev;
    return { rows: fetched, error: null, generation: prev.generation };
  });
}

export const manualRowsAtom = atom(
  (get) => get(stateAtom).rows,
  (get, set, next: readonly ManualRow[]) => {
    const prev = get(stateAtom);
    set(stateAtom, { ...prev, rows: next, generation: prev.generation + 1 });
  },
);

export const manualRowsErrorAtom = atom(
  (get) => get(stateAtom).error,
  (get, set, next: string | null) => {
    const prev = get(stateAtom);
    set(stateAtom, { ...prev, error: next, generation: prev.generation + 1 });
  },
);

export const refetchManualRowsAtom = atom(null, async (get, set) => {
  const { generation: sentAtGeneration } = get(stateAtom);
  const result = await listManualRows().catch(
    (err: unknown): Failure => failure(describeError("行の取得に失敗", err)),
  );
  const prev = get(stateAtom);
  if (prev.generation !== sentAtGeneration) {
    // A CRUD mutation landed during the fetch; trust the in-memory state.
    return;
  }
  if (isFailure(result)) {
    // Preserve the existing rows so a transient fetch failure doesn't make
    // the UI look like everything was deleted.
    set(stateAtom, {
      rows: prev.rows,
      error: result.message,
      generation: prev.generation + 1,
    });
    return;
  }
  const fetched: readonly ManualRow[] = Array.isArray(result) ? result : [];
  set(stateAtom, {
    rows: fetched,
    error: null,
    generation: prev.generation + 1,
  });
});

export const createManualRowAtom = atom(
  null,
  async (get, set, input: ManualRowInput): Promise<boolean> => {
    const result = await createManualRow(input).catch(
      (err: unknown): Failure => failure(describeError("行の追加に失敗", err)),
    );
    const prev = get(stateAtom);
    if (isFailure(result)) {
      console.warn("create_manual_row failed", result.message);
      set(stateAtom, {
        rows: prev.rows,
        error: result.message,
        generation: prev.generation + 1,
      });
      return false;
    }
    set(stateAtom, {
      rows: [...prev.rows, result],
      error: null,
      generation: prev.generation + 1,
    });
    return true;
  },
);

export const updateManualRowAtom = atom(
  null,
  async (
    get,
    set,
    payload: { id: string; input: ManualRowInput },
  ): Promise<boolean> => {
    const result = await updateManualRow(payload.id, payload.input).catch(
      (err: unknown): Failure => failure(describeError("行の更新に失敗", err)),
    );
    const prev = get(stateAtom);
    if (isFailure(result)) {
      console.warn("update_manual_row failed", result.message);
      set(stateAtom, {
        rows: prev.rows,
        error: result.message,
        generation: prev.generation + 1,
      });
      return false;
    }
    set(stateAtom, {
      rows: prev.rows.map((row) => (row.id === result.id ? result : row)),
      error: null,
      generation: prev.generation + 1,
    });
    return true;
  },
);

export const deleteManualRowAtom = atom(
  null,
  async (get, set, id: string): Promise<boolean> => {
    const result = await deleteManualRow(id).catch(
      (err: unknown): Failure => failure(describeError("行の削除に失敗", err)),
    );
    const prev = get(stateAtom);
    if (isFailure(result)) {
      console.warn("delete_manual_row failed", result.message);
      set(stateAtom, {
        rows: prev.rows,
        error: result.message,
        generation: prev.generation + 1,
      });
      return false;
    }
    set(stateAtom, {
      rows: prev.rows.filter((row) => row.id !== id),
      error: null,
      generation: prev.generation + 1,
    });
    return true;
  },
);
