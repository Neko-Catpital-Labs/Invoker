#!/usr/bin/env bash
# Regression proof for the admin-bypass queue stdin-consumption bug.
#
# scripts/cron-admin-bypass-queue.sh iterates open PRs with a `while read` loop
# fed by a process substitution. Commands inside the loop (gh, jq, node via
# headless_mutation) read stdin, so a loop reading from stdin is truncated to
# its first item and every later PR is silently dropped. The fix reads the loop
# over a dedicated file descriptor (fd 3).
#
# This proof fails on the buggy pattern and passes on the fixed pattern, and it
# guards the real cron script so the fd-3 redirection cannot regress.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/cron-admin-bypass-queue.sh"
fail() { echo "[repro] FAIL: $1"; exit 1; }

# 1) Behavioral demonstration. An inner stdin-reading command drains a naive
#    `while read < <(...)` loop after the first item, but cannot touch a loop
#    that reads over fd 3.
items=$'a\nb\nc'

naive=0
while IFS= read -r _; do
  naive=$((naive + 1))
  cat >/dev/null   # inner command that drains stdin, like gh/jq/node
done < <(printf '%s\n' "$items")
[ "$naive" -eq 1 ] || fail "naive stdin loop should process only 1 item, got $naive"

fixed=0
while IFS= read -r -u 3 _; do
  fixed=$((fixed + 1))
  cat >/dev/null
done 3< <(printf '%s\n' "$items")
[ "$fixed" -eq 3 ] || fail "fd-3 loop should process all 3 items, got $fixed"

# 2) Regression guard. The real cron script must read its PR loop over fd 3, so
#    an inner gh/jq/node call can never truncate the PR scan again.
[ -f "$SCRIPT" ] || fail "cannot find $SCRIPT"
grep -Eq 'while IFS= read -r -u 3 pr; do' "$SCRIPT" \
  || fail "cron-admin-bypass-queue.sh must read the PR loop over fd 3 (read -r -u 3 pr)"
grep -Eq 'done 3< <\(jq -c ' "$SCRIPT" \
  || fail "cron-admin-bypass-queue.sh must feed the PR loop via fd 3 (done 3< <(jq ...))"

echo "[repro] passed"
