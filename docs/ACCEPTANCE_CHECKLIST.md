# ACCEPTANCE_CHECKLIST.md — QuotaHUD

Use this checklist before opening a PR, tagging a release, or claiming a phase is complete.

## Global checks

- [ ] No Python dependency exists in `package.json`, `Cargo.toml`, CI, build scripts, test scripts, or docs as a required step.
- [ ] Frontend is React + TypeScript + Vite, not Svelte/Vue/Solid.
- [ ] Shared frontend state, if present, uses Jotai atoms/derived atoms rather than Redux/Zustand/Recoil/MobX.
- [ ] No secrets are stored in React state or Jotai atoms.
- [ ] `pnpm install` succeeds.
- [ ] `pnpm lint` succeeds or has a documented temporary exception.
- [ ] `pnpm test` succeeds.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` succeeds.
- [ ] `pnpm tauri dev` launches the app.
- [ ] `pnpm tauri build` builds on the current OS.
- [ ] All provider results include `source` and `confidence`.
- [ ] Provider errors are shown as row/status errors, not process crashes.
- [ ] Secrets are not written to plaintext storage.
- [ ] No telemetry or hidden network calls happen by default.

## Overlay behavior

- [ ] Overlay is undecorated.
- [ ] Overlay can be transparent or semi-transparent.
- [ ] Overlay supports opacity adjustment.
- [ ] Overlay can be always-on-top.
- [ ] Overlay can be click-through.
- [ ] Click-through can be disabled through tray/menu or shortcut.
- [ ] Overlay can be moved when unlocked.
- [ ] Overlay position persists after restart.
- [ ] Overlay can be hidden/restored.
- [ ] Overlay does not appear as a noisy normal taskbar/Alt-Tab window where avoidable.

## Virtual desktop/workspace checks

### macOS

- [ ] Overlay remains visible when switching Spaces.
- [ ] Overlay remains usable when a normal app is full-screen, or the limitation is documented.
- [ ] Transparent-window private API setting is documented if enabled.

### Windows

- [ ] Overlay is topmost above normal windows.
- [ ] Overlay does not steal focus in normal use.
- [ ] Click-through works.
- [ ] Virtual desktop behavior has been tested.
- [ ] If all-desktops behavior is not fully reliable, there is a safe fallback and a visible documented limitation.

### Linux

- [ ] X11 behavior has been tested when available.
- [ ] Wayland degraded behavior is documented when necessary.
- [ ] App does not crash if the compositor refuses topmost/sticky behavior.

## Provider checks

### Manual provider

- [ ] Add/edit/delete manual rows.
- [ ] Manual rows persist after restart.
- [ ] Reset countdown renders correctly.
- [ ] `confidence` defaults to `low`.

### OpenAI API provider

- [ ] Header parser handles request limits.
- [ ] Header parser handles token limits.
- [ ] Header parser handles reset values.
- [ ] Missing headers return `NoData`.
- [ ] No startup probe consumes quota without explicit user action.

### Anthropic API provider

- [ ] Header parser handles request limits.
- [ ] Header parser handles token limits.
- [ ] Header parser handles input-token limits.
- [ ] Header parser handles output-token limits.
- [ ] Missing headers return `NoData`.
- [ ] No startup probe consumes quota without explicit user action.

### Claude Code local provider

- [ ] Absence of Claude Code data returns `NoData`.
- [ ] Malformed files do not panic.
- [ ] Sanitized fixtures cover the parser.
- [ ] Estimated windows are labeled as estimates.

### Codex local provider

- [ ] Absence of Codex data returns `NoData`.
- [ ] Malformed files do not panic.
- [ ] Sanitized fixtures cover the parser.
- [ ] Estimated windows are labeled as estimates.

## Release checks

- [ ] GitHub Actions CI runs for macOS, Windows, and Linux.
- [ ] Release workflow uploads artifacts.
- [ ] README explains unsigned-app warnings if signing is not configured.
- [ ] README explains exact vs estimated providers.
- [ ] README explains privacy model.
