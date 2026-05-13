# QuotaHUD

A small cross-platform desktop overlay that surfaces remaining AI usage / rate-limit headroom across multiple providers (Claude, Claude Code, OpenAI, Anthropic, Codex, …). Built with **Tauri 2 + Rust** and **React + TypeScript + Vite**.

> Status: **Phase 0 (scaffold).** Provider integrations and platform-specific overlay polish land in later phases — see `docs/PROJECT_SPEC.md` for the roadmap.

## What is and is not exact

- `source: official-api` / `response-header` → values come from a provider's own API and are exact (confidence `high`).
- `source: local-log` → parsed from on-disk usage files, accuracy depends on the format (confidence `medium`).
- `source: estimate` / `manual` → user-entered or inferred (confidence `low`).
- Phase 0 only renders sample rows; nothing in the current build is a real measurement.

## Requirements

- **Rust** stable (tested with 1.93+)
- **Node.js** 20+ and **pnpm** 10+
- macOS, Windows, or Linux. Phase 0 has only been exercised on macOS.
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
pnpm test            # vitest
cargo test --manifest-path src-tauri/Cargo.toml
```

## Providers

Phase 0 ships no provider integrations. The roadmap (see `docs/PROJECT_SPEC.md` §8) introduces them in this order:

1. **Manual** rows (user-entered).
2. **OpenAI / Anthropic API** providers — parse rate-limit response headers from observed traffic. No automatic quota-spending probes.
3. **Claude Code / Codex local** providers — best-effort parsing of on-disk usage files. Returns `NoData` cleanly when no stable format is present.

Every snapshot will carry an honest `source` + `confidence` label.

## OS-specific overlay limitations

- **macOS**: transparent overlay relies on Tauri's `macOSPrivateApi: true`. Acceptable for direct binary distribution; not Mac App Store-friendly.
- **Windows**: Tauri's all-virtual-desktop behaviour is limited. Phase 1 will add a Win32 fallback and document any residual gaps.
- **Linux**: X11 is the primary target. Wayland support is best-effort; sticky/always-on-top hints depend on the compositor.

## Privacy and security

- No telemetry. No automatic upload of usage data.
- No network call on startup unless the user has configured a provider that requires it.
- API keys and other provider secrets are stored in the OS credential store (`keyring`), never in plaintext on disk or in frontend state.
- Local log parsers read only expected directories and file extensions.

## Reporting a parser issue

Open an issue with **sanitized** excerpts of the offending file (strip identifiers, tokens, conversation content). Do not paste raw logs.

## License

TBD (will be added before any public release).
