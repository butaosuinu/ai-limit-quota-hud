#!/usr/bin/env bash
# Stop hook: run lint / typecheck / test / cargo test in parallel, aggregate.
set -u

INPUT="$(cat)"
if printf '%s' "$INPUT" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR="$(printf '%s' "$INPUT" | node -e "
let d='';
process.stdin.on('data', c => d += c);
process.stdin.on('end', () => {
  try {
    const cwd = JSON.parse(d).cwd;
    if (typeof cwd === 'string') console.log(cwd);
  } catch {}
});
" 2>/dev/null)"
fi
PROJECT_DIR="${PROJECT_DIR:-$PWD}"

cd "$PROJECT_DIR" || {
  echo "Stop hook: failed to cd to project dir=$PROJECT_DIR" >&2
  exit 2
}

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
# tauri::generate_context!() validates frontendDist (../dist) at compile time, so
# cargo test needs the bundle present. Build on demand; skip when already there.
run cargo      bash -c '
  set -e
  if [ ! -f dist/index.html ]; then
    pnpm exec vite build
  fi
  cargo test --manifest-path src-tauri/Cargo.toml
'

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
