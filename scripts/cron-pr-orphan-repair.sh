#!/usr/bin/env bash
set -euo pipefail

# Orphan-PR repair cron — owns open PRs that have NO Invoker workflow mapping
# and are not already owned by the admin-bypass path. `pr-admin-bypass-land`
# owns mapped/admin-bypass repairs (failed checks, conflicts, bot threads, and
# landable stacks); this job is its counterpart for unmapped broken PRs. It
# classifies EVERYTHING blocking an unmapped PR (merge conflict, failing
# required checks, changes-requested review) into one combined brief and
# submits ONE real Invoker repair task via the owner's `run` command. One task
# per broken head-state: the ledger fingerprints (headOid + blockers) so a tick
# never re-submits the same breakage, and an attempt cap posts a single "gave
# up" PR comment before going quiet.
#
# Coordination contract:
#   - mapped/admin-bypass PRs -> skipped here; admin-bypass-land owns them
#   - unmapped broken PRs     -> owned here
#   - unmapped clean PRs      -> nobody's business
#
# Env (all optional):
#   INVOKER_PR_ORPHAN_STATE_FILE    ledger path   (default ~/.invoker/pr-orphan-repair.tsv)
#   INVOKER_PR_ORPHAN_MAX_ATTEMPTS  attempt cap per fingerprint (default 3)
#   INVOKER_PR_CRON_DRY_RUN=1       log the plan instead of submitting

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

STATE_FILE="${INVOKER_PR_ORPHAN_STATE_FILE:-$HOME/.invoker/pr-orphan-repair.tsv}"
MAX_ATTEMPTS="${INVOKER_PR_ORPHAN_MAX_ATTEMPTS:-3}"
ledger_init "$STATE_FILE"

# Repros pass INVOKER_PR_ORPHAN_PLAN_DIR to inspect submitted plans; a
# caller-provided dir is never cleaned up here.
if [ -n "${INVOKER_PR_ORPHAN_PLAN_DIR:-}" ]; then
  PLAN_DIR="$INVOKER_PR_ORPHAN_PLAN_DIR"
  mkdir -p "$PLAN_DIR"
else
  PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-orphan-plans.XXXXXX")"
  trap 'rm -rf "$PLAN_DIR"' EXIT
fi

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --author "$PR_AUTHOR" --state open \
  --json number,title,url,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision,labels \
  --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

