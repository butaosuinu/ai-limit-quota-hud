import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "jotai";

import { App } from "./App";
import "./app.css";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Root element #root not found in index.html");
}

// Tauri 2 hands the window label down via `__TAURI_INTERNALS__`; pulling it via
// the official helper avoids a synchronous IPC call before render.
async function resolveWindowLabel(): Promise<string> {
  const tauri = await import("@tauri-apps/api/webviewWindow").catch(() => null);
  if (tauri === null) return "overlay";
  return tauri.getCurrentWebviewWindow().label;
}

void (async () => {
  const windowLabel = await resolveWindowLabel().catch(() => "overlay");
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Provider>
        <App windowLabel={windowLabel} />
      </Provider>
    </React.StrictMode>,
  );
})();
