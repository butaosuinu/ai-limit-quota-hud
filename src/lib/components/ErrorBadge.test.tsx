import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ErrorBadge } from "./ErrorBadge";

describe("ErrorBadge", () => {
  it("renders nothing when status is ok and no confidence/source is shown", () => {
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

  it("renders the low-confidence pill", () => {
    render(<ErrorBadge status="ok" confidence="low" />);
    expect(screen.getByTestId("error-badge-confidence-low")).toBeTruthy();
  });

  it("renders the manual source pill", () => {
    render(<ErrorBadge status="ok" source="manual" />);
    expect(screen.getByTestId("error-badge-source-manual")).toBeTruthy();
  });
});
