# PROJECT_SPEC.md — QuotaHUD

## 1. Product goal

QuotaHUD is a small desktop overlay for tracking remaining usage/rate-limit headroom across AI services such as Claude, Claude Code, Codex/ChatGPT-related tools, OpenAI API, Anthropic API, GitHub Copilot, and future providers.

The first usable version should prioritize a clean, reliable overlay and a provider architecture that can safely support both official API rate-limit data and local best-effort usage estimates.

## 2. Non-goals for v0

Do not start with these:

- Browser-cookie scraping of ChatGPT or Claude subscription pages.
- Password capture or embedded login flows.
- Python-based helpers, Python test runners, Python packaging, or Python sidecars.
- Heavy analytics or telemetry.
- Mobile support.
- A pixel-perfect clone of any existing tool.

## 3. Terminology

Use these terms consistently:

- `usage`: amount consumed in a known window.
- `remaining`: remaining requests/tokens/messages/percent.
- `window`: reset window, such as `1m`, `5h`, `daily`, `weekly`, `monthly`, or `api`.
- `provider`: integration source such as `openai-api`, `anthropic-api`, `claude-code-local`, `codex-local`, `manual`.
- `source`: how the number was obtained: `official-api`, `response-header`, `local-log`, `manual`, `estimate`, `unavailable`.
- `confidence`: `high`, `medium`, or `low`.

## 4. Recommended repository layout

```text
.
├── AGENTS.md
├── CLAUDE.md
├── package.json
├── pnpm-lock.yaml
├── vite.config.ts
├── src/
│   ├── app.css
│   ├── App.tsx
│   ├── main.tsx
│   ├── lib/
│   │   ├── api.ts
│   │   ├── types.ts
│   │   ├── atoms/
│   │   │   ├── settingsAtoms.ts
│   │   │   ├── usageAtoms.ts
│   │   │   └── overlayAtoms.ts
│   │   └── components/
│   │       ├── Overlay.tsx
│   │       ├── UsageRow.tsx
│   │       ├── SettingsPanel.tsx
│   │       └── ErrorBadge.tsx
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── build.rs
│   └── src/
│       ├── main.rs
│       ├── commands.rs
│       ├── state.rs
│       ├── settings.rs
│       ├── storage.rs
│       ├── secrets.rs
│       ├── scheduler.rs
│       ├── overlay.rs
│       ├── model.rs
│       ├── platform/
│       │   ├── mod.rs
│       │   ├── macos.rs
│       │   ├── windows.rs
│       │   └── linux.rs
│       └── providers/
│           ├── mod.rs
│           ├── manual.rs
│           ├── openai_api.rs
│           ├── anthropic_api.rs
│           ├── claude_code_local.rs
│           └── codex_local.rs
├── tests/
│   └── fixtures/
│       ├── claude-code/
│       └── codex/
└── .github/
    └── workflows/
        ├── ci.yml
        └── release.yml
```

## 5. Frontend stack and state management

Use React with TypeScript and Vite. Do not scaffold or migrate to Svelte, Vue, Solid, or another frontend framework unless the human maintainer explicitly changes this spec.

State management rules:

- Use ordinary React local state for local-only component concerns.
- Use Jotai for shared frontend state when needed, especially overlay settings, provider snapshots received from Tauri events, provider configuration form state, selected account/provider, and UI mode flags.
- Keep atoms small, typed, and colocated under `src/lib/atoms/` or `src/state/`.
- Prefer derived atoms for computed display values such as sorted provider rows, warning/critical counts, compact-mode visibility, and reset countdown labels.
- Do not store API keys, cookies, tokens, or other secrets in Jotai atoms. Secrets must remain in the Rust side and OS credential store.
- Avoid Redux, Zustand, Recoil, MobX, XState, or TanStack Query as default dependencies. Add them only with a written justification in the PR/docs.

Recommended frontend dependencies for MVP:

```json
{
  "dependencies": {
    "@tauri-apps/api": "latest",
    "jotai": "latest",
    "react": "latest",
    "react-dom": "latest"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "latest",
    "typescript": "latest",
    "vite": "latest",
    "vitest": "latest"
  }
}
```

