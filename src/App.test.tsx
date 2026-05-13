import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "jotai";

import { App } from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() =>
    Promise.resolve({
      opacity: 0.72,
      compact: false,
      clickThrough: false,
      locked: true,
      visible: true,
      alwaysOnTop: true,
      corner: "top-right",
      marginX: 24,
      marginY: 24,
      position: null,
    }),
  ),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

function renderApp(windowLabel: "overlay" | "settings") {
  return render(
    <Provider>
      <App windowLabel={windowLabel} />
    </Provider>,
  );
}

describe("App", () => {
  it("renders the overlay window with sample rows by default", () => {
    renderApp("overlay");
    expect(screen.getByTestId("overlay-root")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Anthropic API")).toBeTruthy();
    expect(screen.getByText("OpenAI API")).toBeTruthy();
  });

  it("renders the settings panel for the settings window", () => {
    renderApp("settings");
    expect(screen.getByTestId("settings-root")).toBeTruthy();
    expect(screen.getByText(/QuotaHUD Settings/u)).toBeTruthy();
  });
});
