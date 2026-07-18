#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=../../../scripts/cron-pr-lib.sh
source "$(cd "$(dirname "$0")/../../.." && pwd)/scripts/cron-pr-lib.sh"

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
