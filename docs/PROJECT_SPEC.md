# PROJECT_SPEC.md — QuotaHUD

## 1. Product goal

QuotaHUD is a small desktop overlay that surfaces remaining
subscription-usage headroom for AI products that do not expose an official
rate-limit API. The v1 target is **Claude (Pro/Max)** on `claude.ai` and
**ChatGPT (Plus/Pro/Codex agent)** on `chatgpt.com`.

Each provider is implemented as an **opt-in WebView provider** that loads the
vendor's own usage settings page inside QuotaHUD's built-in Tauri 2 WebView
and scrapes the visible figures with a small JavaScript helper. The overlay
itself stays neutral about data sources — providers register themselves under
a single `UsageProvider` trait, so additional opt-in WebView providers can be
added later without touching the UI.

## 2. Non-goals for v0

Do not start with these in v0:

- Python-based helpers, Python test runners, Python packaging, or Python
  sidecars.
- Heavy analytics or telemetry.
- Mobile support.
- A pixel-perfect clone of any existing tool.
- Programmatic credential capture or hosted login pages — login happens
  inside the vendor's own WebView page.

WebView-backed providers are off by default in every build and must be
enabled by an explicit user toggle. See §8, §10.2, and §14 for the rules
that govern them.

## 3. Terminology

Use these terms consistently:

- `usage`: amount consumed in a known window.
- `remaining`: remaining requests/tokens/messages/percent.
- `window`: reset window, such as `1m`, `5h`, `daily`, `weekly`, `monthly`,
  or `api`.
- `provider`: integration source. v1 ships `webview-claude-ai` and
  `webview-chatgpt-codex`.
- `source`: how the number was obtained: `webview-scrape` (DOM extraction
  from the vendor page) or `unavailable` (provider not yet able to report —
  used for `Error` / `NoData` rows).
- `confidence`: `high`, `medium`, or `low`. Every `webview-scrape` row is
  `low` because the vendor's DOM is not a stable contract.

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
│   │   │   ├── overlayAtoms.ts
│   │   │   └── usageAtoms.ts
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
│           └── webview/
│               ├── mod.rs           # shared WebviewScraper + helpers
│               ├── claude_web.rs    # ClaudeWebProvider
│               ├── codex_web.rs     # CodexWebProvider
│               └── extractors/
│                   ├── claude.js    # DOM extraction JS (include_str!)
│                   └── codex.js     # DOM extraction JS (include_str!)
└── .github/
    └── workflows/
        ├── ci.yml
        └── release.yml
```

## 5. Frontend stack and state management

Use React with TypeScript and Vite. Do not scaffold or migrate to Svelte,
Vue, Solid, or another frontend framework unless the human maintainer
explicitly changes this spec.

State management rules:

- Use ordinary React local state for local-only component concerns.
- Use Jotai for shared frontend state when needed, especially overlay
  settings, provider snapshots received from Tauri events, provider
  configuration form state, selected account/provider, and UI mode flags.
- Keep atoms small, typed, and colocated under `src/lib/atoms/` or
  `src/state/`.
- Prefer derived atoms for computed display values such as sorted provider
  rows, warning/critical counts, compact-mode visibility, and reset
  countdown labels.
- Do not store cookies, tokens, or other secrets in Jotai atoms. Session
  cookies live in the native WebView cookie store; QuotaHUD code does not
  read them. See §10.2.
- Avoid Redux, Zustand, Recoil, MobX, XState, or TanStack Query as default
  dependencies. Add them only with a written justification in the PR/docs.

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
- Optional compact mode showing only provider icon/name, remaining
  percentage, and reset countdown.
- User can choose screen corner and margin.
- User can change opacity.
- User can lock/unlock dragging.
- User can toggle click-through from tray/menu or global shortcut.
- User can hide/show overlay from tray/menu.

Default visual model:

```text
┌ Claude (Pro)        74%   reset 2:14 ┐
│ ChatGPT (Plus)      59%   reset 0:37 │
└ opacity 0.72 / click-through on ─────┘
```

### 6.2 Settings panel

Settings can be a second Tauri window or an overlay-expanded mode.

Minimum settings:

- WebView providers enabled/disabled (per provider opt-in toggle).
- Login / delete-provider-data actions per WebView provider.
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

- `low`: `webview-scrape` source. The DOM contract is not officially
  guaranteed, so the value may break if the vendor changes layout.
- `no data`: provider configured but no reliable snapshot yet (e.g.
  re-login required, page not yet loaded).

The `webview-scrape` source must always be persisted on every snapshot as
`confidence: low`. The overlay itself stays visually quiet — it does not
render dedicated `low` / `webview` pills on every row. The data-source
caveat is disclosed centrally instead: this `README.md` documents it, and
the Settings window's WebView providers panel surfaces it next to the
opt-in toggle. Snapshot status (`warning` / `critical` / `no-data` /
`error`) and any associated `message` field still surface on the row,
because those represent acute conditions the user needs to act on rather
than the steady-state "this is a webview estimate" disclosure.

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
    WebviewClaudeAi,
    WebviewChatgptCodex,
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
    Unavailable,
    WebviewScrape,
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
  providerKind: "webview-claude-ai" | "webview-chatgpt-codex";
  accountLabel: string;
  window:
    | "one-minute"
    | "five-hours"
    | "daily"
    | "weekly"
    | "monthly"
    | "api"
    | "unknown";
  metric:
    | "requests"
    | "tokens"
    | "input-tokens"
    | "output-tokens"
    | "messages"
    | "percent"
    | "unknown";
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  remainingPercent?: number | null;
  resetAt?: string | null;
  observedAt: string;
  source: "unavailable" | "webview-scrape";
  confidence: "high" | "medium" | "low";
  status: "ok" | "warning" | "critical" | "no-data" | "error";
  message?: string | null;
};
```

