import { Suspense, lazy } from "react";

import { Overlay } from "./lib/components/Overlay";

// Lazy-loaded so the overlay window doesn't pull in `@lingui/*` or the
// settings UI tree at startup. Vite splits this into its own chunk.
const SettingsPanel = lazy(async () => {
  const mod = await import("./lib/components/SettingsPanel");
  return { default: mod.SettingsPanel };
});

type Props = {
  windowLabel: string;
};

export function App({ windowLabel }: Props) {
  if (windowLabel === "settings") {
    return (
      <Suspense fallback={undefined}>
        <SettingsPanel />
      </Suspense>
    );
  }
  return <Overlay />;
}
