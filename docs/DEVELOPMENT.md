# Development

Developer-facing build, test, and CI notes. For the full design spec see
[`PROJECT_SPEC.md`](./PROJECT_SPEC.md).

## Requirements

- **Rust** stable (tested with 1.93+)
- **Node.js** 20+ and **pnpm** 10+
- macOS, Windows, or Linux. Phase 1 has only been exercised on macOS.

## Build from source

```bash
pnpm install
pnpm tauri dev       # launches the overlay window
pnpm tauri build     # builds a distributable for the current OS
```

## Other scripts

```bash
pnpm typecheck       # tsc --noEmit
pnpm lint            # oxlint + eslint
pnpm test            # vitest
cargo test --manifest-path src-tauri/Cargo.toml
```

## CI

CI runs `typecheck`, `lint`, `test`, and `cargo test` as four independent jobs
(with `cargo test` on a macOS/Windows/Linux matrix). `pnpm tauri build` is
intentionally **not** part of CI — the release workflow (`v*` tag trigger) takes
care of producing real bundles via `tauri-apps/tauri-action`, which keeps PR CI
cheap while still covering every OS at release time.

## Roadmap / Future work

Tracked but **not** in the current release:

- **macOS Developer ID signing + notarization** for direct distribution
  (`.dmg` / `.app.tar.gz` are currently ad-hoc signed, not notarized).
- **Windows code signing** to remove SmartScreen friction on `.msi` / `.exe`
  artifacts.
- WebView provider integrations (`webview-claude-ai`, `webview-chatgpt-codex`) —
  see [`PROJECT_SPEC.md` §13](./PROJECT_SPEC.md#13-mvp-implementation-phases)
  Phase 2.

The release / signing-key runbook (keypair generation, GitHub secrets, key
rotation) lives in
[`PROJECT_SPEC.md` §12.3](./PROJECT_SPEC.md#123-release-artifacts).
