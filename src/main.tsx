import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "jotai";
import { I18nProvider } from "@lingui/react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { App } from "./App";
import { activateLocale, detectLocale, i18n } from "./lib/i18n";
import "./app.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found in index.html");
}
const root = ReactDOM.createRoot(rootElement);

// `getCurrentWebviewWindow()` throws outside a Tauri runtime (plain
// `pnpm dev` in a browser). Fall back to the overlay layout in that case so
// the web dev server still works for component-level iteration.
function resolveWindowLabel(): string {
  if (typeof window === "undefined") return "overlay";
  if (!("__TAURI_INTERNALS__" in window)) return "overlay";
  return getCurrentWebviewWindow().label;
}

const windowLabel = resolveWindowLabel();

// Only the settings window is localized; the overlay stays English-only per
// project requirements and skips the Lingui runtime entirely.
async function bootstrap(): Promise<void> {
  if (windowLabel === "settings") {
    await activateLocale(detectLocale());
  }
  root.render(
    <React.StrictMode>
      <Provider>
        {windowLabel === "settings" ? (
          <I18nProvider i18n={i18n}>
            <App windowLabel={windowLabel} />
          </I18nProvider>
        ) : (
          <App windowLabel={windowLabel} />
        )}
      </Provider>
    </React.StrictMode>,
  );
}

void bootstrap();
