import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider, createStore } from "jotai";

import { overlaySettingsAtom } from "../atoms/overlayAtoms";
import { DEFAULT_OVERLAY_SETTINGS } from "../types";
import { Overlay } from "./Overlay";

function renderWithSettings(
  overrides: Partial<typeof DEFAULT_OVERLAY_SETTINGS> = {},
) {
  const store = createStore();
  store.set(overlaySettingsAtom, { ...DEFAULT_OVERLAY_SETTINGS, ...overrides });
  return render(
    <Provider store={store}>
      <Overlay />
    </Provider>,
  );
}

describe("Overlay", () => {
  it("renders the four sample rows with their labels", () => {
    renderWithSettings();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Anthropic API")).toBeTruthy();
    expect(screen.getByText("OpenAI API")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
  });

  it("applies opacity from settings to the root element", () => {
    renderWithSettings({ opacity: 0.5 });
    const root = screen.getByTestId("overlay-root");
    expect(root.style.opacity).toBe("0.5");
  });

  it("adds the drag-region attribute when unlocked", () => {
    renderWithSettings({ locked: false });
    const root = screen.getByTestId("overlay-root");
    expect(root.getAttribute("data-tauri-drag-region")).toBe("true");
  });

  it("omits the drag-region attribute when locked", () => {
    renderWithSettings({ locked: true });
    const root = screen.getByTestId("overlay-root");
    expect(root.hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("hides the reset column in compact mode", () => {
    renderWithSettings({ compact: true });
    expect(screen.queryByText(/reset 2:14/)).toBeNull();
  });

  it("shows the reset column outside compact mode", () => {
    renderWithSettings({ compact: false });
    expect(screen.getByText(/reset 2:14/)).toBeTruthy();
  });

  it("shows an error badge for no-data rows", () => {
    renderWithSettings();
    expect(screen.getByTestId("error-badge-no-data")).toBeTruthy();
  });
});
