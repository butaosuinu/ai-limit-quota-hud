# AGENTS.md — AI Quota Overlay / QuotaHUD

## Mission
Build a small cross-platform Tauri 2 desktop app that shows remaining AI usage/rate-limit information for multiple providers in a transparent, always-visible overlay.

The app is tentatively named `QuotaHUD`. Rename only if the repository already has a different name.

## Hard requirements
- Use Tauri 2 for the desktop app.
- Produce distributable binaries/installers for macOS, Windows, and Linux.
- Do not require Python at runtime, during normal development, in tests, in build scripts, or in CI.
- Prefer Rust for backend/platform code and TypeScript + React + Vite for UI. Do not scaffold Svelte/Vue/Solid.
- Show an overlay window that can be always-on-top, transparent, click-through, and visible across virtual desktops/workspaces where the OS supports it.
- Support multiple provider/account rows through a provider adapter interface.
- Never store provider tokens, cookies, or API keys in plaintext. Use the OS credential store.
- Do not implement fragile private-endpoint scraping as the default path. Clearly label any estimated or unofficial data source.

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
- Persistence: SQLite via `rusqlite` or `sqlx`; avoid heavy ORMs
- Secret storage: OS credential store via a Rust crate such as `keyring`
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

