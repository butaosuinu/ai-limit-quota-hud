# QuotaHUD

A small cross-platform desktop overlay that surfaces remaining AI usage / rate-limit headroom across multiple providers (Claude, Claude Code, OpenAI, Anthropic, Codex, …). Built with **Tauri 2 + Rust** and **React + TypeScript + Vite**.

> Status: **Phase 1 (overlay UX) + Phase 5 (CI / release packaging).** The overlay is interactive — tray menu, click-through toggle, global shortcut, drag/lock, and a separate Settings window are all wired up against static sample rows. Provider integrations land in Phase 2+ (see `docs/PROJECT_SPEC.md`).

## What is and is not exact

QuotaHUD always labels every snapshot with a `source` and a `confidence` value so that estimates are never confused with measurements.

| `source`                           | `confidence` | Examples                                                          | Treat as     |
| ---------------------------------- | ------------ | ----------------------------------------------------------------- | ------------ |
| `official-api` / `response-header` | `high`       | OpenAI / Anthropic rate-limit response headers                    | **Exact**    |
| `local-log`                        | `medium`     | Claude Code / Codex on-disk usage files when the format is stable | Approximate  |
| `estimate`                         | `low`        | Derived windows where reset semantics had to be inferred          | **Estimate** |
| `manual`                           | `low`        | Rows the user typed in                                            | **Estimate** |
| `unavailable`                      | —            | Provider configured but no reliable data yet (`NoData`)           | No claim     |

Phase 1 still renders sample rows; nothing in the current build is a real measurement.

## Installation

> Releases are **unsigned** until we have a Developer ID / Windows code-signing setup. The binaries themselves are produced by the GitHub Actions release workflow with no signing or notarization keys involved.

1. Grab the latest build for your OS from the [GitHub Releases page](https://github.com/butaosuinu/ai-limit-quota-hud/releases).
2. Install or extract:
   - **macOS** (`.dmg` / `.app.tar.gz`): the app is not notarized. On first launch Gatekeeper will refuse it — right-click the `.app` and choose **Open**, or run `xattr -dr com.apple.quarantine /Applications/QuotaHUD.app` after copying it across.
   - **Windows** (`.msi` / `.exe`): SmartScreen will show "Windows protected your PC". Click **More info** → **Run anyway** if you trust the build.
   - **Linux** (`.AppImage` / `.deb`): for the AppImage run `chmod +x QuotaHUD-*.AppImage` once, then launch it. The `.deb` installs into the system package manager.
3. The first launch shows the overlay window. Use the tray menu or the Settings window to configure providers (Phase 2+).

If you would rather build from source, follow [Development](#development) below.

## Requirements

- **Rust** stable (tested with 1.93+)
- **Node.js** 20+ and **pnpm** 10+
- macOS, Windows, or Linux. Phase 1 has only been exercised on macOS.
- **No Python is required at any point** — runtime, build, tests, or CI. See [No-Python guarantee](#no-python-guarantee).

## Development

```bash
pnpm install
pnpm tauri dev       # launches the overlay window
pnpm tauri build     # builds a distributable for the current OS
```

Other scripts:

```bash
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint + eslint
pnpm test            # vitest
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs `typecheck`, `lint`, `test`, and `cargo test` as four independent jobs (with `cargo test` on a macOS/Windows/Linux matrix). `pnpm tauri build` is intentionally **not** part of CI — the release workflow (`v*` tag trigger) takes care of producing real bundles via `tauri-apps/tauri-action`, which keeps PR CI cheap while still covering every OS at release time.

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

Providers can be enabled/disabled (and given account labels) from the settings panel once Phase 2 lands. Every snapshot will carry an honest `source` + `confidence` label.

## OS-specific overlay limitations

- **macOS**: transparent overlay relies on Tauri's `macOSPrivateApi: true`. Acceptable for direct binary distribution; not Mac App Store-friendly. The Phase 1 native hook asks AppKit to join every Space and stay above full-screen apps (`NSWindowCollectionBehavior::CanJoinAllSpaces | Stationary | FullScreenAuxiliary`).
- **Windows**: Tauri's `skipTaskbar` + `alwaysOnTop` are honored, but the Win32-level polish (`WS_EX_TOOLWINDOW`, virtual-desktop fallback, `WS_EX_NOACTIVATE`) is deferred to Phase 2. **Persistent visibility across every Windows virtual desktop is not guaranteed** — depending on the OS build, the overlay may stay on the desktop it was last shown on. Re-show via the tray icon as a workaround. The limitation is documented rather than hidden.
- **Linux**: X11 is the primary target; EWMH-compliant window managers honor Tauri's `alwaysOnTop`. **Wayland is best-effort only** — most compositors refuse `alwaysOnTop` / sticky hints, and the overlay may not float above every surface. The app does not crash when hints are denied; it just degrades. The detected `XDG_SESSION_TYPE` is logged at startup so degraded behavior is identifiable in bug reports.

## No-Python guarantee

QuotaHUD does not require Python at any point — not at runtime, not during `pnpm tauri dev` / `pnpm tauri build`, not in tests, not in CI workflows, and not in release packaging. `package.json`, `Cargo.toml`, and the GitHub Actions workflows under `.github/workflows/` contain no Python steps or sidecars.

## Privacy and security

- No telemetry. No automatic upload of usage data.
- No network call on startup unless the user has configured a provider that requires it.
- API keys and other provider secrets are stored in the OS credential store (`keyring`), never in plaintext on disk or in frontend state. (Phase 2+ feature.)
- Local log parsers read only expected directories and file extensions.
- Browser cookies are never read or stored in v0.

## Roadmap / Future work

Tracked but **not** in this release:

- **macOS Developer ID signing + notarization** for direct distribution (`.dmg` / `.app.tar.gz` are currently unsigned).
- **Windows code signing** to remove SmartScreen friction on `.msi` / `.exe` artifacts.
- **Tauri updater** for in-app updates — gated on the signing keys above and on a decision about release hosting.
- Provider integrations (manual rows, API header parsers, local CLI parsers) — see `docs/PROJECT_SPEC.md` §13 phases 2–4.

## Reporting a parser issue

Open an issue with **sanitized** excerpts of the offending file (strip identifiers, tokens, conversation content). Do not paste raw logs.

## License

TBD (will be added before any public release).
