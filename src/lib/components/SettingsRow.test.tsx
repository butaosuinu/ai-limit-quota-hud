import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { SettingsRow } from "./SettingsRow";

describe("SettingsRow", () => {
  it("usesBareRowClassWhenNoDescriptionOrHelp", () => {
    const { container } = render(<SettingsRow icon={<i />} title="T" />);
    const li = container.querySelector("li");
    expect(li?.className).toBe("row");
  });

  it("appliesWithDescModifierWhenOnlyDescriptionProvided", () => {
    const { container } = render(
      <SettingsRow icon={<i />} title="T" description="desc" />,
    );
    const li = container.querySelector("li");
    expect(li?.className).toBe("row row--with-desc");
    expect(screen.getByText("desc")).toBeTruthy();
  });

  it("appliesWithDescModifierWhenOnlyHelpProvided", () => {
    const { container } = render(
      <SettingsRow icon={<i />} title="T" help="help-text" />,
    );
    const li = container.querySelector("li");
    expect(li?.className).toBe("row row--with-desc");
    expect(screen.getByText("help-text")).toBeTruthy();
  });

  it("omitsDescriptionElementWhenUndefined", () => {
    const { container } = render(<SettingsRow icon={<i />} title="T" />);
    expect(container.querySelector(".row__description")).toBeNull();
  });

  it("omitsHelpElementWhenUndefined", () => {
    const { container } = render(<SettingsRow icon={<i />} title="T" />);
    expect(container.querySelector(".row__help")).toBeNull();
  });

  it("omitsAccessoryWhenUndefined", () => {
    const { container } = render(<SettingsRow icon={<i />} title="T" />);
    expect(container.querySelector(".row__accessory")).toBeNull();
  });

  it("rendersAccessoryWhenProvided", () => {
    render(
      <SettingsRow
        icon={<i />}
        title="T"
        accessory={<span data-testid="acc" />}
      />,
    );
    expect(screen.getByTestId("acc")).toBeTruthy();
  });

  it("omitsActionsWhenUndefined", () => {
    const { container } = render(<SettingsRow icon={<i />} title="T" />);
    expect(container.querySelector(".row__actions")).toBeNull();
  });

  it("rendersActionsWhenProvided", () => {
    render(
      <SettingsRow
        icon={<i />}
        title="T"
        actions={<button data-testid="act">x</button>}
      />,
    );
    expect(screen.getByTestId("act")).toBeTruthy();
  });

  it("rendersTitleText", () => {
    render(<SettingsRow icon={<i />} title="My Setting" />);
    expect(screen.getByText("My Setting")).toBeTruthy();
  });

  it("propagatesTestIdToListItem", () => {
    render(<SettingsRow icon={<i />} title="T" testId="x" />);
    expect(screen.getByTestId("x")).toBeTruthy();
  });
});
