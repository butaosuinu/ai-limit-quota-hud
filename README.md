# QuotaHUD agent instruction pack

This pack is meant to be copied into the root of a new or existing repository before using Codex CLI or Claude Code.

Files:

- `AGENTS.md`: durable instructions for Codex CLI and general coding agents.
- `CLAUDE.md`: Claude Code entrypoint that imports `AGENTS.md`.
- `docs/PROJECT_SPEC.md`: detailed product/architecture/build specification.
- `docs/ACCEPTANCE_CHECKLIST.md`: phase and release acceptance checklist.
- `docs/IMPLEMENTATION_PROMPTS.md`: prompts to run phase-by-phase in Codex CLI or Claude Code.

Suggested use:

```bash
# From the target repository root:
cp -R path/to/ai-quota-overlay-agent-pack/* .

# Codex CLI
codex
# Then paste the Initial setup prompt from docs/IMPLEMENTATION_PROMPTS.md

# Claude Code
claude
# Then paste the Initial setup prompt from docs/IMPLEMENTATION_PROMPTS.md
```

Primary constraints:

- Tauri 2 desktop app.
- Rust + TypeScript/React/Vite.
- React frontend; do not substitute Svelte unless the project owner changes this requirement.
- Use Jotai for shared frontend state when needed.
- No Python dependency.
- Cross-platform distributable artifacts.
- Transparent always-visible overlay.
- Honest confidence/source labeling for all usage values.