## 6. UI/UX requirements

### 6.1 Overlay

The overlay is the primary UI.

Required behavior:

- Transparent or semi-transparent background.
- Small footprint by default, about 280–360 px wide.
- Always on top.
- Optional click-through mode.
- Optional compact mode showing only provider icon/name, remaining percentage, and reset countdown.
- User can choose screen corner and margin.
- User can change opacity.
- User can lock/unlock dragging.
- User can toggle click-through from tray/menu or global shortcut.
- User can hide/show overlay from tray/menu.

Default visual model:

```text
┌ Claude Code        74%   reset 2:14 ┐
│ Anthropic API   812k tok reset 0:37 │
│ OpenAI API       59 req reset 0:01  │
│ Codex             ?    no data yet  │
└ opacity 0.72 / click-through on ─────┘
```

### 6.2 Settings panel

Settings can be a second Tauri window or an overlay-expanded mode.

Minimum settings:

- Providers enabled/disabled.
- Account labels.
- Refresh interval.
- Overlay position.
- Opacity.
- Click-through toggle.
- Compact/full mode.
- Warning threshold, e.g. yellow below 30%, red below 10%.
- Reset all local data.

### 6.3 Status labeling

Every row should show uncertainty honestly:

- `high`: official API/header data.
- `medium`: local log parsing with known token usage fields.
- `low`: local estimate or inferred subscription usage.
- `no data`: provider configured but no reliable snapshot yet.

Do not label estimates as exact remaining tokens.

## 7. Core data model

