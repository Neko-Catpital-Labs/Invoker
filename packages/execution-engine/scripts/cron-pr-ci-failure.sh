#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../../scripts/headless-lib.sh
source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/headless-lib.sh"

TARGET_REPO="${INVOKER_GITHUB_TARGET_REPO:-Neko-Catpital-Labs/Invoker}"
CRON_LOCK="${INVOKER_PR_CRON_LOCK:-${TMPDIR:-/tmp}/invoker-pr-crons.lock}"

log_line() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

cron_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$CRON_LOCK"
    if ! flock -n 9; then
      log_line "another PR maintenance operation in progress; exiting"
      exit 0
    fi
    return 0
  fi

  log_line "flock is required for pr-ci-failure-scan locking"
  exit 1
}

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

cron_lock

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --state open \
  --json number,mergeable,mergeStateStatus --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

failures=0
processed=0
while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"
  mergeable="$(jq -r '.mergeable // ""' <<<"$pr")"
  merge_state="$(jq -r '.mergeStateStatus // ""' <<<"$pr")"

  if [ "$merge_state" = "DIRTY" ] || [ "$mergeable" = "CONFLICTING" ]; then
    log_line "PR #$num: skip conflicted PR; rebase worker owns it"
    continue
  fi

  if ! output="$(headless_mutation repair-review-gate-ci "$num" 2>&1)"; then
    failures=1
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log_line "PR #$num: $line"
    done <<<"$output"
    continue
  fi

  processed=$((processed + 1))
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    log_line "PR #$num: $line"
  done <<<"$output"
done < <(jq -c '.[]' <<<"$prs_json")

log_line "PR CI scan processed $processed open PRs"
[ "$failures" -eq 0 ]
