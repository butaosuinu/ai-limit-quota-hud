# QuotaHUD

A small cross-platform desktop overlay that surfaces remaining AI usage / rate-limit headroom across multiple providers (Claude, Claude Code, OpenAI, Anthropic, Codex, …). Built with **Tauri 2 + Rust** and **React + TypeScript + Vite**.

> Status: **Phase 1 (overlay UX).** The overlay is interactive — tray menu, click-through toggle, global shortcut, drag/lock, and a separate Settings window are all wired up against static sample rows. Real provider integrations land in Phase 2+ (see `docs/PROJECT_SPEC.md`).

## What is and is not exact

- `source: official-api` / `response-header` → values come from a provider's own API and are exact (confidence `high`).
- `source: local-log` → parsed from on-disk usage files, accuracy depends on the format (confidence `medium`).
- `source: estimate` / `manual` → user-entered or inferred (confidence `low`).
- Phase 1 still renders sample rows; nothing in the current build is a real measurement.

## Requirements

- **Rust** stable (tested with 1.93+)
- **Node.js** 20+ and **pnpm** 10+
- macOS, Windows, or Linux. Phase 1 has only been exercised on macOS.
- **No Python** is required at any point — runtime, build, tests, or CI.

## Development

```bash
pnpm install
pnpm tauri dev       # launches the overlay window
pnpm tauri build     # builds a distributable for the current OS
```

Other scripts:

```bash
pnpm lint
pnpm typecheck
pnpm test            # vitest
cargo test --manifest-path src-tauri/Cargo.toml
```

## Using the overlay

Phase 1 ships two windows:

- **`overlay`** — the transparent always-on-top HUD. Drag-to-move when unlocked, click-through when enabled. Sample rows are static.
- **`settings`** — a regular window that hosts the opacity slider, compact / lock / click-through / visibility toggles, the persisted position, and a "reset to defaults" button. Hidden at startup; opened from the tray.

### Tray menu

QuotaHUD installs a system-tray icon (left-click opens the menu on every supported OS):

- **Show/Hide overlay** — toggles visibility without quitting.
- **Click-through** — checkbox; when on, mouse events pass through the overlay.
- **Lock position** — checkbox; when off, the overlay becomes draggable.
- **Settings…** — opens the Settings window.
- **Quit QuotaHUD** — exits the app.

### Global shortcut

`Cmd/Ctrl + Shift + \` toggles click-through. Registration is best-effort — if another app already owns the chord, QuotaHUD logs a warning and continues without it.

### Settings persistence

Overlay state (opacity, compact, click-through, lock, visibility, position, corner/margin) is persisted as JSON under the platform-standard app config directory:

- macOS: `~/Library/Application Support/dev.quotahud.app/settings.json`
- Windows: `%APPDATA%/dev.quotahud.app/settings.json`
- Linux: `$XDG_CONFIG_HOME/dev.quotahud.app/settings.json` (or `~/.config/...`)

No secrets live here — provider tokens go through the OS credential store in later phases.

## Providers

Phase 1 ships no provider integrations. The roadmap (see `docs/PROJECT_SPEC.md` §8) introduces them in this order:

1. **Manual** rows (user-entered).
2. **OpenAI / Anthropic API** providers — parse rate-limit response headers from observed traffic. No automatic quota-spending probes.
3. **Claude Code / Codex local** providers — best-effort parsing of on-disk usage files. Returns `NoData` cleanly when no stable format is present.

Every snapshot will carry an honest `source` + `confidence` label.

## OS-specific overlay limitations

- **macOS**: transparent overlay relies on Tauri's `macOSPrivateApi: true`. Acceptable for direct binary distribution; not Mac App Store-friendly. The Phase 1 native hook also asks AppKit to join every Space and stay above full-screen apps (`NSWindowCollectionBehavior::CanJoinAllSpaces | Stationary | FullScreenAuxiliary`).
- **Windows**: Tauri's `skipTaskbar` + `alwaysOnTop` are honored, but the Win32-level polish (`WS_EX_TOOLWINDOW`, virtual-desktop fallback, `WS_EX_NOACTIVATE`) is deferred to Phase 2. The overlay may briefly take focus on first show, and switching virtual desktops can leave the overlay on the previous desktop — re-show via the tray icon as a workaround.
- **Linux**: X11 is the primary target. On Wayland most compositors refuse `alwaysOnTop` / sticky hints; QuotaHUD still draws and persists state, it just may not float above every surface. The app logs the detected `XDG_SESSION_TYPE` at startup so degraded behavior is identifiable in bug reports.

## Privacy and security

- No telemetry. No automatic upload of usage data.
- No network call on startup unless the user has configured a provider that requires it.
- API keys and other provider secrets are stored in the OS credential store (`keyring`), never in plaintext on disk or in frontend state. (Phase 2+ feature.)
- Local log parsers read only expected directories and file extensions.

## Reporting a parser issue

Open an issue with **sanitized** excerpts of the offending file (strip identifiers, tokens, conversation content). Do not paste raw logs.

## License

TBD (will be added before any public release).
