#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-normalize-blocked-dirty-pycache.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

WORK="$TMP/work"
mkdir -p "$WORK/scripts"
cp scripts/*.py "$WORK/scripts/"

git -C "$WORK" init -q
git -C "$WORK" add scripts
git -C "$WORK" -c user.name=repro -c user.email=repro@example.invalid commit -q -m "fixture"

START_HEAD="$(git -C "$WORK" rev-parse HEAD)"
STATE_FILE="$TMP/ledger.jsonl"

run_normalize() {
  (
    cd "$WORK"
    env -u PYTHONDONTWRITEBYTECODE -u PYTHONPYCACHEPREFIX python3 \
      scripts/mergify_admin_requeue_repair_normalize.py \
      --repo Neko-Catpital-Labs/Invoker \
      --pr 7560 \
      --check "PR Body" \
      --start-head "$START_HEAD" \
      --base master \
      --trunk master \
      --state-file "$STATE_FILE"
  )
}

clean_stdout="$TMP/clean.stdout"
clean_stderr="$TMP/clean.stderr"
if ! run_normalize >"$clean_stdout" 2>"$clean_stderr"; then
  printf '[repro] clean noop normalize unexpectedly failed\n' >&2
  printf '%s\n' '--- stdout ---' >&2
  cat "$clean_stdout" >&2
  printf '%s\n' '--- stderr ---' >&2
  cat "$clean_stderr" >&2
  exit 1
fi

if ! grep -qx "noop: repair task made no commit" "$clean_stdout"; then
  printf '[repro] clean noop normalize did not report noop\n' >&2
  printf '%s\n' '--- stdout ---' >&2
  cat "$clean_stdout" >&2
  exit 1
fi

dirty_after_clean="$(git -C "$WORK" status --porcelain)"
if [[ -n "$dirty_after_clean" ]]; then
  printf '[repro] clean noop normalize dirtied the worktree\n' >&2
  printf '%s\n' "$dirty_after_clean" >&2
  exit 1
fi

touch "$WORK/dirty-sentinel.txt"
dirty_stdout="$TMP/dirty.stdout"
dirty_stderr="$TMP/dirty.stderr"
if run_normalize >"$dirty_stdout" 2>"$dirty_stderr"; then
  printf '[repro] dirty normalize unexpectedly succeeded\n' >&2
  exit 1
fi

if ! grep -q "blocked_dirty" "$dirty_stderr"; then
  printf '[repro] dirty normalize did not report blocked_dirty\n' >&2
  printf '%s\n' '--- stderr ---' >&2
  cat "$dirty_stderr" >&2
  exit 1
fi

if ! grep -q "?? dirty-sentinel.txt" "$dirty_stderr"; then
  printf '[repro] blocked_dirty did not name the dirty path\n' >&2
  printf '%s\n' '--- stderr ---' >&2
  cat "$dirty_stderr" >&2
  exit 1
fi

echo "[repro] passed: clean noop normalizes to noop; blocked_dirty names the dirty path"
