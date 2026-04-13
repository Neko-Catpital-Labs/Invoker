#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="${1:---expect-failure}"
TMP_DIR="$(mktemp -d)"
DB_DIR="$TMP_DIR/invoker-home"
LOCK_DIR="$DB_DIR/invoker.db.lock"
STDOUT_LOG="$TMP_DIR/gui.stdout.log"
STDERR_LOG="$TMP_DIR/gui.stderr.log"

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${seconds}s" "$@"
    return
  fi
  perl -e 'alarm shift @ARGV; exec @ARGV' "$seconds" "$@"
}

cleanup() {
  if [[ -n "${LOCK_HOLDER_PID:-}" ]]; then
    kill "$LOCK_HOLDER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR" "$LOCK_DIR"
sleep 30 &
LOCK_HOLDER_PID=$!
printf '%s\n' "$LOCK_HOLDER_PID" > "$LOCK_DIR/pid"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

set +e
run_with_timeout 8 env \
  NODE_ENV=test \
  INVOKER_DB_DIR="$DB_DIR" \
  pnpm --filter @invoker/app exec electron dist/main.js \
  >"$STDOUT_LOG" 2>"$STDERR_LOG"
STATUS=$?
set -e

if [[ "$EXPECTATION" == "--expect-failure" ]]; then
  if grep -q 'Cannot acquire writer lock' "$STDERR_LOG"; then
    echo "repro: confirmed GUI launch fails while writer lock is held"
    echo "stderr:"
    cat "$STDERR_LOG"
    exit 0
  fi
  echo "repro: expected writer-lock launch failure, but did not observe it" >&2
elif [[ "$EXPECTATION" == "--expect-success" ]]; then
  if grep -q 'Cannot acquire writer lock' "$STDERR_LOG"; then
    echo "repro: GUI still failed on writer lock unexpectedly" >&2
  else
    echo "repro: confirmed GUI launch survives while writer lock is held"
    exit 0
  fi
else
  echo "usage: $0 [--expect-failure|--expect-success]" >&2
  exit 2
fi

echo "exit status: $STATUS" >&2
echo "stdout:" >&2
cat "$STDOUT_LOG" >&2 || true
echo "stderr:" >&2
cat "$STDERR_LOG" >&2 || true
exit 1
