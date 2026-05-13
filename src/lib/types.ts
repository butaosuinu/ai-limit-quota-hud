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

/** Phase 1 row shape. Replaced by the real `UsageSnapshot` in Phase 2. */
export type SampleRow = {
  id: string;
  label: string;
  detail: string;
  reset: string;
  status: SnapshotStatus;
};

export const SAMPLE_ROWS: readonly SampleRow[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: "74%",
    reset: "2:14",
    status: "ok",
  },
  {
    id: "anthropic-api",
    label: "Anthropic API",
    detail: "812k tok",
    reset: "0:37",
    status: "ok",
  },
  {
    id: "openai-api",
    label: "OpenAI API",
    detail: "59 req",
    reset: "0:01",
    status: "warning",
  },
  {
    id: "codex",
    label: "Codex",
    detail: "—",
    reset: "—",
    status: "no-data",
  },
];

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
