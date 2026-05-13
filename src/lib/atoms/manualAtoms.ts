import { atom } from "jotai";

import {
  createManualRow,
  deleteManualRow,
  listManualRows,
  updateManualRow,
} from "../api";
import type { ManualRow, ManualRowInput } from "../types";

export const manualRowsAtom = atom<readonly ManualRow[]>([]);

/**
 * Last command-level failure (if any) for the manual provider. The settings
 * panel reads this so a sqlite/IPC failure doesn't silently swallow the
 * user's edit. Cleared on the next successful CRUD.
 */
export const manualRowsErrorAtom = atom<string | null>(null);

type Lifecycle = { cancelled: boolean };

manualRowsAtom.onMount = (set) => {
  const lifecycle: Lifecycle = { cancelled: false };
  void bootstrap(set, lifecycle);
  return () => {
    lifecycle.cancelled = true;
  };
};

async function bootstrap(
  set: (next: readonly ManualRow[]) => void,
  lifecycle: Lifecycle,
): Promise<void> {
  const rows = await listManualRows().catch((err: unknown) => {
    console.warn("list_manual_rows failed", err);
    return [] as ManualRow[];
  });
  if (!lifecycle.cancelled) set(rows);
}

async function refetch(
  set: (next: readonly ManualRow[]) => void,
): Promise<void> {
  const rows = await listManualRows().catch((err: unknown) => {
    console.warn("list_manual_rows failed", err);
    return [] as ManualRow[];
  });
  set(rows);
}

export const refetchManualRowsAtom = atom(null, async (_get, set) => {
  await refetch((rows) => {
    set(manualRowsAtom, rows);
  });
});

function describeError(action: string, err: unknown): string {
  if (typeof err === "string") return `${action}: ${err}`;
  if (err instanceof Error) return `${action}: ${err.message}`;
  return `${action} failed`;
}

const FAILURE_MARKER = Symbol("manual-row-failure");
type Failure = { readonly [FAILURE_MARKER]: true; message: string };
const failure = (message: string): Failure => ({
  [FAILURE_MARKER]: true,
  message,
});
const isFailure = (value: unknown): value is Failure =>
  typeof value === "object" && value !== null && FAILURE_MARKER in value;

export const createManualRowAtom = atom(
  null,
  async (_get, set, input: ManualRowInput) => {
    const result = await createManualRow(input).catch(
      (err: unknown): Failure => failure(describeError("行の追加に失敗", err)),
    );
    if (isFailure(result)) {
      set(manualRowsErrorAtom, result.message);
      console.warn("create_manual_row failed", result.message);
      return;
    }
    set(manualRowsAtom, (prev) => [...prev, result]);
    set(manualRowsErrorAtom, null);
  },
);

export const updateManualRowAtom = atom(
  null,
  async (_get, set, payload: { id: string; input: ManualRowInput }) => {
    const result = await updateManualRow(payload.id, payload.input).catch(
      (err: unknown): Failure => failure(describeError("行の更新に失敗", err)),
    );
    if (isFailure(result)) {
      set(manualRowsErrorAtom, result.message);
      console.warn("update_manual_row failed", result.message);
      return;
    }
    set(manualRowsAtom, (prev) =>
      prev.map((row) => (row.id === result.id ? result : row)),
    );
    set(manualRowsErrorAtom, null);
  },
);

export const deleteManualRowAtom = atom(null, async (_get, set, id: string) => {
  const result = await deleteManualRow(id).catch(
    (err: unknown): Failure => failure(describeError("行の削除に失敗", err)),
  );
  if (isFailure(result)) {
    set(manualRowsErrorAtom, result.message);
    console.warn("delete_manual_row failed", result.message);
    return;
  }
  set(manualRowsAtom, (prev) => prev.filter((row) => row.id !== id));
  set(manualRowsErrorAtom, null);
});
