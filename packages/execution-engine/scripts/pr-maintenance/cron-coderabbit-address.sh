#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

MAX_CODERABBIT_ATTEMPTS="${INVOKER_PR_CODERABBIT_MAX_ATTEMPTS:-3}"
STATE_FILE="${INVOKER_PR_CODERABBIT_STATE_FILE:-${HOME}/.invoker/coderabbit-address-submissions.tsv}"
WORKDIR="${INVOKER_PR_CRON_WORKDIR:-${HOME}/.invoker/pr-cron-work}"
WORKDIR_MAX_AGE_DAYS="${INVOKER_PR_CRON_WORKDIR_MAX_AGE_DAYS:-7}"
SUBMIT_CMD="${INVOKER_PR_CODERABBIT_SUBMIT_CMD:-$REPO_ROOT/submit-plan.sh}"
REPO_URL="${INVOKER_PR_CODERABBIT_REPO_URL:-$(git remote get-url origin 2>/dev/null || echo .)}"

cron_lock
ledger_init "$STATE_FILE"
prune_stale_pr_workdirs "$WORKDIR" "$WORKDIR_MAX_AGE_DAYS"

# Fetch one comments endpoint, normalizing gh's per-page arrays into one array.
fetch_cr_endpoint() {
  local endpoint="$1" raw
  raw="$(gh_json api "$endpoint" --paginate 2>/dev/null || true)"
  printf '%s' "$raw" | jq -s 'add // []' 2>/dev/null || printf '[]'
}

