import { useId } from "react";

type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  id?: string;
  testId?: string;
  disabled?: boolean;
};

/**
 * Pill-shaped toggle. The `<input type=checkbox>` is visually hidden but
 * still drives keyboard focus, ARIA state, and label association.
 */
export function ToggleSwitch({
  checked,
  onChange,
  label,
  id,
  testId,
  disabled = false,
}: Props) {
  const reactId = useId();
  const inputId = id ?? reactId;
  return (
    <label className="toggle" htmlFor={inputId}>
      <input
        id={inputId}
        type="checkbox"
        className="toggle__input"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        onChange={(event) => {
          onChange(event.currentTarget.checked);
        }}
      />
      <span className="toggle__track">
        <span className="toggle__thumb" />
      </span>
    </label>
  );
}