submitted=0
while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"

  if [ "$(jq -r '.isDraft' <<<"$pr")" = "true" ]; then
    continue
  fi

  if jq -e '.labels[]? | select(.name == "admin-bypass")' <<<"$pr" >/dev/null; then
    log_line "PR #$num: admin-bypass labeled; admin-bypass-land owns it"
    continue
  fi

  # Mapped PRs belong to the existing per-symptom workers.
  wf=""
  if rec="$(resolve_workflow_for_pr "$num")"; then
    wf="$(jq -r '.workflowId // empty' <<<"$rec" 2>/dev/null || true)"
  fi
  if [ -n "$wf" ]; then
    log_line "PR #$num: mapped to workflow $wf; existing workers own it"
    continue
  fi

  # ── Classify blockers (conflict first, then CI, then review) ──
  blockers=()
  mergeable="$(jq -r '.mergeable // ""' <<<"$pr")"
  merge_state="$(jq -r '.mergeStateStatus // ""' <<<"$pr")"
  if [ "$mergeable" = "CONFLICTING" ] || [ "$merge_state" = "DIRTY" ]; then
    blockers+=("conflict: GitHub reports a merge conflict against $(jq -r '.baseRefName' <<<"$pr")")
  fi
  failed_checks="$(jq -r '[.statusCheckRollup[]? | select((.conclusion // "") as $c
    | $c == "FAILURE" or $c == "ERROR" or $c == "TIMED_OUT" or $c == "CANCELLED")
    | .name] | unique | join(", ")' <<<"$pr")"
  if [ -n "$failed_checks" ]; then
    blockers+=("failed_checks: $failed_checks")
  fi
  if [ "$(jq -r '.reviewDecision // ""' <<<"$pr")" = "CHANGES_REQUESTED" ]; then
    blockers+=("changes_requested: a reviewer requested changes; address the open feedback")
  fi
  if [ "${#blockers[@]}" -eq 0 ]; then
    continue
  fi

  head_oid="$(jq -r '.headRefOid' <<<"$pr")"
  fingerprint="$(printf '%s|%s' "$head_oid" "$(printf '%s;' "${blockers[@]}")" \
    | shasum -a 256 2>/dev/null || printf '%s|%s' "$head_oid" "$(printf '%s;' "${blockers[@]}")" | sha256sum)"
  fingerprint="${fingerprint%% *}"
  fingerprint="${fingerprint:0:16}"

  if ledger_marker_seen orphan-submitted "$num" "$fingerprint"; then
    log_line "PR #$num: repair already submitted for this head-state ($fingerprint); waiting"
    continue
  fi
  if [ "$(ledger_count orphan-attempt "$num" "$fingerprint")" -ge "$MAX_ATTEMPTS" ]; then
    if ! ledger_marker_seen orphan-exhausted "$num" "$fingerprint"; then
      ledger_record orphan-exhausted "$num" "$fingerprint"
      gh pr comment "$num" --repo "$TARGET_REPO" \
        --body "Invoker orphan-repair gave up after $MAX_ATTEMPTS repair-task attempts for this head state. Blockers: $(printf '%s; ' "${blockers[@]}")" \
        >/dev/null 2>&1 || true
      log_line "PR #$num: attempt cap reached ($MAX_ATTEMPTS); posted exhausted comment"
    fi
    continue
  fi

  title="$(jq -r '.title' <<<"$pr")"
  url="$(jq -r '.url' <<<"$pr")"
  head_ref="$(jq -r '.headRefName' <<<"$pr")"
  base_ref="$(jq -r '.baseRefName' <<<"$pr")"
  summary="$(printf '%s; ' "${blockers[@]}")"

  plan_file="$PLAN_DIR/repair-pr-$num.yaml"
  {
    printf 'name: repair-pr-%s-%s\n' "$num" "$fingerprint"
    printf 'onFinish: none\n'
    printf 'baseBranch: %s\n' "$base_ref"
    printf 'tasks:\n'
    printf '  - id: repair\n'
    printf '    description: "Repair PR #%s: %s"\n' "$num" "$(printf '%s' "$summary" | tr '"' "'")"
    printf '    prompt: |\n'
    {
      printf 'Repair the existing pull request #%s ("%s") on %s.\n' "$num" "$title" "$TARGET_REPO"
      printf 'PR URL: %s\n' "$url"
      printf 'Head branch: %s (at %s), base branch: %s\n\n' "$head_ref" "$head_oid" "$base_ref"
      printf 'This PR has no Invoker workflow; work directly on its branch:\n'
      printf '  git fetch origin %s && git checkout %s\n\n' "$head_ref" "$head_ref"
      printf 'Blockers to clear, strictly in this order:\n'
      i=1
      for b in "${blockers[@]}"; do
        printf '  %d. %s\n' "$i" "$b"
        i=$((i + 1))
      done
      printf '\nRules:\n'
      printf -- '- Resolve the merge conflict by rebasing onto origin/%s (or merging it) before anything else.\n' "$base_ref"
      printf -- '- Reproduce and fix the failing checks locally before pushing.\n'
      printf -- '- Address review feedback with real changes or a reasoned reply, never by dismissing.\n'
      printf -- '- Push to the SAME branch (%s). NEVER open a new PR and NEVER force-push unless the rebase requires it.\n' "$head_ref"
    } | sed 's/^/      /'
  } > "$plan_file"

  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: DRY-RUN would submit repair task (blockers: $summary)"
    continue
  fi

  ledger_record orphan-attempt "$num" "$fingerprint"
  if output="$(headless_mutation run "$plan_file" 2>&1)"; then
    ledger_record orphan-submitted "$num" "$fingerprint"
    submitted=$((submitted + 1))
    log_line "PR #$num: submitted repair task ($fingerprint; blockers: $summary)"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log_line "PR #$num: submit failed: $line"
    done <<<"$output"
  fi
done < <(jq -c '.[]' <<<"$prs_json")

log_line "orphan-repair scan complete; submitted $submitted repair task(s)"
