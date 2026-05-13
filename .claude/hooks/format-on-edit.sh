#!/usr/bin/env bash
# Claude Code PostToolUse hook
# Edit/Write/MultiEdit 直後に、編集対象ファイルが oxfmt 対象拡張子なら in-place 整形する。
# JSON 解析は Node.js のみで行い、jq/Python に依存しない(AGENTS.md 方針)。

set -u

FILE=$(node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try { console.log(JSON.parse(d).tool_input?.file_path ?? ''); } catch {}
});
" 2>/dev/null)

case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json)
    cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
    pnpm exec oxfmt --no-error-on-unmatched-pattern -- "$FILE" >/dev/null 2>&1 || true
    ;;
esac

exit 0
