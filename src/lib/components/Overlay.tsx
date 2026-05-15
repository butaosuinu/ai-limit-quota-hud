import { useAtomValue } from "jotai";

import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { sortedSnapshotsAtom } from "../atoms/usageAtoms";
import { UsageRow } from "./UsageRow";

export function Overlay() {
  const settings = useAtomValue(overlaySettingsAtom);
  const snapshots = useAtomValue(sortedSnapshotsAtom);
  const dragProps = settings.locked ? {} : { "data-tauri-drag-region": true };
  const className = `overlay${settings.compact ? " overlay--compact" : ""}`;
  return (
    <main
      {...dragProps}
      className={className}
      data-testid="overlay-root"
      style={{ opacity: settings.opacity }}
    >
      <header className="overlay__title">QuotaHUD</header>
      <ul className="overlay__rows">
        {snapshots.length === 0 ? (
          <li
            className="overlay__row overlay__row--empty"
            data-testid="overlay-empty"
          >
            no providers configured
          </li>
        ) : (
          snapshots.map((snapshot) => (
            <UsageRow
              key={snapshot.providerId}
              snapshot={snapshot}
              compact={settings.compact}
            />
          ))
        )}
      </ul>
      <footer className="overlay__footer">
        {snapshots.length} provider rows ·{" "}
        {settings.clickThrough ? "click-through on" : "click-through off"}
        {settings.locked ? " · locked" : " · drag to move"}
      </footer>
    </main>
  );
}
