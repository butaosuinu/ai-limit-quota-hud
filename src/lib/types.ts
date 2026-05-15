/**
 * TypeScript mirrors of the Rust `OverlaySettings` / `Position` types.
 * The serde rename rules on the Rust side keep these in camelCase / kebab-case.
 */

export type OverlayCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type Position = {
  x: number;
  y: number;
};

export type OverlaySettings = {
  opacity: number;
  compact: boolean;
  clickThrough: boolean;
  locked: boolean;
  visible: boolean;
  alwaysOnTop: boolean;
  corner: OverlayCorner;
  marginX: number;
  marginY: number;
  position: Position | null;
};

export type SnapshotStatus =
  | "ok"
  | "warning"
  | "critical"
  | "no-data"
  | "error";

export type ProviderKind =
  | "open-ai-api"
  | "anthropic-api"
  | "claude-code-local"
  | "codex-local"
  | "manual"
  | "webview-claude-ai"
  | "webview-chatgpt-codex";

/** Set of provider kinds backed by an embedded WebView (PROJECT_SPEC §8.7). */
export const WEBVIEW_PROVIDER_KINDS: readonly ProviderKind[] = [
  "webview-claude-ai",
  "webview-chatgpt-codex",
];

export function isWebviewProviderKind(
  kind: ProviderKind,
): kind is "webview-claude-ai" | "webview-chatgpt-codex" {
  return kind === "webview-claude-ai" || kind === "webview-chatgpt-codex";
}

export type UsageMetric =
  | "requests"
  | "tokens"
  | "input-tokens"
  | "output-tokens"
  | "messages"
  | "percent"
  | "unknown";

export type UsageSource =
  | "official-api"
  | "response-header"
  | "local-log"
  | "manual"
  | "estimate"
  | "unavailable"
  | "webview-scrape";

export type Confidence = "high" | "medium" | "low";

export type UsageWindow =
  | "one-minute"
  | "five-hours"
  | "daily"
  | "weekly"
  | "monthly"
  | "api"
  | "unknown";

export type UsageSnapshot = {
  providerId: string;
  providerKind: ProviderKind;
  accountLabel: string;
  window: UsageWindow;
  metric: UsageMetric;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  remainingPercent: number | null;
  resetAt: string | null;
  observedAt: string;
  source: UsageSource;
  confidence: Confidence;
  status: SnapshotStatus;
  message: string | null;
};

export type ManualRow = {
  id: string;
  providerLabel: string;
  accountLabel: string;
  window: UsageWindow;
  metric: UsageMetric;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ManualRowInput = {
  providerLabel: string;
  accountLabel: string;
  window: UsageWindow;
  metric: UsageMetric;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
  note: string | null;
};

/** Per-provider opt-in / enable state (PROJECT_SPEC §8.7, §10.2). */
export type ProviderSettings = {
  /**
   * Map of provider id (e.g. `"webview-claude-ai"`) to its enable flag.
   * Missing keys default to disabled on the Rust side.
   */
  enabled: Record<string, boolean>;
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  enabled: {},
};

export const USAGE_UPDATED_EVENT = "usage://updated";

export const OVERLAY_SETTINGS_CHANGED_EVENT = "overlay://settings-changed";

export type SettingsChangedPayload = {
  settings: OverlaySettings;
};

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  opacity: 0.72,
  compact: false,
  clickThrough: false,
  locked: true,
  visible: true,
  alwaysOnTop: true,
  corner: "top-right",
  marginX: 24,
  marginY: 24,
  position: null,
};
