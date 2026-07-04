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
#   Functions: log_line, cron_lock, claim_key, ledger_init, ledger_record,
#              ledger_count, ledger_marker_seen, ledger_max_marker, gh_json,
#              resolve_workflow_for_pr
#
# PR cron jobs acquire one shared slot from a bounded pool, then claim a single
# PR or stack before mutating it. That allows limited parallelism without two
# workers fixing the same branch at once.

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
CRON_MAX_CONCURRENCY="${INVOKER_PR_CRON_MAX_CONCURRENCY:-1}"
CLAIM_LOCK_ROOT="${INVOKER_PR_CLAIM_LOCK_ROOT:-${TMPDIR:-/tmp}/invoker-pr-claims}"
DRY_RUN="${INVOKER_PR_CRON_DRY_RUN:-0}"
# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# ---------------------------------------------------------------------------
# Shared cross-job slot pool. Each mutating cron run takes one slot, then claims
# one PR/stack before acting on it. Exits 0 (clean no-op) when no slot is free.
# ---------------------------------------------------------------------------

_cron_lock_reap_stale() {
  local lockdir="$1"
  local pid_file="$lockdir/pid"
  local holder=""
  [ -f "$pid_file" ] && holder="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$holder" ]; then
    kill -0 "$holder" 2>/dev/null && return 0
    rm -rf "$lockdir" 2>/dev/null || true
    return 0
  fi
  local max_age now mtime
  max_age="${INVOKER_PR_CRON_LOCK_STALE_SECS:-3600}"
  now="$(date +%s)"
  mtime="$(stat -f %m "$lockdir" 2>/dev/null || stat -c %Y "$lockdir" 2>/dev/null || echo "$now")"
  if [ "$((now - mtime))" -ge "$max_age" ]; then
    rm -rf "$lockdir" 2>/dev/null || true
  fi
}

_cron_try_flock_slot() {
  local slot_path="$1"
  local fd_var="$2"
  local fd
  exec {fd}>"$slot_path"
  if flock -n "$fd"; then
    printf -v "$fd_var" '%s' "$fd"
    return 0
  fi
  eval "exec ${fd}>&-"
  return 1
}

cron_lock() {
  local slots="${CRON_MAX_CONCURRENCY:-1}"
  if [ "$slots" -lt 1 ]; then
    slots=1
  fi

  if command -v flock >/dev/null 2>&1; then
    local idx slot_fd slot_path
    for idx in $(seq 1 "$slots"); do
      slot_path="${CRON_LOCK%.lock}.slot.${idx}.lock"
      if _cron_try_flock_slot "$slot_path" slot_fd; then
        CRON_SLOT_FD="$slot_fd"
        CRON_SLOT_PATH="$slot_path"
        return 0
      fi
    done
    log_line "all PR cron slots busy; exiting"
    exit 0
  fi

  local idx lockdir
  for idx in $(seq 1 "$slots"); do
    lockdir="${CRON_LOCK}.slot.${idx}.d"
    [ -d "$lockdir" ] && _cron_lock_reap_stale "$lockdir"
    if mkdir "$lockdir" 2>/dev/null; then
      printf '%s\n' "$$" > "$lockdir/pid"
      CRON_LOCK_DIR="$lockdir"
      trap 'rm -rf "'"$lockdir"'" 2>/dev/null || true' EXIT
      return 0
    fi
  done
  log_line "all PR cron slots busy; exiting"
  exit 0
}

claim_key() {
  local key="$1"
  local safe slot_path
  safe="$(python3 - "$key" <<'PY'
import hashlib, sys
print(hashlib.sha256((sys.argv[1] or '').encode()).hexdigest())
PY
)"
  mkdir -p "$CLAIM_LOCK_ROOT"
  slot_path="$CLAIM_LOCK_ROOT/$safe.lock"
  if command -v flock >/dev/null 2>&1; then
    local fd
    exec {fd}>"$slot_path"
    if ! flock -n "$fd"; then
      eval "exec ${fd}>&-"
      return 1
    fi
    CLAIM_FD="$fd"
    CLAIM_KEY="$key"
    return 0
  fi

  local lockdir="${slot_path}.d"
  [ -d "$lockdir" ] && _cron_lock_reap_stale "$lockdir"
  if ! mkdir "$lockdir" 2>/dev/null; then
    return 1
  fi
  printf '%s\n' "$$" > "$lockdir/pid"
  CLAIM_LOCK_DIR="$lockdir"
  CLAIM_KEY="$key"
  return 0
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
