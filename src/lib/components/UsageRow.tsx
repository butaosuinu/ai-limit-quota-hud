import { memo } from "react";
import { useAtomValue } from "jotai";

import { formatResetCountdown, nowAtom } from "../atoms/usageAtoms";
import type { UsageMetric, UsageSnapshot } from "../types";
import { ErrorBadge } from "./ErrorBadge";

type Props = {
  snapshot: UsageSnapshot;
  compact: boolean;
};

const METRIC_SHORT: Record<UsageMetric, string> = {
  requests: "req",
  tokens: "tok",
  "input-tokens": "in tok",
  "output-tokens": "out tok",
  messages: "msg",
  percent: "%",
  unknown: "",
};

const PERCENT_BASE = 100;

function clampPercent(value: number): number {
  return Math.min(PERCENT_BASE, Math.max(0, value));
}

function formatDetail(snapshot: UsageSnapshot): string {
  if (snapshot.remainingPercent !== null) {
    return `${Math.round(snapshot.remainingPercent).toString()}%`;
  }
  if (snapshot.remaining !== null) {
    const unit = METRIC_SHORT[snapshot.metric];
    return unit === ""
      ? snapshot.remaining.toString()
      : `${snapshot.remaining.toString()} ${unit}`;
  }
  if (snapshot.limit !== null && snapshot.used !== null && snapshot.limit > 0) {
    const remaining = Math.max(0, snapshot.limit - snapshot.used);
    const percent = Math.round((remaining / snapshot.limit) * PERCENT_BASE);
    return `${percent.toString()}%`;
  }
  // No limit / remaining derivable — fall back to raw cumulative usage so
  // count-only estimates stay visible.
  if (snapshot.used !== null) {
    const unit = METRIC_SHORT[snapshot.metric];
    return unit === ""
      ? snapshot.used.toString()
      : `${snapshot.used.toString()} ${unit}`;
  }
  return "—";
}

function barPercent(snapshot: UsageSnapshot): number | null {
  if (snapshot.status === "no-data" || snapshot.status === "error") {
    return null;
  }
  if (snapshot.remainingPercent !== null) {
    return clampPercent(snapshot.remainingPercent);
  }
  if (snapshot.limit !== null && snapshot.used !== null && snapshot.limit > 0) {
    const remaining = Math.max(0, snapshot.limit - snapshot.used);
    return clampPercent((remaining / snapshot.limit) * PERCENT_BASE);
  }
  return null;
}

const UsageBar = memo(function UsageBar({
  percent,
}: {
  percent: number | null;
}) {
  return (
    <div className="overlay__bar" data-testid="usage-bar" aria-hidden="true">
      {percent !== null && (
        <div
          className="overlay__bar-fill"
          data-testid="usage-bar-fill"
          style={{ width: `${percent.toString()}%` }}
        />
      )}
    </div>
  );
});

export function UsageRow({ snapshot, compact }: Props) {
  const now = useAtomValue(nowAtom);
  const reset = formatResetCountdown(snapshot.resetAt, now);
  const detail = formatDetail(snapshot);
  const percent = barPercent(snapshot);
  return (
    <li
      className={`overlay__row overlay__row--${snapshot.status}`}
      data-testid={`usage-row-${snapshot.providerId}`}
    >
      <span className="overlay__row-label">{snapshot.accountLabel}</span>
      <span className="overlay__row-detail">{detail}</span>
      {!compact && <span className="overlay__row-reset">reset {reset}</span>}
      <ErrorBadge status={snapshot.status} message={snapshot.message} />
      <UsageBar percent={percent} />
    </li>
  );
}
