import type { SnapshotStatus } from "../types";

type Props = {
  status: SnapshotStatus;
};

const STATUS_LABEL: Record<SnapshotStatus, string | null> = {
  ok: null,
  warning: "warn",
  critical: "crit",
  "no-data": "no data",
  error: "err",
};

export function ErrorBadge({ status }: Props) {
  const label = STATUS_LABEL[status];
  if (label === null) return null;
  return (
    <span
      className={`error-badge error-badge--${status}`}
      data-testid={`error-badge-${status}`}
    >
      {label}
    </span>
  );
}
