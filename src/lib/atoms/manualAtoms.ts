import { atom } from "jotai";

import {
  createManualRow,
  deleteManualRow,
  listManualRows,
  updateManualRow,
} from "../api";
import type { ManualRow, ManualRowInput } from "../types";

export const manualRowsAtom = atom<readonly ManualRow[]>([]);

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

export const createManualRowAtom = atom(
  null,
  async (_get, set, input: ManualRowInput) => {
    await createManualRow(input).catch((err: unknown) => {
      console.warn("create_manual_row failed", err);
      return null;
    });
    await refetch((rows) => {
      set(manualRowsAtom, rows);
    });
  },
);

export const updateManualRowAtom = atom(
  null,
  async (_get, set, payload: { id: string; input: ManualRowInput }) => {
    await updateManualRow(payload.id, payload.input).catch((err: unknown) => {
      console.warn("update_manual_row failed", err);
      return null;
    });
    await refetch((rows) => {
      set(manualRowsAtom, rows);
    });
  },
);

export const deleteManualRowAtom = atom(null, async (_get, set, id: string) => {
  await deleteManualRow(id).catch((err: unknown) => {
    console.warn("delete_manual_row failed", err);
    return null;
  });
  await refetch((rows) => {
    set(manualRowsAtom, rows);
  });
});

export const selectedManualRowIdAtom = atom<string | null>(null);
