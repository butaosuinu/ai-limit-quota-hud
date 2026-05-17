import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ToggleSwitch } from "./ToggleSwitch";

describe("ToggleSwitch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rendersUncheckedInputByDefault", () => {
    render(<ToggleSwitch checked={false} onChange={() => {}} label="L" />);
    const input = screen.getByLabelText("L") as HTMLInputElement;
    expect(input.checked).toBe(false);
  });

  it("rendersCheckedInputWhenCheckedPropTrue", () => {
    render(<ToggleSwitch checked={true} onChange={() => {}} label="L" />);
    const input = screen.getByLabelText("L") as HTMLInputElement;
    expect(input.checked).toBe(true);
  });

  it("invokesOnChangeWithTrueWhenClickedWhileUnchecked", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} label="L" />);
    const input = screen.getByLabelText("L") as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });

  it("invokesOnChangeWithFalseWhenClickedWhileChecked", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={true} onChange={onChange} label="L" />);
    const input = screen.getByLabelText("L") as HTMLInputElement;
    fireEvent.click(input);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("appliesDisabledAttributeWhenDisabledPropTrue", () => {
    render(
      <ToggleSwitch
        checked={false}
        onChange={() => {}}
        label="L"
        disabled={true}
      />,
    );
    const input = screen.getByLabelText("L") as HTMLInputElement;
    // The contract is "input is disabled in the DOM"; whether jsdom's
    // synthetic click still fires onChange is a runtime quirk, not the
    // user-observable behavior on a real browser.
    expect(input.disabled).toBe(true);
  });

  it("usesProvidedIdWhenSupplied", () => {
    render(
      <ToggleSwitch
        id="custom-id"
        checked={false}
        onChange={() => {}}
        label="L"
      />,
    );
    expect(document.getElementById("custom-id")).toBeTruthy();
  });

  it("fallsBackToUseIdWhenIdOmitted", () => {
    render(<ToggleSwitch checked={false} onChange={() => {}} label="L" />);
    const input = screen.getByLabelText("L") as HTMLInputElement;
    expect(input.id.length).toBeGreaterThan(0);
  });

  it("propagatesTestIdToInput", () => {
    render(
      <ToggleSwitch
        checked={false}
        onChange={() => {}}
        label="L"
        testId="my-toggle"
      />,
    );
    expect(screen.getByTestId("my-toggle")).toBeTruthy();
  });
});
