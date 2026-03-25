#!/usr/bin/env bash
# Run a command in a new process group; if host memory-used % stays above threshold for
# several consecutive samples, SIGTERM the whole group. Best-effort proxy: Node os.totalmem/freemem.
#
# Usage (from repo root):
#   bash scripts/run-with-resource-guard.sh env VAR=value pnpm -r test
#
# Tuning:
#   INVOKER_VITEST_MEM_GUARD_PCT (default 80)
#   INVOKER_VITEST_MEM_GUARD_INTERVAL seconds (default 2)
#   INVOKER_VITEST_MEM_GUARD_STREAK consecutive trips (default 3)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

THRESHOLD="${INVOKER_VITEST_MEM_GUARD_PCT:-80}"
INTERVAL="${INVOKER_VITEST_MEM_GUARD_INTERVAL:-2}"
STREAK="${INVOKER_VITEST_MEM_GUARD_STREAK:-3}"

mem_used_pct() {
  node -e "const o=require('os');const t=o.totalmem();if(!t){process.stdout.write('0');process.exit(0);}process.stdout.write(String(Math.min(100,Math.round(100*(t-o.freemem())/t))));"
}

if command -v setsid >/dev/null 2>&1; then
  setsid "$@" &
  pid=$!
elif command -v python3 >/dev/null 2>&1; then
  python3 -c 'import os, sys; os.setpgrp(); os.execvp(sys.argv[1], sys.argv[1:])' "$@" &
  pid=$!
else
  echo "run-with-resource-guard: need setsid(1) or python3 for process-group kill" >&2
  exit 1
fi

hits=0

cleanup() {
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM -"$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}
trap cleanup INT TERM

while kill -0 "$pid" 2>/dev/null; do
  pct="$(mem_used_pct)"
  if [ "$pct" -gt "$THRESHOLD" ]; then
    hits=$((hits + 1))
    echo "run-with-resource-guard: memory used ~${pct}% (threshold ${THRESHOLD}%, streak ${hits}/${STREAK})" >&2
  else
    hits=0
  fi
  if [ "$hits" -ge "$STREAK" ]; then
    echo "run-with-resource-guard: threshold exceeded ${STREAK} times; SIGTERM to process group ${pid}" >&2
    kill -TERM -"$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    trap - INT TERM
    exit 124
  fi
  sleep "$INTERVAL"
done

wait "$pid"
code=$?
trap - INT TERM
exit "$code"
