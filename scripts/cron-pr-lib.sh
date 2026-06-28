#!/usr/bin/env bash
# Shared helpers for the two PR-maintenance cron jobs that run co-located with
# the Invoker owner:
#
#   scripts/cron-coderabbit-address.sh  (Job 1) — address new CodeRabbit reviews
#   scripts/cron-pr-conflict-rebase.sh  (Job 2) — rebase-recreate conflicting PRs
#
# Source this AFTER `set -euo pipefail`:
#   source "$(dirname "$0")/cron-pr-lib.sh"
#
# Provides:
#   Variables: REPO_ROOT, RUNNER, IPC_HELPER (from headless-lib.sh),
#              TARGET_REPO, PR_AUTHOR, CODERABBIT_LOGIN, CRON_LOCK, DRY_RUN
#   Functions: log_line, cron_lock, ledger_init, ledger_record, ledger_count,
#              ledger_marker_seen, ledger_max_marker, gh_json,
#              resolve_workflow_for_pr
#
# Both jobs run their mutating operation SYNCHRONOUSLY while holding a single
# shared lock, so only one PR cron operation runs at a time (the other exits
# this tick and retries in 5 min). The lock prefers flock (Linux owner host)
# and falls back to an atomic mkdir lock where flock is absent (e.g. macOS).

# headless-lib.sh: REPO_ROOT, RUNNER, IPC_HELPER, headless_query, ... It keys
# off ${BASH_SOURCE[0]} so it resolves correctly no matter the caller's cwd.
# shellcheck source=scripts/headless-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/headless-lib.sh"

# ---------------------------------------------------------------------------
# Configuration (all overridable via env)
# ---------------------------------------------------------------------------

TARGET_REPO="${INVOKER_GITHUB_TARGET_REPO:-Neko-Catpital-Labs/Invoker}"
PR_AUTHOR="${INVOKER_PR_CRON_AUTHOR:-EdbertChan}"
CODERABBIT_LOGIN="${INVOKER_CODERABBIT_LOGIN:-coderabbitai[bot]}"
CRON_LOCK="${INVOKER_PR_CRON_LOCK:-${TMPDIR:-/tmp}/invoker-pr-crons.lock}"
DRY_RUN="${INVOKER_PR_CRON_DRY_RUN:-0}"

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# ---------------------------------------------------------------------------
# Shared cross-job lock (decision 3): one PR cron operation at a time.
# Exits 0 (clean no-op) when the other job holds the lock.
# ---------------------------------------------------------------------------

_cron_lock_reap_stale() {
  # Steal a mkdir lock ONLY when its holder is gone AND the lock has gone stale
  # by age. The holder records its PID in the lock dir and a background heartbeat
  # refreshes the dir mtime, so a healthy long run is never reaped no matter how
  # long it takes — age alone must never break mutual exclusion. We therefore
  # require BOTH a dead PID and an expired mtime before reaping. flock has no
  # such risk (the kernel releases the fd), so this only applies to the mkdir path.
  local lockdir="$1"
  local pid_file="$lockdir/pid"
  local holder="" max_age now mtime
  [ -f "$pid_file" ] && holder="$(cat "$pid_file" 2>/dev/null || true)"
  # Holder still alive — never reap, regardless of mtime/age.
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    return 0
  fi
  # Holder dead (or no PID recorded): reap only once past the staleness window.
  max_age="${INVOKER_PR_CRON_LOCK_STALE_SECS:-3600}"
  now="$(date +%s)"
  # GNU `stat -c %Y` first (Linux owner host), BSD `stat -f %m` as the fallback;
  # the BSD form first would mis-parse on GNU (-f means --file-system there).
  mtime="$(stat -c %Y "$lockdir" 2>/dev/null || stat -f %m "$lockdir" 2>/dev/null || echo "$now")"
  if [ "$((now - mtime))" -ge "$max_age" ]; then
    rm -rf "$lockdir" 2>/dev/null || true
  fi
}

