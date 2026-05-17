/**
 * TypeScript mirrors of the Rust `OverlaySettings` / `Position` /
 * `UsageSnapshot` types. The serde rename rules on the Rust side keep these
 * in camelCase / kebab-case.
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

/**
 * macOS only — controls whether the menu bar (NSStatusItem) renders a
 * short summary string next to the tray icon. Other OSes ignore this.
 */
export const MENU_BAR_SUMMARY_MODES = ["off", "always", "when-hidden"] as const;

export type MenuBarSummaryMode = (typeof MENU_BAR_SUMMARY_MODES)[number];

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
  menuBarSummary: MenuBarSummaryMode;
  checkUpdatesOnStartup: boolean;
};

export type SnapshotStatus =
  | "ok"
  | "warning"
  | "critical"
  | "no-data"
  | "error";

export type ProviderKind = "webview-claude-ai" | "webview-chatgpt-codex";

export type UsageMetric =
  | "requests"
  | "tokens"
  | "input-tokens"
  | "output-tokens"
  | "messages"
  | "percent"
  | "unknown";

export type UsageSource = "unavailable" | "webview-scrape";

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

/** Per-provider opt-in / enable state (PROJECT_SPEC §8, §10.2). */
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

export const UPDATER_STATUS_EVENT = "updater://status";

export type SettingsChangedPayload = {
  settings: OverlaySettings;
};

/** Mirrors `UpdateStatusPayload` on the Rust side (camelCase + status tag). */
export type UpdateStatusPayload =
  | { status: "checking" }
  | { status: "noUpdate" }
  | { status: "available"; version: string; notes: string }
  | { status: "error"; message: string };

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
  menuBarSummary: "off",
  checkUpdatesOnStartup: true,
};