## 8. Provider architecture — opt-in WebView providers

Create a provider trait in Rust:

```rust
#[async_trait::async_trait]
pub trait UsageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn kind(&self) -> ProviderKind;
    async fn refresh(&self, ctx: &ProviderContext) -> anyhow::Result<Vec<UsageSnapshot>>;
}
```

`ProviderContext` should include:

- App config.
- Clock abstraction for tests.
- Optional path resolver for the per-provider data directory.

General provider rules:

- Return `NoData` (or `Error`) instead of failing globally when only one
  provider is unavailable.
- Never panic on transient failures (page never loaded, Cloudflare challenge,
  layout change).
- Keep extraction deterministic and unit tested with fixtures of the DOM
  payload returned by the in-page extractor.
- Each provider should have a `README` comment or module doc explaining its
  target URL, the extractor contract, and the failure modes.

For Claude (Pro/Max) on `claude.ai` and ChatGPT (Plus/Pro/Codex agent) on
`chatgpt.com`, where no official rate-limit API exists, QuotaHUD ships an
**opt-in** WebView-backed provider. The provider loads each vendor's own
usage settings page inside QuotaHUD's built-in Tauri 2 WebView and extracts
the visible usage figures with a small JavaScript helper, so that no Python
or external runtime is required.

Hard rules:

- **Opt-in only.** A WebView provider must not start, navigate, or load any
  external URL unless the user explicitly enables it from Settings. Default
  is off. The opt-in state is persisted in `provider_settings.json`,
  separate from overlay settings.
- **Visible login flow.** The first time a user enables the provider,
  QuotaHUD opens a normal visible WebView window pointing at the provider's
  own login URL (for example `https://claude.ai/login`). QuotaHUD does not
  present its own login form, does not intercept credentials, and does not
  read the password field. The user authenticates in the provider's own
  page. The provider's login page may redirect through external identity
  providers (Google, Apple, Microsoft, Okta, Cloudflare Access, GitHub,
  etc.); these redirects are permitted as part of the login chain and must
  not be blocked. See §14 for the egress allowlist rule.
- **Hidden refresh window.** After login, QuotaHUD creates a separate hidden
  WebView window that re-navigates to the usage page on a scheduler tick to
  refresh the snapshot. On every platform the window is created with
  `visible=false`, `focused=false`, `decorations=false`, and
  `resizable=false`. Additional flags are platform-specific because Tauri 2
  exposes different builder hooks per OS:
  - **Windows / Linux:** also set `skip_taskbar=true` so the window is not
    listed in the taskbar / Alt-Tab.
  - **macOS:** `WebviewWindowBuilder::skip_taskbar` is not supported because
    AppKit has no per-window taskbar concept. A non-visible NSWindow does
    not contribute to the dock, so `visible=false` is sufficient; the
    overall application's dock icon behavior is governed by §9.2 (NSApp
    activation policy and NSWindow collection behavior), not by this rule.
- **No `__TAURI__` exposure on external origins.** The internal Tauri IPC
  must not be reachable from `claude.ai` or `chatgpt.com`. Results are
  returned by the extractor JavaScript writing a JSON payload into
  `document.title` with a short prefix (for example `QHJSON:`), which Rust
  polls and clears.
