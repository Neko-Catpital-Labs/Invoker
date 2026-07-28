#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

MAX_REBASE_ATTEMPTS="${INVOKER_PR_REBASE_MAX_ATTEMPTS:-3}"
CONFIRM_TIMEOUT="${INVOKER_PR_REBASE_CONFIRM_TIMEOUT:-120}"
STATE_FILE="${INVOKER_PR_CONFLICT_STATE_FILE:-${HOME}/.invoker/pr-conflict-rebase-submissions.tsv}"

cron_lock
ledger_init "$STATE_FILE"

flag_exhausted() {
  # flag_exhausted <prNumber> <workflowId>
  local num="$1" wf="$2"
  ledger_marker_seen rebase-recreate-flagged "$wf" exhausted && return 0
  local body="Invoker conflict-rebase cron gave up after ${MAX_REBASE_ATTEMPTS} rebase-recreate attempts; this PR still conflicts and needs manual attention."
  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would post 'exhausted' comment and flag workflow $wf"
    return 0
  fi
  # Only record the one-time flag if the comment actually posted; otherwise a
  # transient GitHub failure would permanently suppress the manual-attention ping.
  if gh_json pr comment "$num" --repo "$TARGET_REPO" --body "$body" >/dev/null; then
    ledger_record rebase-recreate-flagged "$wf" exhausted
  else
    log_line "PR #$num: exhausted-comment post failed (non-fatal); will retry the flag next tick"
  fi
}

dispatch_rebase_recreate() {
  # dispatch_rebase_recreate <prNumber> <workflowId> <generation>; exits the script.
  local num="$1" wf="$2" gen="$3"
  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would rebase-recreate $wf (generation $gen)"
    exit 0
  fi

  log_line "PR #$num: rebase-recreate $wf (generation $gen)"
  if ! node "$IPC_HELPER" exec -- rebase-recreate "$wf"; then
    log_line "PR #$num: rebase-recreate dispatch failed; retry next tick"
    exit 1
  fi
  # Count the accepted dispatch so a non-idempotent rebase-recreate that is
  # accepted but never advances generation still hits the cap, instead of
  # re-firing every tick. The cap below counts attempts, not just confirmations.
  ledger_record rebase-recreate-attempt "$wf" "$gen"

  # Confirm the recreate actually landed: generation must advance past $gen.
  local deadline newgen
  deadline="$(( $(date +%s) + CONFIRM_TIMEOUT ))"
  while [ "$(date +%s)" -lt "$deadline" ]; do
    # Tolerate a transient query/jq failure (set -e would otherwise abort the
    # whole worker mid-confirmation); just keep polling until the deadline.
    newgen="$("$RUNNER" --headless query workflow "$wf" --output json 2>/dev/null | jq -r '.generation // empty' 2>/dev/null || true)"
    if [ -n "$newgen" ] && [ "$newgen" -gt "$gen" ]; then
      ledger_record rebase-recreate "$wf" "$gen"
      log_line "PR #$num: rebase-recreate confirmed (generation $gen -> $newgen)"
      exit 0
    fi
    sleep 5
  done
  log_line "PR #$num: rebase-recreate not confirmed within ${CONFIRM_TIMEOUT}s; not recording (retry next tick)"
  exit 1
}

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --author "$PR_AUTHOR" --state open \
  --json number,headRefName,mergeable,mergeStateStatus --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

# Process substitution (not a pipe) keeps the loop in this shell so `exit`
# after the single per-tick operation terminates the script.
while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"

  if ! rec="$(resolve_workflow_for_pr "$num")"; then
    log_line "PR #$num: review-gate lookup failed; skip (retry next tick)"
    continue
  fi
  wf="$(jq -r '.workflowId // empty' <<<"$rec" 2>/dev/null || true)"
  if [ -z "$wf" ]; then
    log_line "PR #$num: no local workflow; skip"
    continue
  fi
  gen="$(jq -r '.workflowGeneration // 0' <<<"$rec")"

  # (c) per-(workflow, generation) dedup.
  if ledger_marker_seen rebase-recreate "$wf" "$gen"; then
    log_line "PR #$num: rebase-recreate already fired for generation $gen; skip"
    continue
  fi

  # (e) per-generation attempt cap + one-time GitHub flag. Counts accepted
  # dispatches for THIS generation (rebase-recreate-attempt), so a dispatch that
  # is accepted but never confirms still counts toward the cap instead of
  # re-firing forever, while a genuinely new conflict (new generation) gets a
  # fresh budget.
  if [ "$(ledger_count rebase-recreate-attempt "$wf" "$gen")" -ge "$MAX_REBASE_ATTEMPTS" ]; then
    log_line "PR #$num: giving up — rebase-recreate hit cap of $MAX_REBASE_ATTEMPTS for workflow $wf"
    flag_exhausted "$num" "$wf"
    continue
  fi

  # (f) dispatch the single operation for this tick, then exit.
  dispatch_rebase_recreate "$num" "$wf" "$gen"
done < <(jq -c '.[] | select(.mergeStateStatus == "DIRTY" or .mergeable == "CONFLICTING")' <<<"$prs_json")

log_line "no actionable conflicting PRs this tick"
