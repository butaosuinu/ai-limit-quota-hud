import type { SampleRow } from "../types";
import { ErrorBadge } from "./ErrorBadge";

type Props = {
  row: SampleRow;
  compact: boolean;
};

export function UsageRow({ row, compact }: Props) {
  return (
    <li
      className={`overlay__row overlay__row--${row.status}`}
      data-testid={`usage-row-${row.id}`}
    >
      <span className="overlay__row-label">{row.label}</span>
      <span className="overlay__row-detail">{row.detail}</span>
      {!compact && (
        <span className="overlay__row-reset">reset {row.reset}</span>
      )}
      <ErrorBadge status={row.status} />
    </li>
  );
}
