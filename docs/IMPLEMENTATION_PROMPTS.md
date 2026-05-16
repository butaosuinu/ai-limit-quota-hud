# IMPLEMENTATION_PROMPTS.md — prompts for Codex CLI / Claude Code

Use these prompts inside Codex CLI or Claude Code. Start each session from the repository root.

## Initial setup prompt

```text
Read AGENTS.md, CLAUDE.md if available, docs/PROJECT_SPEC.md, and docs/ACCEPTANCE_CHECKLIST.md. Then implement Phase 0 only: scaffold a Tauri 2 + React + TypeScript + Rust app named QuotaHUD with no Python dependencies. Add package scripts, baseline tests, basic overlay window config, Jotai dependency if shared frontend state is introduced, and documentation updates. Do not implement provider integrations yet. Run the relevant tests/build commands and report what passed or failed.
```

## Phase 1 prompt — overlay UX

```text
Implement Phase 1 from docs/PROJECT_SPEC.md. Add a transparent undecorated overlay with static sample provider rows, opacity control, compact mode, drag/lock behavior, click-through toggle, and tray/menu controls for show/hide/settings/click-through where Tauri supports it. Keep platform-specific code isolated under src-tauri/src/platform. Do not add Python or external sidecars. Add tests for settings persistence and UI/Jotai state where practical. Run lint/tests.
```

## Phase 2 prompt — WebView providers (opt-in)

```text
Implement Phase 2 from docs/PROJECT_SPEC.md §8 / §13. Add the shared `WebviewScraper` actor under src-tauri/src/providers/webview/ plus `claude_web.rs` (https://claude.ai/settings/usage) and `codex_web.rs` (https://chatgpt.com/codex/cloud/settings/analytics). Each provider must be opt-in (default off), persist its enable flag to provider_settings.json, open a visible login window on first enable, run hidden refresh windows with platform-correct flags (data_directory on Windows/Linux; dataStoreIdentifier on macOS 14+), expose Tauri commands `open_provider_login_window` / `set_provider_enabled` / `get_provider_settings` / `delete_provider_data`, and surface every snapshot as `source=webview-scrape`, `confidence=low`. Default min_refresh_interval=600s with a floor of 300s. Cloudflare challenges and DOM-extractor null payloads must surface as row statuses, not crashes. Add unit tests against captured extractor JSON fixtures.
```

## Phase 3 prompt — release packaging

```text
Implement Phase 3 from docs/PROJECT_SPEC.md. Add GitHub Actions CI and release workflows for macOS, Windows, and Linux. Build unsigned artifacts first. Include README sections for installation, no-Python guarantee, privacy, the webview-scrape estimate caveat, and OS-specific overlay limitations. Do not add updater until signing keys and release hosting are decided. Run local validation commands possible on this OS.
```

## Debugging prompt

```text
Investigate the failing behavior without changing code first. Read relevant files, run the smallest reproducing command, explain the suspected root cause, then implement the minimal fix. Keep provider/platform changes isolated. Run the failing test again and then the relevant broader tests.
```

## Review prompt

```text
Review the current diff against AGENTS.md and docs/ACCEPTANCE_CHECKLIST.md. Look for Python dependencies, accidental non-React frontend framework drift, unnecessary state libraries besides Jotai, plaintext secret storage, hidden network calls, unlabeled estimates, platform-specific overlay regressions, WebView providers running outside opt-in, and missing tests. Provide a prioritized issue list, then fix only the high-confidence issues.
```

## Release-readiness prompt

```text
Check whether the repository is ready for a public alpha release. Verify build commands, generated artifacts, README accuracy, privacy/security claims, and OS limitation notes. Do not overstate support for Windows virtual desktops or Wayland if not verified. Produce a concise release checklist with remaining blockers.
```
