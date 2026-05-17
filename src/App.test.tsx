import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Provider } from "jotai";

import { App } from "./App";
import { withI18n } from "./test/i18nTestUtils";

function renderApp(windowLabel: "overlay" | "settings") {
  const tree = <App windowLabel={windowLabel} />;
  return render(
    <Provider>{windowLabel === "settings" ? withI18n(tree) : tree}</Provider>,
  );
}

describe("App", () => {
  it("renders the overlay window with the empty-state placeholder before snapshots arrive", () => {
    renderApp("overlay");
    expect(screen.getByTestId("overlay-root")).toBeTruthy();
    expect(screen.getByTestId("overlay-empty")).toBeTruthy();
  });

  it("renders the settings panel for the settings window", async () => {
    renderApp("settings");
    // Lazy + dual dynamic import can exceed the 1s default on cold CI runners.
    expect(
      await screen.findByTestId("settings-root", undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText(/QuotaHUD Settings/u)).toBeTruthy();
  });
});
