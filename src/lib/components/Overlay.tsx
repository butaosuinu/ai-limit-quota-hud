import { useAtomValue } from "jotai";

import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { SAMPLE_ROWS } from "../types";
import { UsageRow } from "./UsageRow";

export function Overlay() {
  const settings = useAtomValue(overlaySettingsAtom);
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
        {SAMPLE_ROWS.map((row) => (
          <UsageRow key={row.id} row={row} compact={settings.compact} />
        ))}
      </ul>
      <footer className="overlay__footer">
        phase 1 · sample data ·{" "}
        {settings.clickThrough ? "click-through on" : "click-through off"}
        {settings.locked ? " · locked" : " · drag to move"}
      </footer>
    </main>
  );
}
