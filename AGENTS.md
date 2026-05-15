# AGENTS.md — AI Quota Overlay / QuotaHUD

## Mission

Build a small cross-platform Tauri 2 desktop app that shows remaining AI subscription-usage headroom (Claude Pro/Max, ChatGPT Plus/Pro/Codex agent) via opt-in WebView providers in a transparent, always-visible overlay.

The app is tentatively named `QuotaHUD`. Rename only if the repository already has a different name.

## Hard requirements

- Use Tauri 2 for the desktop app.
- Produce distributable binaries/installers for macOS, Windows, and Linux.
- Do not require Python at runtime, during normal development, in tests, in build scripts, or in CI.
- Prefer Rust for backend/platform code and TypeScript + React + Vite for UI. Do not scaffold Svelte/Vue/Solid.
- Show an overlay window that can be always-on-top, transparent, click-through, and visible across virtual desktops/workspaces where the OS supports it.
- Support multiple provider/account rows through a provider adapter interface.
- v1 ships opt-in WebView providers only; session cookies live in the OS-native WebView cookie store (per-provider `data_directory` on Windows/Linux, `dataStoreIdentifier` on macOS 14+). QuotaHUD code must not read individual cookie values. See `docs/PROJECT_SPEC.md` §8 / §10.2 / §14.
- Treat every WebView snapshot as `source=webview-scrape`, `confidence=low`. Failure modes (Cloudflare challenge, login redirect, DOM layout change) must surface as `SnapshotStatus::Error` / `NoData`, never crashes.

## Before editing

Read these files first:

1. `docs/PROJECT_SPEC.md`
2. `docs/ACCEPTANCE_CHECKLIST.md`
3. `docs/IMPLEMENTATION_PROMPTS.md` when you need task-by-task prompts

## Default stack

- Package manager: `pnpm`
- Frontend: TypeScript, React, Vite
- Frontend state: Jotai for shared state when needed; React local state for component-local concerns
- Backend: Rust stable, Tauri 2
- Rust async/http: `tokio`, `reqwest` with rustls where practical
- Serialization/time: `serde`, `serde_json`, `time` or `chrono`
- Persistence: small JSON files (e.g. `provider_settings.json`) under the platform app-config dir; avoid SQLite or ORMs until a feature requires them
- Session storage: OS-native WebView cookie store, isolated per provider (see PROJECT_SPEC §8 / §10.2). No keyring or API-key handling in v1.
- Tests: `cargo test`, `vitest`, small deterministic fixtures

## Commands the project should support

Use these exact scripts unless the repository has a strong reason not to:

```bash
pnpm install
pnpm dev
pnpm tauri dev
pnpm lint
pnpm test
pnpm build
pnpm tauri build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Coding rules

- Keep provider collection code isolated from UI rendering.
- Use React function components and hooks. Keep component-local state with `useState`/`useReducer`; use Jotai atoms only for shared UI/app state such as overlay settings, provider snapshots, connection status, and selected provider/account.
- Keep Jotai atoms small and typed. Put atoms under `src/lib/atoms/` or `src/state/`, and avoid storing secrets in frontend atoms.
- Every provider result must include `source` and `confidence`.
- Use typed DTOs shared conceptually between Rust and TypeScript. Do not pass anonymous unvalidated JSON through the UI.
- Error states must be visible in the UI without crashing the overlay.
- No telemetry by default.
- No network call should happen on startup unless the user configured a provider that requires it.
- Avoid polling faster than necessary. Default provider refresh interval should be configurable and no faster than 60 seconds.
- Make platform-specific overlay behavior explicit in `src-tauri/src/platform/`.

## Review expectations

Before considering work complete:

- Run relevant Rust and frontend tests.
- Run format/lint where configured.
- Verify the app starts with `pnpm tauri dev`.
- Update docs when architecture, limitations, or build commands change.
- If an OS-specific feature is unsupported or flaky, document the limitation and leave the code path safe rather than pretending it works.
