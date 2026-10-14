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

pid_is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

pid_is_invoker_owner() {
  local pid="$1"
  local command_line=""
  pid_is_alive "$pid" || return 1
  command_line="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [ -n "$command_line" ] || return 1
  printf '%s\n' "$command_line" | grep -Eqi 'invoker|electron|main\.js'
}

remove_stale_db_lock() {
  local lock_dir="$1"
  local pid=""
  [ -d "$lock_dir" ] || return 0
  pid="$(cat "${lock_dir}/pid" 2>/dev/null || true)"
  if pid_is_alive "$pid" && pid_is_invoker_owner "$pid"; then
    return 1
  fi
  rm -rf "$lock_dir"
  return 0
}

# Mirror the identity regex from setup-agent-skills.sh so drift fails this test.
setup_regex="$(
  grep -E "grep -Eqi 'invoker\|electron\|main\\\\.js'" "$SETUP" || true
)"
[ -n "$setup_regex" ] || fail "could not find pid_is_invoker_owner grep pattern in setup-agent-skills.sh"

pid_is_invoker_owner "$SLEEP_PID" && fail "sleep pid should not classify as an Invoker owner"

remove_stale_db_lock "$LOCK_DIR" || fail "non-Invoker live pid should be treated as a stale lock"

if ! kill -0 "$SLEEP_PID" 2>/dev/null; then
  fail "remove_stale_db_lock must not signal a non-Invoker pid"
fi
[ ! -d "$LOCK_DIR" ] || fail "stale lock dir should be removed"

echo "PASS: setup-agent-skills.sh builds contracts before DB resolve and ignores non-Invoker lock pids"
