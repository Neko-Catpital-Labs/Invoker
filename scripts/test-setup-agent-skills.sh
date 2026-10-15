#!/usr/bin/env bash
# Static + behavioral checks for scripts/setup-agent-skills.sh (CodeRabbit PR #15464).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SETUP="$ROOT/scripts/setup-agent-skills.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

grep -q 'pnpm --filter @invoker/contracts build' "$SETUP" || {
  fail "setup-agent-skills.sh must build @invoker/contracts before resolve_checkout_db_path"
}

contracts_line="$(grep -n 'pnpm --filter @invoker/contracts build' "$SETUP" | head -1 | cut -d: -f1)"
resolve_line="$(grep -n 'resolve_checkout_db_path()' "$SETUP" | head -1 | cut -d: -f1)"
if [ -z "$contracts_line" ] || [ -z "$resolve_line" ] || [ "$contracts_line" -ge "$resolve_line" ]; then
  fail "contracts build must appear before resolve_checkout_db_path in setup-agent-skills.sh"
fi

grep -q 'pid_is_invoker_owner' "$SETUP" || {
  fail "setup-agent-skills.sh must verify lock PIDs with pid_is_invoker_owner"
}

# Behavioral: a live non-Invoker pid in a fake lock must not be signaled.
TMP="$(mktemp -d "${TMPDIR:-/tmp}/setup-agent-skills-pid.XXXXXX")"
SLEEP_PID=""
cleanup() {
  if [ -n "${SLEEP_PID}" ]; then
    kill "$SLEEP_PID" 2>/dev/null || true
    wait "$SLEEP_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

sleep 120 &
SLEEP_PID=$!
LOCK_DIR="$TMP/invoker.db.lock"
mkdir -p "$LOCK_DIR"
printf '%s\n' "$SLEEP_PID" >"$LOCK_DIR/pid"

REPO_ROOT="$ROOT"
eval "$(sed -n '/^pid_is_alive()/,/^}/p' "$SETUP")"
eval "$(sed -n '/^pid_is_invoker_owner()/,/^}/p' "$SETUP")"
eval "$(sed -n '/^remove_stale_db_lock()/,/^}/p' "$SETUP")"

grep -Fq 'packages/app/dist/main.js' "$SETUP" || fail "pid_is_invoker_owner must match packages/app/dist/main.js"
grep -Fq '*"$REPO_ROOT"*' "$SETUP" || fail "pid_is_invoker_owner must match processes under REPO_ROOT"

pid_is_invoker_owner "$SLEEP_PID" && fail "sleep pid should not classify as an Invoker owner"

remove_stale_db_lock "$LOCK_DIR" || fail "non-Invoker live pid should be treated as a stale lock"

if ! kill -0 "$SLEEP_PID" 2>/dev/null; then
  fail "remove_stale_db_lock must not signal a non-Invoker pid"
fi
[ ! -d "$LOCK_DIR" ] || fail "stale lock dir should be removed"

echo "PASS: setup-agent-skills.sh builds contracts before DB resolve and ignores non-Invoker lock pids"
