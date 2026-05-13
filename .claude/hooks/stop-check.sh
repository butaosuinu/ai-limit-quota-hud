#!/usr/bin/env bash
# Stop hook: run lint / typecheck / test / cargo test in parallel, aggregate.
set -u

INPUT="$(cat)"
if printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:?CLAUDE_PROJECT_DIR not set}" || exit 0

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

run() {
  local name="$1"; shift
  ( "$@" ) >"$TMP/$name.out" 2>&1 &
  echo $! >"$TMP/$name.pid"
}

run lint       pnpm lint
run typecheck  pnpm typecheck
run test       pnpm test
run cargo      cargo test --manifest-path src-tauri/Cargo.toml

FAILED=0
SUMMARY=""
for name in lint typecheck test cargo; do
  pid="$(cat "$TMP/$name.pid")"
  if wait "$pid"; then
    status="PASS"
  else
    status="FAIL"
    FAILED=1
  fi
  SUMMARY+="  [$status] $name"$'\n'
  {
    echo "===== $status: $name ====="
    cat "$TMP/$name.out"
    echo
  } >&2
done

echo "----- Stop hook summary -----" >&2
printf '%s' "$SUMMARY" >&2

[ "$FAILED" -eq 0 ] && exit 0

echo "One or more checks failed. Fix the errors above before stopping." >&2
exit 2
