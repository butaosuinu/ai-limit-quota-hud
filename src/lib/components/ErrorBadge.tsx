import type { Confidence, SnapshotStatus, UsageSource } from "../types";

type Props = {
  status: SnapshotStatus;
  confidence?: Confidence;
  source?: UsageSource;
  message?: string | null;
};

const STATUS_LABEL: Record<SnapshotStatus, string | null> = {
  ok: null,
  warning: "warn",
  critical: "crit",
  "no-data": "no data",
  error: "err",
};

const SOURCE_LABEL: Record<UsageSource, string> = {
  unavailable: "n/a",
  "webview-scrape": "webview",
};

function shouldShowConfidence(confidence: Confidence | undefined): boolean {
  return confidence === "low";
}

function shouldShowSource(source: UsageSource | undefined): boolean {
  return source !== undefined;
}

export function ErrorBadge({ status, confidence, source, message }: Props) {
  const statusLabel = STATUS_LABEL[status];
  const tooltip = message ?? undefined;
  const showStatusBadge = statusLabel !== null;
  const showConfidence = shouldShowConfidence(confidence);
  const showSource = shouldShowSource(source);

  if (!showStatusBadge && !showConfidence && !showSource) return null;

  return (
    <span className="error-badge-group" title={tooltip}>
      {showStatusBadge && (
        <span
          className={`error-badge error-badge--${status}`}
          data-testid={`error-badge-${status}`}
        >
          {statusLabel}
        </span>
      )}
      {showConfidence && confidence !== undefined && (
        <span
          className={`error-badge error-badge--confidence error-badge--confidence-${confidence}`}
          data-testid={`error-badge-confidence-${confidence}`}
        >
          {confidence}
        </span>
      )}
      {showSource && source !== undefined && (
        <span
          className={`error-badge error-badge--source error-badge--source-${source}`}
          data-testid={`error-badge-source-${source}`}
        >
          {SOURCE_LABEL[source]}
        </span>
      )}
    </span>
  );
}
