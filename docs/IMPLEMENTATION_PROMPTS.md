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

## Phase 2 prompt — provider framework

```text
Implement Phase 2 from docs/PROJECT_SPEC.md. Add the UsageSnapshot model, provider trait, scheduler, backend Tauri commands/events, and manual provider. The UI should render real backend snapshots and handle provider no-data/error states. Persist manual rows and overlay settings. Add Rust unit tests for model/status logic and frontend tests for row rendering and relevant Jotai atoms/derived atoms. Run lint/tests.
```

## Phase 3 prompt — API header providers

```text
Implement Phase 3 from docs/PROJECT_SPEC.md. Add OpenAI and Anthropic API response-header parsers using deterministic fixtures. Do not send API requests automatically and do not consume quota. The providers may read previously observed header snapshots from local storage or a manually imported test snapshot. Missing headers should return NoData. Run Rust tests and frontend tests.
```

## Phase 4 prompt — local CLI providers

```text
Implement Phase 4 from docs/PROJECT_SPEC.md. Explore the local environment only enough to identify stable structured Claude Code and Codex CLI usage/session files. Do not read unrelated files. If stable formats are found, implement parsers with sanitized fixtures. If not, implement safe NoData providers with clear messages and TODO docs. All inferred values must be marked source=local-log or estimate and confidence=medium/low. Run tests.
```

## Phase 5 prompt — release packaging

```text
Implement Phase 5 from docs/PROJECT_SPEC.md. Add GitHub Actions CI and release workflows for macOS, Windows, and Linux. Build unsigned artifacts first. Include README sections for installation, no-Python guarantee, privacy, exact vs estimated sources, and OS-specific overlay limitations. Do not add updater until signing keys and release hosting are decided. Run local validation commands possible on this OS.
```

## Debugging prompt

```text
Investigate the failing behavior without changing code first. Read relevant files, run the smallest reproducing command, explain the suspected root cause, then implement the minimal fix. Keep provider/platform changes isolated. Run the failing test again and then the relevant broader tests.
```

## Review prompt

```text
Review the current diff against AGENTS.md and docs/ACCEPTANCE_CHECKLIST.md. Look for Python dependencies, accidental non-React frontend framework drift, unnecessary state libraries besides Jotai, plaintext secret storage, hidden network calls, unlabeled estimates, platform-specific overlay regressions, and missing tests. Provide a prioritized issue list, then fix only the high-confidence issues.
```

## Release-readiness prompt

```text
Check whether the repository is ready for a public alpha release. Verify build commands, generated artifacts, README accuracy, privacy/security claims, and OS limitation notes. Do not overstate support for Windows virtual desktops or Wayland if not verified. Produce a concise release checklist with remaining blockers.
```

