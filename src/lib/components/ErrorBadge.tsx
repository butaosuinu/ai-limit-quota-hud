import type { SnapshotStatus } from "../types";

type Props = {
  status: SnapshotStatus;
  message?: string;
};

const STATUS_LABEL: Record<SnapshotStatus, string | undefined> = {
  ok: undefined,
  warning: "warn",
  critical: "crit",
  "no-data": "no data",
  error: "err",
};

export function ErrorBadge({ status, message }: Props) {
  const statusLabel = STATUS_LABEL[status];
  if (statusLabel === undefined) return undefined;
  const tooltip = message;
  return (
    <span className="error-badge-group" title={tooltip}>
      <span
        className={`error-badge error-badge--${status}`}
        data-testid={`error-badge-${status}`}
      >
        {statusLabel}
      </span>
    </span>
  );
}