- **Per-provider session isolation.** Each provider's WebView session must
  be kept isolated from other providers' sessions. The login window and
  refresh window of the same provider share the same session so that the
  cookie persists across them. The concrete mechanism is platform-specific
  because Tauri 2 exposes different WebView storage APIs on each OS:
  - **Windows (WebView2) and Linux (WebKitGTK):** use
    `WebviewBuilder::data_directory(app_data_dir/webview-<provider>/)` to
    bind a dedicated on-disk profile per provider.
  - **macOS (WKWebView):** `data_directory` is not honored. Use the
    `dataStoreIdentifier` builder hook to attach a `WKWebsiteDataStore`
    derived deterministically from the provider slug (for example a
    UUIDv5 over `webview-<provider>`). This requires macOS 14+ for
    persistent per-identifier stores; on older macOS the implementation
    must fall back to a single store, isolate logically by URL origin only,
    and document this as a known limitation in the README.
- **Deletable.** The Settings UI must expose a "Delete provider data"
  action whose effect is platform-specific:
  - **Windows / Linux:** remove the entire `webview-<provider>/` directory.
  - **macOS:** remove the per-`dataStoreIdentifier` `WKWebsiteDataStore` on
    macOS 14+. On older macOS, fall back to
    `WKWebsiteDataStore.removeData(ofTypes:for:completionHandler:)` scoped
    to the provider's target origin (for example `claude.ai`,
    `chatgpt.com`).
    In all cases the next refresh must require a fresh login.
- **`source=webview-scrape`, `confidence=low`.** The DOM contract of an
  external web app is not a stable interface. Results must always render as
  `confidence: low` and be marked clearly in the UI tooltip.
- **Refresh budget.** The default `min_refresh_interval` for a WebView
  provider is **60 seconds**, with a configured floor of 60 seconds. Avoid
  polling faster than this unless a future provider has a documented reason.
- **Failure modes are statuses, not crashes.** A Cloudflare challenge,
  redirect to `/login`, or a layout change that makes the extractor return
  `null` must surface as `SnapshotStatus::Error` or `SnapshotStatus::NoData`
  with a human-readable message, never a process crash.

Recommended file layout (concrete, for the v1 implementation):

```text
src-tauri/src/providers/webview/
  mod.rs                 # shared `WebviewScraper` actor and helpers
  claude_web.rs          # ClaudeWebProvider (UsageProvider impl)
  codex_web.rs           # CodexWebProvider (UsageProvider impl)
  extractors/
    claude.js            # DOM extraction JS, loaded via include_str!
    codex.js             # DOM extraction JS, loaded via include_str!
```

The DOM selectors and traversal logic in `extractors/*.js` must be written
fresh inside this repository. Treat each vendor's web app as an external,
unstable interface: keep extractor heuristics small, defensive, and easy to
swap when the page layout changes.

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

If Tauri settings are insufficient, use AppKit via Rust/Objective-C
bindings to adjust the NSWindow:

- collection behavior: join all spaces, full-screen auxiliary, stationary
  where appropriate
- level: floating or status-like level, not intrusive screen-saver level by
  default
- non-activating/focus behavior if feasible

Note: transparent windows on macOS may require Tauri's macOS private API
flag; because this app is intended for direct binary distribution rather
than Mac App Store, that can be acceptable. Document it.

### 9.3 Windows

Tauri's all-workspaces support is limited on Windows. Implement a
Windows-specific overlay module.

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

1. Test whether Tauri topmost window persists across Windows virtual
   desktops.
2. If not, implement a safe fallback that detects desktop changes or
   foreground changes and recreates/repositions the overlay quickly.
3. Do not rely on undocumented COM APIs unless isolated behind a feature
   flag and documented as experimental.
4. If full all-desktops behavior cannot be made reliable, expose the
   limitation in settings and docs.

### 9.4 Linux

Implement via Tauri first.

Expected behavior on X11:

- topmost/sticky behavior should be feasible through window manager hints.

Expected behavior on Wayland:

- compositor limitations may prevent global always-on-top or all-workspaces
  behavior.
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

Persist overlay settings in a Tauri store file. WebView provider opt-in
state must be persisted separately from overlay settings (suggested file:
`provider_settings.json`) so that provider toggles can be reasoned about
independently from window placement and theming.

### 10.2 Secrets

QuotaHUD does not handle API keys, OAuth tokens, or proxy credentials in
v1. The only persisted authentication material is the **OS-native WebView
cookie store** used by opt-in WebView providers (see §8): WKWebView on
macOS, WebView2 on Windows, WebKitGTK on Linux.

Rules:

- QuotaHUD application code must not read, copy, or otherwise process
  individual cookie values. The native cookie store is treated as an opaque
  session container.
