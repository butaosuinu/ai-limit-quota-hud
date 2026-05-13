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

// `getCurrentWebviewWindow()` throws outside a Tauri runtime (plain
// `pnpm dev` in a browser). Fall back to the overlay layout in that case so
// the web dev server still works for component-level iteration.
function resolveWindowLabel(): string {
  if (typeof window === "undefined") return "overlay";
  if (!("__TAURI_INTERNALS__" in window)) return "overlay";
  return getCurrentWebviewWindow().label;
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Provider>
      <App windowLabel={resolveWindowLabel()} />
    </Provider>
  </React.StrictMode>,
);
