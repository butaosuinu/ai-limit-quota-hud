import { useState } from "react";
import { useAtomValue } from "jotai";

import { refreshNow } from "../api";
import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { groupedSnapshotsAtom, snapshotsAtom } from "../atoms/usageAtoms";
import { ResetIcon } from "./icons";
import { UsageRow } from "./UsageRow";

export function Overlay() {
  const settings = useAtomValue(overlaySettingsAtom);
  const groups = useAtomValue(groupedSnapshotsAtom);
  const rowCount = useAtomValue(snapshotsAtom).length;
  const [busy, setBusy] = useState(false);
  const dragProps = settings.locked ? {} : { "data-tauri-drag-region": true };
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

  return (
    <main
      {...dragProps}
      className={className}
      data-testid="overlay-root"
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