- Each WebView provider isolates its session storage from other providers
  using whichever mechanism the platform exposes — a
  `data_directory(app_data_dir/webview-<provider>/)` on Windows and Linux,
  or a deterministic `dataStoreIdentifier` (and the matching
  `WKWebsiteDataStore`) on macOS.
- Sessions are fully removable through a user-visible "Delete provider
  data" action.

## 11. Scheduler

Create a scheduler that refreshes enabled providers and emits
`usage://updated` or a normal Tauri event to the frontend.

Rules:

- Default refresh interval: 60 seconds or slower.
- Each provider can set a minimum refresh interval. WebView providers
  default to 60 seconds with a hard floor of 60 seconds (see §8).
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

If you prefer `pnpm tauri dev` and `pnpm tauri build`, keep both aliases
working.

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

macOS builds are **ad-hoc signed** (`bundle.macOS.signingIdentity: "-"` in
`tauri.conf.json`), so Gatekeeper treats them as signed-but-unverified rather
than "damaged"; users still confirm on first launch because the bundle is not
notarized. Full signing/notarization can be added after MVP:

- macOS Developer ID signing + notarization for direct distribution.
- Windows code signing to reduce SmartScreen friction.

Auto-update is **shipped in v1** via `tauri-plugin-updater`:

- The updater endpoint points at
  `https://github.com/butaosuinu/ai-limit-quota-hud/releases/latest/download/latest.json`
  (GitHub Releases' `latest` view excludes draft and prerelease entries, so
  pre-release tags do not roll out to existing users).
- `bundle.createUpdaterArtifacts: true` is enabled in `tauri.conf.json`, so
  every release run produces `latest.json` + per-artifact `.sig` files
  alongside the platform installers.
- minisign signing keys live in CI as the
  `TAURI_SIGNING_PRIVATE_KEY` /
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. This signing chain is
  independent of OS code signing — the updater verifies its own minisign
  signature on the downloaded bundle regardless of whether the bundle itself
  carries a valid Developer ID or Authenticode signature.
- The default-on updater check runs **on startup and once every 24 hours**
  while the app stays open, an **explicit, documented exception** to the
  AGENTS.md "no network call on startup" policy. Both automatic checks are
  governed by a single **Settings → Updates → Check automatically** toggle;
  turning it off stops the startup and the daily check without disabling the
  updater entirely (manual "Check now" still works). The toggle is re-read on
  every daily tick, so toggling it at runtime takes effect on the next tick.
  The daily timer is a `tokio::time::sleep` loop: after a long system sleep it
  may fire late, but it still fires and never drops a check.
- OS-level code signing (Developer ID / `codesign` notarization, Windows
  Authenticode) remains tracked as future work in its own issue and is
  orthogonal to the updater signing keys above.

#### Maintainer runbook — signing keys & rollout

The minisign **public key** lives in `src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`) and is safe to commit because it can only verify
signatures, not produce them. Only the matching **private key** must stay
secret.

1. Generate a minisign keypair once:
   `pnpm tauri signer generate -w ~/.tauri/quotahud-updater.key`
2. Commit the **public key** (the base64 string printed to stdout, also stored
   next to the private key as `*.pub`) to
   `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
3. Register the **private key** and its passphrase as GitHub repo secrets:
   - `TAURI_SIGNING_PRIVATE_KEY` — the private key file contents
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the passphrase set at generation
     time
4. Back up the private key (1Password etc.). **Losing it permanently breaks
   auto-updates for existing users** because every shipped binary was compiled
   with the matching public key and will reject signatures from a fresh key.
5. Push a `v*` tag; the release workflow uploads `latest.json` + `.sig`
   alongside the platform installers.

**Key rotation:** if the private key is compromised, ship a final update signed
with the old key that bumps the committed `pubkey` to a new one, then start
signing with the new private key. Users still on builds older than that
rotation update must reinstall manually.

## 13. MVP implementation phases

### Phase 0 — scaffold

- Create Tauri 2 + React + TypeScript project.
- Ensure no Python dependency appears in scripts or CI.
- Add `AGENTS.md`, `CLAUDE.md`, and docs.
- Add basic window config.
- Add lint/test/build commands.
- Add Jotai and minimal typed atoms only if shared frontend state is
  already needed.

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

### Phase 2 — WebView providers (opt-in)

- Add `ProviderKind::WebviewClaudeAi`, `ProviderKind::WebviewChatgptCodex`
  and `UsageSource::WebviewScrape` to the Rust model and TS DTO (already in
  place).
- Implement the shared `WebviewScraper` actor under
  `src-tauri/src/providers/webview/`.
- Implement `claude_web.rs` against `https://claude.ai/settings/usage` and
  `codex_web.rs` against `https://chatgpt.com/codex/cloud/settings/analytics`.