cron_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$CRON_LOCK"
    if ! flock -n 9; then
      log_line "another PR cron operation in progress; exiting"
      exit 0
    fi
    return 0
  fi

  # Portable fallback: atomic mkdir lock, reaped only when its holder PID is dead
  # AND the lock is stale by age (see _cron_lock_reap_stale).
  local lockdir="${CRON_LOCK}.d"
  [ -d "$lockdir" ] && _cron_lock_reap_stale "$lockdir"
  if ! mkdir "$lockdir" 2>/dev/null; then
    log_line "another PR cron operation in progress; exiting"
    exit 0
  fi
  printf '%s\n' "$$" > "$lockdir/pid"
  CRON_LOCK_DIR="$lockdir"
  # Heartbeat: refresh the lock dir mtime every ~60s so a healthy long-running
  # job keeps the lock fresh and is never reaped on age (mutual exclusion holds
  # even for runs longer than INVOKER_PR_CRON_LOCK_STALE_SECS).
  ( while :; do sleep 60; touch "$lockdir" 2>/dev/null || exit 0; done ) &
  local hb_pid=$!
  CRON_LOCK_HEARTBEAT_PID="$hb_pid"
  # Release on exit: stop the heartbeat, drop our PID file, then remove the dir.
  # shellcheck disable=SC2064
  trap 'kill "'"$hb_pid"'" 2>/dev/null || true; rm -f "'"$lockdir"'/pid" 2>/dev/null || true; rmdir "'"$lockdir"'" 2>/dev/null || true' EXIT
}

# ---------------------------------------------------------------------------
# Durable attempt ledger (append-only TSV: kind \t key \t marker \t epoch).
# One file per job; both under ~/.invoker. Markers are opaque strings:
#   Job 1 records a comment's ISO-8601 updated_at; Job 2 records a generation.
# ---------------------------------------------------------------------------

LEDGER=""

ledger_init() {
  LEDGER="${1:?ledger path required}"
  mkdir -p "$(dirname "$LEDGER")"
  touch "$LEDGER"
}

ledger_record() {
  # ledger_record <kind> <key> <marker>
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(date +%s)" >> "$LEDGER"
}

ledger_count() {
  # ledger_count <kind> <key> [marker] -> rows matching kind+key, and the marker
  # too when given. The marker scope keeps an attempt cap per feedback-batch
  # (comment timestamp / workflow generation) instead of per-PR-lifetime, so a
  # newer batch gets a fresh budget while repeats of the same batch stay capped.
  awk -F '\t' -v k="$1" -v key="$2" -v m="${3-}" -v has_m="${3+1}" \
    '$1 == k && $2 == key && (has_m == "" || $3 == m) { c++ } END { print c + 0 }' "$LEDGER"
}

ledger_marker_seen() {
  # ledger_marker_seen <kind> <key> <marker> -> exit 0 if that exact marker recorded
  awk -F '\t' -v k="$1" -v key="$2" -v m="$3" \
    '$1 == k && $2 == key && $3 == m { f = 1 } END { exit f ? 0 : 1 }' "$LEDGER"
}

ledger_max_marker() {
  # ledger_max_marker <kind> <key> -> the lexical/numeric max marker recorded
  # (empty when none). ISO-8601 timestamps sort lexically == chronologically.
  awk -F '\t' -v k="$1" -v key="$2" \
    '$1 == k && $2 == key { if (m == "" || $3 > m) m = $3 } END { print m }' "$LEDGER"
}

# ---------------------------------------------------------------------------
# GitHub helper: run `gh` with one retry on transient failure. Callers pass
# `--repo "$TARGET_REPO"` (gh pr ...) or embed the repo in the api path.
# ---------------------------------------------------------------------------

gh_json() {
  local out code
  set +e
  out="$(gh "$@" 2>&1)"
  code=$?
  if [ "$code" -ne 0 ]; then
    sleep 2
    out="$(gh "$@" 2>&1)"
    code=$?
  fi
  set -e
  if [ "$code" -ne 0 ]; then
    log_line "gh failed (gh $*): $out" >&2
    return "$code"
  fi
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# Resolve a PR number to its Invoker workflow via the read-only review-gate
# query (Step 1). On success it echoes the JSON record, or `{}` for a genuine
# miss (review-gate exits 0 with `{}` when no workflow matches). A real
# lookup/runtime failure propagates a NON-ZERO exit so callers can tell
# "no local workflow" apart from "the lookup path is broken" instead of
# silently skipping eligible PRs. A test seam (INVOKER_PR_CRON_REVIEW_GATE_CMD)
# lets repros stub it without a built dist.
# ---------------------------------------------------------------------------

resolve_workflow_for_pr() {
  local pr="$1"
  if [ -n "${INVOKER_PR_CRON_REVIEW_GATE_CMD:-}" ]; then
    "$INVOKER_PR_CRON_REVIEW_GATE_CMD" "$pr"
    return
  fi
  headless_query query review-gate "$pr" --output json
}
