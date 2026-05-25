import { listen } from "@tauri-apps/api/event";
import { vi } from "vitest";

type Handler = (event: { payload: unknown }) => void;

type EventBusController = {
  emit: (name: string, payload: unknown) => void;
  failNext: (err?: unknown) => void;
  reset: () => void;
};

type PendingFailure = { error: unknown };

/**
 * Wires up `listen` so each registered callback is captured per-event.
 * Tests drive the boundary with `emit(name, payload)` and observe DOM / atom
 * state afterwards.
 */
export function setupListen(): EventBusController {
  const handlers = new Map<string, Handler[]>();
  let pendingFailure: PendingFailure | undefined = undefined;

  const mocked = vi.mocked(listen);
  mocked.mockReset();
  // Tauri's `listen` overload is heavily generic; cast through `unknown` to
  // attach a Handler-shaped implementation without dragging Event<T> in.
  (
    mocked as unknown as { mockImplementation: (impl: unknown) => void }
  ).mockImplementation(async (eventName: string, cb: Handler) => {
    if (pendingFailure !== undefined) {
      const { error } = pendingFailure;
      pendingFailure = undefined;
      throw error;
    }
    const arr = handlers.get(eventName) ?? [];
    arr.push(cb);
    handlers.set(eventName, arr);
    return () => {
      const current = handlers.get(eventName) ?? [];
      handlers.set(
        eventName,
        current.filter((h) => h !== cb),
      );
    };
  });

  return {
    emit(name, payload) {
      const arr = handlers.get(name) ?? [];
      for (const cb of arr) {
        cb({ payload });
      }
    },
    failNext(err = new Error("listen rejected")) {
      pendingFailure = { error: err };
    },
    reset() {
      handlers.clear();
      pendingFailure = undefined;
    },
  };
}

export function resetListen(): void {
  vi.mocked(listen).mockReset();
}
