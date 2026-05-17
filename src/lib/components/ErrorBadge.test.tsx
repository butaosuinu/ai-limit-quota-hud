import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ErrorBadge } from "./ErrorBadge";

describe("ErrorBadge", () => {
  it("renders nothing when status is ok", () => {
    const { container } = render(<ErrorBadge status="ok" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the status badge for warning rows", () => {
    render(<ErrorBadge status="warning" />);
    expect(screen.getByTestId("error-badge-warning")).toBeTruthy();
    expect(screen.getByText("warn")).toBeTruthy();
  });

  it("renders no-data badge with message tooltip", () => {
    const { container } = render(
      <ErrorBadge status="no-data" message="no data yet" />,
    );
    expect(screen.getByTestId("error-badge-no-data")).toBeTruthy();
    expect(
      container.querySelector(".error-badge-group")?.getAttribute("title"),
    ).toBe("no data yet");
  });

  it("does not render confidence or source pills", () => {
    render(<ErrorBadge status="ok" />);
    expect(screen.queryByTestId("error-badge-confidence-low")).toBeNull();
    expect(
      screen.queryByTestId("error-badge-source-webview-scrape"),
    ).toBeNull();
  });
});
