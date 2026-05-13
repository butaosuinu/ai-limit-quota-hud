import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "./App";

describe("App", () => {
  it("renders overlay container with sample provider rows", () => {
    render(<App />);
    expect(screen.getByTestId("overlay-root")).toBeTruthy();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    expect(screen.getByText("Anthropic API")).toBeTruthy();
    expect(screen.getByText("OpenAI API")).toBeTruthy();
  });
});
