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

const windowLabel = getCurrentWebviewWindow().label;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <Provider>
      <App windowLabel={windowLabel} />
    </Provider>
  </React.StrictMode>,
);
