#!/usr/bin/env bash
# CodeRabbit PR #3042: run_with_optional_timeout's python fallback only times
# out the DIRECT child, not its descendants.
#
# GNU `timeout` runs the command in a fresh process group and signals the whole
# group on expiry, so descendants are reaped. The python fallback in
# scripts/headless-lib.sh used subprocess.run(timeout=...), which SIGKILLs only
# the immediate child on TimeoutExpired — any grandchildren keep running as
# orphans. The master-head cron relies on this helper to stop stuck test runs,
# so a leaked descendant defeats the timeout guard this PR adds.
#
# This exercises the REAL helper with a PATH that hides timeout/gtimeout (so the
# python fallback is chosen), running a command that backgrounds a long-lived
# grandchild. After the timeout fires the grandchild must be dead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

command -v python3 >/dev/null 2>&1 || { echo "[repro] SKIP: python3 unavailable"; exit 0; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr3042-timeout.XXXXXX")"
GRANDCHILD_PID=""
cleanup() {
  [ -n "$GRANDCHILD_PID" ] && kill -KILL "$GRANDCHILD_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; exit 1; }

# Minimal PATH that provides the interpreters the fallback needs (python3, bash,
# sleep) but NOT timeout/gtimeout, forcing run_with_optional_timeout down the
# python branch.
BIN="$TMP/bin"
mkdir -p "$BIN"
for t in python3 bash sleep env; do
  src="$(command -v "$t" || true)"
  [ -n "$src" ] || fail "required tool '$t' not found on PATH"
  ln -s "$src" "$BIN/$t"
done

# shellcheck source=scripts/headless-lib.sh
source "$ROOT/scripts/headless-lib.sh"

PIDFILE="$TMP/grandchild.pid"

# Command: background a long-lived grandchild, record its pid, then block. The
# direct child (bash) is what the fallback can see; the sleep is a descendant.
CMD='sleep 600 & echo $! > "'"$PIDFILE"'"; wait'

(
  export PATH="$BIN"
  # Defensively drop any loadable builtins so `command -v timeout` misses.
  enable -n timeout gtimeout 2>/dev/null || true
  command -v timeout >/dev/null 2>&1 && { echo "[repro] SETUP-FAIL: timeout still visible" >&2; exit 3; }
  run_with_optional_timeout 2 bash -c "$CMD"
) >/dev/null 2>&1 || true

# Give the fallback a moment to signal the process group.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -s "$PIDFILE" ] && break
  sleep 0.2
done
[ -s "$PIDFILE" ] || fail "grandchild never recorded its pid; scenario did not run"
GRANDCHILD_PID="$(cat "$PIDFILE")"

sleep 1
if kill -0 "$GRANDCHILD_PID" 2>/dev/null; then
  fail "grandchild ($GRANDCHILD_PID) survived the timeout; descendants leak past run_with_optional_timeout"
fi

echo "[repro] PASS: timeout fallback reaped the whole process group (no leaked descendant)."
