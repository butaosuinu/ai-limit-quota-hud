import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "jotai";

import { App } from "./App";

function renderApp(windowLabel: "overlay" | "settings") {
  return render(
    <Provider>
      <App windowLabel={windowLabel} />
    </Provider>,
  );
}

describe("App", () => {
  it("renders the overlay window with the empty-state placeholder before snapshots arrive", () => {
    renderApp("overlay");
    expect(screen.getByTestId("overlay-root")).toBeTruthy();
    expect(screen.getByTestId("overlay-empty")).toBeTruthy();
  });

  it("renders the settings panel for the settings window", () => {
    renderApp("settings");
    expect(screen.getByTestId("settings-root")).toBeTruthy();
    expect(screen.getByText(/QuotaHUD Settings/u)).toBeTruthy();
  });
});
