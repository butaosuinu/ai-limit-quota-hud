import { useAtomValue } from "jotai";

import { resetCountdownAtomFamily } from "../atoms/usageAtoms";
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
  return "—";
}

export function UsageRow({ snapshot, compact }: Props) {
  const reset = useAtomValue(resetCountdownAtomFamily(snapshot.providerId));
  const detail = formatDetail(snapshot);
  return (
    <li
      className={`overlay__row overlay__row--${snapshot.status}`}
      data-testid={`usage-row-${snapshot.providerId}`}
    >
      <span className="overlay__row-label">{snapshot.accountLabel}</span>
      <span className="overlay__row-detail">{detail}</span>
      {!compact && <span className="overlay__row-reset">reset {reset}</span>}
      <ErrorBadge
        status={snapshot.status}
        confidence={snapshot.confidence}
        source={snapshot.source}
        message={snapshot.message}
      />
    </li>
  );
}
