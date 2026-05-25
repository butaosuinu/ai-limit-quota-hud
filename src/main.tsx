import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "jotai";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { App } from "./App";
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

// Lingui runtime (`@lingui/*`, `./lib/i18n`) is dynamic-imported only for the
// settings window so the overlay startup path keeps zero i18n overhead.
async function bootstrap(): Promise<void> {
  if (windowLabel !== "settings") {
    root.render(
      <React.StrictMode>
        <Provider>
          <App windowLabel={windowLabel} />
        </Provider>
      </React.StrictMode>,
    );
    return;
  }

  const [{ I18nProvider }, { activateLocale, detectLocale, i18n }] =
    await Promise.all([import("@lingui/react"), import("./lib/i18n")]);
  await activateLocale({ locale: detectLocale() });
  root.render(
    <React.StrictMode>
      <Provider>
        <I18nProvider i18n={i18n}>
          <App windowLabel={windowLabel} />
        </I18nProvider>
      </Provider>
    </React.StrictMode>,
  );
}

void bootstrap();