# Collect CodeRabbit (inline + summary) comments for a PR as a JSON array of
# {body, updated_at, path, html_url}.
collect_coderabbit() {
  local num="$1" inline summary
  inline="$(fetch_cr_endpoint "repos/$TARGET_REPO/pulls/$num/comments")"
  summary="$(fetch_cr_endpoint "repos/$TARGET_REPO/issues/$num/comments")"
  jq -n --argjson inline "$inline" --argjson summary "$summary" --arg login "$CODERABBIT_LOGIN" '
    ($inline + $summary)
    | map(select(.user.login == $login))
    | map({body, updated_at, path: (.path // null), html_url: (.html_url // null)})
  '
}

# Build a JSON string literal that is safe to embed directly in YAML.
json_quote() {
  jq -nr --arg v "$1" '$v'
}

slugify_marker() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cs 'a-z0-9' '-' \
    | sed -e 's/^-*//' -e 's/-*$//'
}

build_prompt() {
  # build_prompt <num> <base_branch> <head_branch> <ctx_json>
  local num="$1" base="$2" head="$3" ctx_json="$4"
  cat <<EOF
You are addressing CodeRabbit review feedback on GitHub PR #$num in repository $TARGET_REPO.
Invoker created a dedicated repair workflow for this feedback batch. You are working on the
PR head branch ($head) inside an Invoker task; when this workflow succeeds, Invoker's merge
gate will push the merged result back to that PR branch. Do not open, retitle, or edit the
GitHub PR yourself, and do not run 'git push' manually.

Context JSON for this PR:
$ctx_json

Do this:
1. Read the CodeRabbit comments in the JSON context. Also read the actual change under review:
   'git log origin/$base..HEAD' and 'git diff origin/$base...HEAD', plus the Invoker task list.
2. For EACH distinct CodeRabbit concern, decide whether it is genuinely valid (a real bug,
   correctness, or safety issue) — not style noise or a false positive.
3. For each concern you judge VALID:
   a. Add a bash repro at scripts/repro/repro-coderabbit-pr$num-<slug>.sh that reproduces the
      finding and exits NON-ZERO on the buggy behavior (follow scripts/repro/ convention:
      'set -euo pipefail', derive the repo root, print a clear PASS/FAIL).
   b. Implement the minimal fix so the repro passes.
4. For concerns you judge NOT valid, take no code action.
5. If NO concern is valid, make no code changes and explain that in your task summary.

Constraints: change ONLY what the valid concerns require. Do NOT reformat unrelated code, bump
versions, or touch files outside a concern's scope. Leave the branch ready for Invoker's merge
gate to publish the fix back to the PR branch.
EOF
}

write_repair_plan() {
  # write_repair_plan <path> <name> <description> <head_branch> <task_id> <task_description> <prompt>
  #
  # Both baseBranch and featureBranch are the PR head branch on purpose. The
  # repair must layer its fix on TOP of the PR's existing commits and push the
  # result back to that same branch. If baseBranch were the PR base, Invoker's
  # merge gate would rebuild the head branch from base + the fix and force-push
  # that, discarding the PR author's own commits. Manual mergeMode means the
  # gate parks at review_ready after pushing the head branch and never
  # squash-merges to base, so base == feature is safe here.
  local plan_path="$1" plan_name="$2" plan_description="$3" head_branch="$4"
  local task_id="$5" task_description="$6" prompt="$7"
  {
    printf 'name: %s\n' "$(json_quote "$plan_name")"
    printf 'description: %s\n' "$(json_quote "$plan_description")"
    printf 'repoUrl: %s\n' "$(json_quote "$REPO_URL")"
    printf 'baseBranch: %s\n' "$(json_quote "$head_branch")"
    printf 'featureBranch: %s\n' "$(json_quote "$head_branch")"
    printf 'onFinish: merge\n'
    printf 'mergeMode: manual\n'
    printf 'tasks:\n'
    printf '  - id: %s\n' "$(json_quote "$task_id")"
    printf '    description: %s\n' "$(json_quote "$task_description")"
    printf '    executionAgent: omp\n'
    if [ -n "${INVOKER_PR_CRON_OMP_MODEL:-}" ]; then
      printf '    executionModel: %s\n' "$(json_quote "$INVOKER_PR_CRON_OMP_MODEL")"
    fi
    printf '    prompt: |\n'
    printf '%s\n' "$prompt" | sed 's/^/      /'
  } > "$plan_path"
}

submit_repair_workflow() {
  # submit_repair_workflow <num> <pr_title> <head_branch> <base_branch>; exits the script.
  local num="$1" pr_title="$2" head_branch="$3" base_branch="$4"

  # Count every real attempt (not just successes) so repeated submit failures hit the
  # cap instead of retrying forever; dedup still keys off the success marker.
  ledger_record coderabbit-attempt "$num" "$LATEST_MARKER"

  local rec="" wf="" tasks="null"
  if rec="$(resolve_workflow_for_pr "$num")"; then
    wf="$(jq -r '.workflowId // empty' <<<"$rec" 2>/dev/null || true)"
    if [ -n "$wf" ]; then
      tasks="$("$RUNNER" --headless query tasks --workflow "$wf" --output json 2>/dev/null || printf 'null')"
      printf '%s' "$tasks" | jq empty 2>/dev/null || tasks="null"
    else
      log_line "PR #$num: no local Invoker workflow; proceeding without task context"
    fi
  else
    log_line "PR #$num: review-gate lookup failed; proceeding without task context"
  fi

  local pr_view pr_body ctx_json marker_slug plan_path prompt workflow_id="" submit_output=""
  pr_view="$(gh_json pr view "$num" --repo "$TARGET_REPO" --json title,body,headRefName,baseRefName || printf '{}')"
  pr_body="$(jq -r '.body // ""' <<<"$pr_view")"
  ctx_json="$(jq -n --arg pr "$num" --arg title "$pr_title" --arg body "$pr_body" \
        --arg head "$head_branch" --arg base "$base_branch" \
        --argjson comments "$COLLECTED_COMMENTS" --argjson tasks "$tasks" '
    { pr: ($pr | tonumber), prTitle: $title, prBody: $body,
      headBranch: $head, baseBranch: $base,
      coderabbitComments: $comments, invokerTasks: $tasks }
  ')"

  mkdir -p "$WORKDIR"
  marker_slug="$(slugify_marker "$LATEST_MARKER")"
  plan_path="$WORKDIR/coderabbit-pr-${num}-${marker_slug}.yaml"
  prompt="$(build_prompt "$num" "$base_branch" "$head_branch" "$ctx_json")"
  write_repair_plan \
    "$plan_path" \
    "CodeRabbit repair PR #$num @ $LATEST_MARKER" \
    "Address CodeRabbit feedback batch from $LATEST_MARKER on PR #$num through a dedicated Invoker repair workflow." \
    "$head_branch" \
    "coderabbit-repair-pr-$num" \
    "Address CodeRabbit review feedback for PR #$num" \
    "$prompt"

  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would submit repair workflow $plan_path for new CodeRabbit activity at $LATEST_MARKER"
    exit 0
  fi

  log_line "PR #$num: submitting repair workflow $plan_path"
  if submit_output="$("$SUBMIT_CMD" "$plan_path" 2>&1)"; then
    [ -n "$submit_output" ] && printf '%s\n' "$submit_output"
    ledger_record coderabbit "$num" "$LATEST_MARKER"
    workflow_id="$(printf '%s\n' "$submit_output" | sed -n 's/^Workflow ID: //p' | sed -n '1p')"
    if [ -n "$workflow_id" ]; then
      log_line "PR #$num: submitted CodeRabbit repair workflow $workflow_id; recorded marker $LATEST_MARKER"
    else
      log_line "PR #$num: submitted CodeRabbit repair workflow; recorded marker $LATEST_MARKER"
    fi
    exit 0
  fi

  [ -n "$submit_output" ] && printf '%s\n' "$submit_output" >&2
  log_line "PR #$num: repair workflow submit failed; not recording (retry next tick)"
  exit 1
}

# Unmapped PRs that are also conflicted or failing CI belong to the
# orphan-repair worker, which folds review feedback into its combined repair
# task. Skipping here avoids two agents pushing to the same branch. Returns 0
# (skip) only on a confirmed broken state plus a clean no-workflow miss; the
# cheap gh view runs first so healthy PRs never pay the workflow lookup.
orphan_repair_owns_pr() {
  local num="$1" rec wf view
  view="$(gh_json pr view "$num" --repo "$TARGET_REPO" \
    --json mergeable,mergeStateStatus,statusCheckRollup)" || return 1
  jq -e '
    (.mergeable == "CONFLICTING") or (.mergeStateStatus == "DIRTY")
    or ([.statusCheckRollup[]? | select((.conclusion // "") as $c
        | $c == "FAILURE" or $c == "ERROR" or $c == "TIMED_OUT" or $c == "CANCELLED")] | length > 0)
  ' <<<"$view" >/dev/null 2>&1 || return 1
  rec="$(resolve_workflow_for_pr "$num")" || return 1
  wf="$(jq -r '.workflowId // empty' <<<"$rec" 2>/dev/null || true)"
  [ -z "$wf" ]
}

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --author "$PR_AUTHOR" --state open \
  --json number,url,headRefName,baseRefName,title --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"
  head_branch="$(jq -r '.headRefName' <<<"$pr")"
  base_branch="$(jq -r '.baseRefName' <<<"$pr")"
  pr_title="$(jq -r '.title' <<<"$pr")"

  COLLECTED_COMMENTS="$(collect_coderabbit "$num")"
  LATEST_MARKER="$(jq -r 'map(.updated_at) | max // empty' <<<"$COLLECTED_COMMENTS")"
  if [ -z "$LATEST_MARKER" ]; then
    continue
  fi

  # new-since-last-run dedup (robust to deleted comments lowering the max).
  seen_max="$(ledger_max_marker coderabbit "$num")"
  if [ -n "$seen_max" ] && [[ ! "$LATEST_MARKER" > "$seen_max" ]]; then
    log_line "PR #$num: no new CodeRabbit comments since $seen_max; skip"
    continue
  fi

  # Per-feedback-batch attempt cap: counts attempts for THIS comment marker
  # (incl. failed submit runs), so repeated failures on the same feedback stop
  # but genuinely new CodeRabbit comments still get a fresh budget.
  if [ "$(ledger_count coderabbit-attempt "$num" "$LATEST_MARKER")" -ge "$MAX_CODERABBIT_ATTEMPTS" ]; then
    log_line "PR #$num: CodeRabbit address hit cap of $MAX_CODERABBIT_ATTEMPTS; skip"
    continue
  fi

  if orphan_repair_owns_pr "$num"; then
    log_line "PR #$num: unmapped and broken; orphan-repair owns it this tick"
    continue
  fi

  submit_repair_workflow "$num" "$pr_title" "$head_branch" "$base_branch"
done < <(jq -c '.[]' <<<"$prs_json")

log_line "no PRs with new CodeRabbit feedback this tick"