- Implement platform-specific session isolation (see §8): `data_directory`
  on Windows / Linux, `dataStoreIdentifier` (+ `WKWebsiteDataStore`) on
  macOS, with the macOS <14 fallback documented as a limitation.
- Add `provider_settings.json` persistence for opt-in toggles, distinct
  from overlay settings.
- Add Tauri commands `open_provider_login_window`, `set_provider_enabled`,
  `get_provider_settings`, `delete_provider_data`.
- Add a Settings UI section to enable/disable each WebView provider,
  trigger login, and delete provider data.
- Use a configurable `min_refresh_interval` for WebView providers with a
  default of 60 seconds and an enforced floor of 60 seconds. Reject
  configurations below 60s at the settings boundary; permit any value in
  the 60–3600s range.

Acceptance:

- WebView providers are disabled by default and only start after explicit
  user action.
- Hidden refresh windows are not visible in the macOS dock, the Windows
  taskbar, or the Linux taskbar.
- A Cloudflare challenge, a `/login` redirect, or an extractor returning
  `null` is surfaced as a row status with a human-readable message and
  does not crash the app.
- "Delete provider data" forces re-login on the next refresh on all three
  platforms: removing `webview-<provider>/` on Windows and Linux, and
  clearing the `dataStoreIdentifier`-scoped `WKWebsiteDataStore`
  (or the per-origin fallback on macOS <14) on macOS.
- All resulting `UsageSnapshot` rows have `source=webview-scrape` and
  `confidence=low`, and the UI tooltip explains the data source.

### Phase 3 — packaging/release

- Add GitHub Actions release workflow.
- Produce unsigned artifacts first.
- Document the updater signing-key runbook (done — see §12.3). OS-level code
  signing (Developer ID / Authenticode) docs remain future work.

Acceptance:

- Release workflow uploads artifacts for macOS, Windows, Linux.
- README explains install limitations and unsigned-app warnings.

## 14. Security and privacy requirements

- Default telemetry: off/nonexistent.
- No automatic upload of usage data.
- No plaintext secret storage.
- No hidden background proxy.
- Avoid logging secrets or full request bodies.
- Add a `redact_for_log` helper for provider errors.
- WebView-backed providers (see §8) are subject to additional rules:
  - They are off by default and must require an explicit opt-in toggle.
  - On the first run, the visible window must navigate to the provider's
    own login URL. QuotaHUD must not render its own login form or read
    keystrokes.
  - The hidden refresh window must not expose `__TAURI__` IPC to external
    origins. Results are returned through `document.title` polling or
    equivalent indirect channels.
  - Each WebView provider must isolate its session storage from other
    providers using the platform's native mechanism: `data_directory`
    under `app_data_dir/webview-<provider>/` on Windows / Linux, and a
    per-provider `dataStoreIdentifier` (backing a `WKWebsiteDataStore`)
    on macOS (see §8 for details and the macOS <14 fallback). Application
    code must not read, inspect, or copy individual cookies from these
    stores.
  - A user-triggered "Delete provider data" action must clear the
    provider's session storage on every platform: remove the
    `webview-<provider>/` directory on Windows / Linux, and remove the
    `dataStoreIdentifier`-scoped `WKWebsiteDataStore` (or fall back to
    origin-scoped removal) on macOS.
  - Outbound network traffic from a WebView provider must originate from a
    user-initiated login or a scheduled refresh against the provider's
    configured target origin (for example `claude.ai`, `chatgpt.com`).
    Navigations triggered by the target's own authentication flow to
    well-known identity providers (Google, Apple, Microsoft, Okta,
    Cloudflare Access, GitHub, etc.) are permitted because the provider's
    first-party login flow requires them. Outside of the login redirect
    chain, the provider's own scripts must not navigate to or fetch from
    third-party hosts; the implementation should enforce this with a
    small allowlist that grows only while a login flow is in progress and
    resets once the redirect chain returns to the target origin.

## 15. README minimum content

The project README should include:

- What QuotaHUD is.
- Which providers are shipped, and the fact that every WebView snapshot is
  an estimate (`source=webview-scrape`, `confidence=low`) because it scrapes
  the vendor's web UI.
- Install/build commands.
- OS-specific overlay limitations.
- How to enable/disable WebView providers, log in, and delete provider data.
- No-Python guarantee.
- Privacy/security note covering the WebView cookie store carve-out.
- How to report extractor breakage with sanitized DOM excerpts.