Use this shape in Rust and mirror it in TypeScript.

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider_id: String,
    pub provider_kind: ProviderKind,
    pub account_label: String,
    pub window: UsageWindow,
    pub metric: UsageMetric,
    pub limit: Option<i64>,
    pub used: Option<i64>,
    pub remaining: Option<i64>,
    pub remaining_percent: Option<f64>,
    pub reset_at: Option<String>,
    pub observed_at: String,
    pub source: UsageSource,
    pub confidence: Confidence,
    pub status: SnapshotStatus,
    pub message: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderKind {
    OpenAiApi,
    AnthropicApi,
    ClaudeCodeLocal,
    CodexLocal,
    Manual,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageMetric {
    Requests,
    Tokens,
    InputTokens,
    OutputTokens,
    Messages,
    Percent,
    Unknown,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageSource {
    OfficialApi,
    ResponseHeader,
    LocalLog,
    Manual,
    Estimate,
    Unavailable,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SnapshotStatus {
    Ok,
    Warning,
    Critical,
    NoData,
    Error,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageWindow {
    OneMinute,
    FiveHours,
    Daily,
    Weekly,
    Monthly,
    Api,
    Unknown,
}
```

TypeScript equivalent:

```ts
export type UsageSnapshot = {
  providerId: string;
  providerKind: 'open-ai-api' | 'anthropic-api' | 'claude-code-local' | 'codex-local' | 'manual';
  accountLabel: string;
  window: 'one-minute' | 'five-hours' | 'daily' | 'weekly' | 'monthly' | 'api' | 'unknown';
  metric: 'requests' | 'tokens' | 'input-tokens' | 'output-tokens' | 'messages' | 'percent' | 'unknown';
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  remainingPercent?: number | null;
  resetAt?: string | null;
  observedAt: string;
  source: 'official-api' | 'response-header' | 'local-log' | 'manual' | 'estimate' | 'unavailable';
  confidence: 'high' | 'medium' | 'low';
  status: 'ok' | 'warning' | 'critical' | 'no-data' | 'error';
  message?: string | null;
};
```

## 8. Provider architecture

Create a provider trait in Rust:

```rust
#[async_trait::async_trait]
pub trait UsageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn kind(&self) -> ProviderKind;
    async fn refresh(&self, ctx: ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>>;
}
```

`ProviderContext` should include:

- App config.
- Credential getter.
- Storage handle.
- Clock abstraction for tests.
- Optional path resolver.

Provider rules:

- Return `NoData` instead of failing globally when only one provider is unavailable.
- Never panic on malformed local files.
- Keep all parsing deterministic and unit tested using fixtures.
- Each provider should have a `README` comment or module doc explaining data source and confidence.

### 8.1 Manual provider — implement first

Purpose: let the app show real UI before complex integrations.

User can create rows manually:

- provider label
- metric
- limit
- remaining or used
- reset time
- confidence defaults to `low`
- source is `manual`

This is useful as a fallback for ChatGPT subscription limits when no reliable API exists.

### 8.2 OpenAI API provider

Data source: API response headers when available.

Track at least:

- `x-ratelimit-limit-requests`
- `x-ratelimit-remaining-requests`
- `x-ratelimit-reset-requests`
- `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-tokens`

Important limitation: an app cannot know another tool's OpenAI API header values unless it observes responses, receives imported log data, or runs a user-approved probe. Do not secretly send requests to consume quota. If no observed headers exist, show `NoData`.

Optional v1 feature: a local proxy mode where users point their OpenAI-compatible tools at `http://127.0.0.1:<port>` and QuotaHUD forwards requests while recording rate-limit headers. This must be opt-in.

### 8.3 Anthropic API provider

Data source: API response headers when available.

Track at least:

- `anthropic-ratelimit-requests-limit`
- `anthropic-ratelimit-requests-remaining`
- `anthropic-ratelimit-requests-reset`
- `anthropic-ratelimit-tokens-limit`
- `anthropic-ratelimit-tokens-remaining`
- `anthropic-ratelimit-tokens-reset`
- `anthropic-ratelimit-input-tokens-limit`
- `anthropic-ratelimit-input-tokens-remaining`
- `anthropic-ratelimit-input-tokens-reset`
- `anthropic-ratelimit-output-tokens-limit`
- `anthropic-ratelimit-output-tokens-remaining`
- `anthropic-ratelimit-output-tokens-reset`

Same limitation as OpenAI: do not spend quota just to refresh unless the user explicitly opts in.

### 8.4 Claude Code local provider

Goal: best-effort local usage from Claude Code project/session files if structured usage data exists on the machine.

Implementation approach:

1. Discover likely Claude Code data directories per OS.
2. Scan only metadata/structured JSONL-like files needed for usage.
3. Parse token usage fields if present.
4. Aggregate into plausible 5-hour and weekly windows only when reset semantics can be inferred reliably.
5. If exact remaining limits are unavailable, show used tokens/messages with `confidence: medium` or `low`, not exact remaining.

Rules:

- Do not require `ccusage` or any external CLI.
- Do not shell out to Python.
- Include fixtures that represent real-looking but sanitized log files.
- If path/format is unknown, return `NoData` with a clear message.

### 8.5 Codex local provider

Goal: best-effort local usage for Codex CLI sessions if structured usage data exists.

Implementation approach:

1. Discover likely Codex config/session directories, usually under the user's home directory.
2. Parse structured session/log files only when the format is clear.
3. Aggregate requests/tokens/messages by model/account/window if reliable.
4. Return `NoData` when no stable local format is found.

Rules:

- Do not depend on Python or shell-specific commands.
- Do not read unrelated files.
- Avoid assumptions about ChatGPT subscription windows unless evidence exists in local data.

### 8.6 Future browser extension bridge

For normal ChatGPT/Claude web subscription usage, a browser extension bridge may be the cleanest path.

Do not implement in v0, but keep architecture ready:

```text
Browser extension -> Native Messaging or localhost websocket -> QuotaHUD provider cache
```

The extension can observe visible usage banners or local send events with user consent. QuotaHUD should treat this as `estimate` unless the data comes from an official usage endpoint.

## 9. Overlay/platform implementation

### 9.1 Tauri window config baseline

Start with one main overlay window and optionally a settings window.

Example `tauri.conf.json` window fields:

```json
{
  "app": {
    "windows": [
      {
        "label": "overlay",
        "title": "QuotaHUD",
        "width": 340,
        "height": 180,
        "decorations": false,
        "transparent": true,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "resizable": false,
        "visible": true,
        "visibleOnAllWorkspaces": true,
        "shadow": false
      },
      {
        "label": "settings",
        "title": "QuotaHUD Settings",
        "width": 720,
        "height": 560,
        "decorations": true,
        "transparent": false,
        "visible": false
      }
    ]
  }
}
```

After startup, call Tauri window APIs or Rust commands to ensure:

- always on top
- ignored cursor events when click-through is enabled
- not focusable where supported
- correct position on selected monitor
- safe fallback if all-workspace behavior is unsupported

### 9.2 macOS

Implement via Tauri first. Add a small platform hook if necessary.

Expected behavior:

- overlay joins all Spaces
- can appear above regular windows
- click-through works
- settings window remains normal

If Tauri settings are insufficient, use AppKit via Rust/Objective-C bindings to adjust the NSWindow:

- collection behavior: join all spaces, full-screen auxiliary, stationary where appropriate
- level: floating or status-like level, not intrusive screen-saver level by default
- non-activating/focus behavior if feasible

Note: transparent windows on macOS may require Tauri's macOS private API flag; because this app is intended for direct binary distribution rather than Mac App Store, that can be acceptable. Document it.

### 9.3 Windows

Tauri's all-workspaces support is limited on Windows. Implement a Windows-specific overlay module.

Minimum Windows behavior:

- topmost overlay
- transparent/semi-transparent UI
- click-through mode using extended window styles
- hide from taskbar
- does not steal focus

Use the Rust `windows` crate if native calls are needed. Likely APIs/styles:

- `SetWindowPos(HWND_TOPMOST, ...)`
- `WS_EX_TOPMOST`
- `WS_EX_LAYERED`
- `WS_EX_TRANSPARENT` for click-through
- `WS_EX_TOOLWINDOW` to avoid taskbar/Alt-Tab noise
- `WS_EX_NOACTIVATE` if compatible

For virtual desktops, create a spike:

1. Test whether Tauri topmost window persists across Windows virtual desktops.
2. If not, implement a safe fallback that detects desktop changes or foreground changes and recreates/repositions the overlay quickly.
3. Do not rely on undocumented COM APIs unless isolated behind a feature flag and documented as experimental.
4. If full all-desktops behavior cannot be made reliable, expose the limitation in settings and docs.

### 9.4 Linux

Implement via Tauri first.

Expected behavior on X11:

- topmost/sticky behavior should be feasible through window manager hints.

Expected behavior on Wayland:

- compositor limitations may prevent global always-on-top or all-workspaces behavior.
- Detect or document degraded behavior.

Do not crash when a compositor refuses topmost or transparent behavior.

## 10. Settings and storage

### 10.1 Settings

Suggested settings structure:

```rust
pub struct AppSettings {
    pub overlay: OverlaySettings,
    pub providers: Vec<ProviderSettings>,
    pub refresh_interval_seconds: u64,
}

pub struct OverlaySettings {
    pub monitor: Option<String>,
    pub corner: OverlayCorner,
    pub margin_x: i32,
    pub margin_y: i32,
    pub opacity: f64,
    pub click_through: bool,
    pub compact: bool,
    pub locked: bool,
}
```

Persist settings in SQLite or a Tauri store file. Secrets must go to OS credential storage, not SQLite.

### 10.2 Secrets

Store these in OS credential storage:

- API keys, if user configures them.
- Proxy credentials, if implemented.
- Any provider tokens.

Never store browser cookies in v0.

## 11. Scheduler

Create a scheduler that refreshes enabled providers and emits `usage://updated` or a normal Tauri event to the frontend.

Rules:

- Default refresh interval: 60 seconds or slower.
- Each provider can set a minimum refresh interval.
- Failed provider refresh should not block other providers.
- Use exponential backoff for repeated failures.
- Avoid refreshing hidden/disabled providers.

## 12. Build and distribution

### 12.1 Local commands

`package.json` should expose:

```json
{
  "scripts": {
    "dev": "vite",
    "tauri": "tauri",
    "lint": "eslint .",
    "test": "vitest run",
    "build": "vite build",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  }
}
```

If you prefer `pnpm tauri dev` and `pnpm tauri build`, keep both aliases working.

### 12.2 CI

Use GitHub Actions matrix:

- `macos-latest`
- `windows-latest`
- `ubuntu-latest`

CI jobs:

1. install Rust stable
2. install pnpm
3. install system dependencies on Linux
4. `pnpm install --frozen-lockfile`
5. `pnpm lint`
6. `pnpm test`
7. `cargo test --manifest-path src-tauri/Cargo.toml`
8. `pnpm tauri build`
9. upload artifacts

### 12.3 Release artifacts

Target artifacts:

- macOS: `.dmg` and/or `.app.tar.gz`; universal binary if feasible.
- Windows: `.msi` and/or `.exe` installer.
- Linux: `.AppImage`, `.deb`, and optionally `.rpm`.

Signing/notarization can be added after MVP:

- macOS Developer ID signing + notarization for direct distribution.
- Windows code signing to reduce SmartScreen friction.
- Tauri updater signing keys only if auto-update is enabled.

## 13. MVP implementation phases

### Phase 0 — scaffold

- Create Tauri 2 + React + TypeScript project.
- Ensure no Python dependency appears in scripts or CI.
- Add `AGENTS.md`, `CLAUDE.md`, and docs.
- Add basic window config.
- Add lint/test/build commands.
- Add Jotai and minimal typed atoms only if shared frontend state is already needed.

Acceptance:

- `pnpm tauri dev` opens a small undecorated overlay.
- `pnpm tauri build` works on at least the current OS.
- `cargo test` and `pnpm test` run.

### Phase 1 — overlay UX

- Render static fake provider rows.
- Implement opacity, compact mode, drag/lock, click-through toggle.
- Add tray/menu controls for show/hide/settings/click-through.
- Persist overlay settings.

Acceptance:

- Overlay can be moved and locked.
- Overlay does not steal focus in click-through mode.
- Overlay stays above normal windows.
- On macOS/Linux, verify virtual workspace behavior where possible.
- On Windows, implement and document fallback behavior.

### Phase 2 — provider framework

- Add provider trait and scheduler.
- Add `UsageSnapshot` model.
- Add manual provider.
- Show provider errors/no-data states.

Acceptance:

- Manual rows can be added/edited/deleted.
- UI updates from backend events via typed Jotai atoms.
- Provider failure does not crash the app.

### Phase 3 — API header providers

- Implement OpenAI API header snapshot parser.
- Implement Anthropic API header snapshot parser.
- Add fixtures/unit tests for header parsing.
- Do not auto-spend tokens on startup.

Acceptance:

- Given stored/observed headers, app shows remaining requests/tokens and reset time.
- Missing headers produce `NoData`.

### Phase 4 — local CLI providers

- Implement Claude Code local parser only if stable structured usage files are found.
- Implement Codex local parser only if stable structured usage files are found.
- Add sanitized fixtures.
- Mark all inferred values with `source` and `confidence`.

Acceptance:

- No parser panic on malformed files.
- Provider returns `NoData` with useful message when files are absent.
- Any computed windows are tested.

### Phase 5 — packaging/release

- Add GitHub Actions release workflow.
- Produce unsigned artifacts first.
- Add docs for signing and updater keys later.

Acceptance:

- Release workflow uploads artifacts for macOS, Windows, Linux.
- README explains install limitations and unsigned-app warnings.

## 14. Security and privacy requirements

- Default telemetry: off/nonexistent.
- No automatic upload of usage data.
- No plaintext secret storage.
- No hidden background proxy.
- Proxy mode, if added, must be explicit opt-in and visibly active.
- Local file parsers must read only expected directories and file extensions.
- Avoid logging secrets or full request bodies.
- Add a `redact_for_log` helper for provider errors.

## 15. README minimum content

The project README should include:

- What QuotaHUD is.
- What data sources are exact vs estimated.
- Install/build commands.
- OS-specific overlay limitations.
- How to enable/disable providers.
- No-Python guarantee.
- Privacy/security note.
- How to report provider parser issues with sanitized logs.

