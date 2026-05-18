import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useAtomValue } from "jotai";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { refreshNow } from "../api";
import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { groupedSnapshotsAtom, snapshotsAtom } from "../atoms/usageAtoms";
import { ResetIcon } from "./icons";
import { UsageRow } from "./UsageRow";

type DragState = {
  scaleFactor: number;
  startMouseX: number;
  startMouseY: number;
  startWindowX: number;
  startWindowY: number;
};

const INTERACTIVE_DRAG_BLOCKER_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="option"]',
  '[data-tauri-drag-region="false"]',
].join(",");

function isInteractiveDragBlocker(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(INTERACTIVE_DRAG_BLOCKER_SELECTOR) !== null
  );
}

export function Overlay() {
  const settings = useAtomValue(overlaySettingsAtom);
  const groups = useAtomValue(groupedSnapshotsAtom);
  const rowCount = useAtomValue(snapshotsAtom).length;
  const [busy, setBusy] = useState(false);
  const dragState = useRef<DragState | null>(null);
  const dragProps = settings.locked ? {} : { "data-tauri-drag-region": "deep" };
  const className = `overlay${settings.compact ? " overlay--compact" : ""}`;

  const handleRefresh = (): void => {
    if (busy) return;
    setBusy(true);
    refreshNow()
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console -- best-effort observability when the manual refresh invoke fails (e.g. running in plain `pnpm dev` without a Tauri runtime).
        console.warn("refresh_now failed", err);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const startManualDrag = async (
    startMouseX: number,
    startMouseY: number,
  ): Promise<void> => {
    const overlayWindow = getCurrentWebviewWindow();
    const result = await Promise.all([
      overlayWindow.outerPosition(),
      overlayWindow.scaleFactor(),
    ]).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- best-effort observability when manual window drag setup fails.
      console.warn("overlay drag setup failed", err);
      return null;
    });
    if (result === null) return;
    const [position, scaleFactor] = result;
    dragState.current = {
      scaleFactor,
      startMouseX,
      startMouseY,
      startWindowX: position.x,
      startWindowY: position.y,
    };
  };

  const handleDragMouseDown = (event: ReactMouseEvent<HTMLElement>): void => {
    if (
      settings.locked ||
      settings.clickThrough ||
      event.button !== 0 ||
      isInteractiveDragBlocker(event.target)
    ) {
      return;
    }

    event.preventDefault();
    void startManualDrag(event.screenX, event.screenY);
  };

  const handleDragMouseMove = (event: ReactMouseEvent<HTMLElement>): void => {
    const state = dragState.current;
    if (state === null) return;
    const dx = Math.round(
      (event.screenX - state.startMouseX) * state.scaleFactor,
    );
    const dy = Math.round(
      (event.screenY - state.startMouseY) * state.scaleFactor,
    );
    getCurrentWebviewWindow()
      .setPosition(
        new PhysicalPosition(state.startWindowX + dx, state.startWindowY + dy),
      )
      .catch((err: unknown) => {
        // eslint-disable-next-line no-console -- best-effort observability when manual window drag update fails.
        console.warn("overlay drag update failed", err);
      });
  };

  const endManualDrag = (): void => {
    dragState.current = null;
  };

  return (
    <main
      {...dragProps}
      className={className}
      data-testid="overlay-root"
      onMouseDown={handleDragMouseDown}
      onMouseMove={handleDragMouseMove}
      onMouseUp={endManualDrag}
      onMouseLeave={endManualDrag}
      style={{ opacity: settings.opacity }}
    >
      <header className="overlay__title-row">
        <span className="overlay__title">QuotaHUD</span>
        <button
          type="button"
          className="overlay__refresh"
          data-testid="overlay-refresh"
          data-tauri-drag-region={false}
          onClick={handleRefresh}
          disabled={busy}
          aria-busy={busy}
          aria-label="refresh now"
          title="refresh now"
        >
          <ResetIcon />
        </button>
      </header>
      {groups.length === 0 ? (
        <section
          className="overlay__group overlay__group--empty"
          data-testid="overlay-empty"
        >
          <div className="overlay__group-empty-text">
            no providers configured
          </div>
        </section>
      ) : (
        groups.map((group) => (
          <section
            key={group.kind}
            className="overlay__group"
            data-testid={`overlay-group-${group.kind}`}
          >
            <div className="overlay__group-header">{group.label}</div>
            <ul className="overlay__rows">
              {group.snapshots.map((snapshot) => (
                <UsageRow
                  key={snapshot.providerId}
                  snapshot={snapshot}
                  compact={settings.compact}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <footer className="overlay__footer">
        {rowCount} provider row{rowCount === 1 ? "" : "s"} ·{" "}
        {settings.clickThrough ? "click-through on" : "click-through off"}
        {settings.locked ? " · locked" : " · drag to move"}
      </footer>
    </main>
  );
}
