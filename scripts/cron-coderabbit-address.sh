#!/usr/bin/env bash
# Job 1 — CodeRabbit review address cron.
#
# Every 5 min: for open PRs by $PR_AUTHOR, look for NEW CodeRabbit review
# comments (inline + summary). On the first PR with new feedback, launch a
# standalone `omp` agent on a checkout of the PR head branch. The agent reads
# the CodeRabbit comments + the branch commits + the Invoker tasks that
# produced the PR + the PR summary, judges each concern, and — only for the
# real ones — writes a bash repro proving the finding, fixes the branch, and
# pushes the update. Invoker workflow state is never touched.
#
# At most ONE omp operation per tick (bounds the shared lock hold).
#
# Anti-loop guards:
#   - new-since-last-run dedup (ledger max marker vs latest comment updated_at)
#   - per-PR hard attempt cap ($MAX_CODERABBIT_ATTEMPTS)
#
# Env: INVOKER_GITHUB_TARGET_REPO, INVOKER_PR_CRON_AUTHOR,
#      INVOKER_CODERABBIT_LOGIN (default coderabbitai[bot]),
#      INVOKER_PR_CODERABBIT_MAX_ATTEMPTS (default 3),
#      INVOKER_PR_CODERABBIT_STATE_FILE (ledger path),
#      INVOKER_PR_CRON_WORKDIR (checkout root),
#      INVOKER_PR_CRON_OMP_MODEL (omp model, optional),
#      INVOKER_OMP_COMMAND (omp binary, default omp),
#      INVOKER_PR_CRON_DRY_RUN=1 (print intended actions only).
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

MAX_CODERABBIT_ATTEMPTS="${INVOKER_PR_CODERABBIT_MAX_ATTEMPTS:-3}"
STATE_FILE="${INVOKER_PR_CODERABBIT_STATE_FILE:-${HOME}/.invoker/coderabbit-address-submissions.tsv}"
WORKDIR="${INVOKER_PR_CRON_WORKDIR:-${HOME}/.invoker/pr-cron-work}"

cron_lock
ledger_init "$STATE_FILE"

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

# Prepare a checkout of the PR head branch; sets CHECKOUT_DIR. Logs to stderr so
# callers can capture nothing on stdout.
CHECKOUT_DIR=""
prepare_checkout() {
  local num="$1"
  local dir="$WORKDIR/$num"
  mkdir -p "$WORKDIR"
  if [ ! -d "$dir/.git" ]; then
    rm -rf "$dir"
    if ! gh repo clone "$TARGET_REPO" "$dir" -- --quiet >/dev/null 2>&1; then
      log_line "PR #$num: clone failed" >&2
      return 1
    fi
  elif ! ( cd "$dir" && git reset --hard && git clean -fd ) >/dev/null 2>&1; then
    # A prior omp run that exited non-zero can leave a dirty worktree; reset it
    # so the next attempt never fails checkout on, or pushes, stale edits.
    log_line "PR #$num: failed to clean reused checkout" >&2
    return 1
  fi
  if ! ( cd "$dir" && git fetch --quiet --all && gh pr checkout "$num" --repo "$TARGET_REPO" && git reset --hard && git clean -fd ) >/dev/null 2>&1; then
    log_line "PR #$num: gh pr checkout failed" >&2
    return 1
  fi
  CHECKOUT_DIR="$dir"
}

build_prompt() {
  # build_prompt <num> <base_branch> <head_branch> <ctx_file>
  local num="$1" base="$2" head="$3" ctx="$4"
  cat <<EOF
You are addressing CodeRabbit review feedback on GitHub PR #$num in repository $TARGET_REPO.
You are running inside a fresh checkout of the PR head branch ($head); HEAD is already on that
branch and 'git push' updates the PR.

Context for this PR is in the JSON file: $ctx
Fields: .pr, .prTitle, .prBody, .headBranch, .baseBranch,
        .coderabbitComments (array of {body, updated_at, path, html_url}),
        .invokerTasks (the Invoker tasks that produced this PR, or null if none).

Do this:
1. Read the CodeRabbit comments in $ctx. Also read the actual change under review:
   'git log origin/$base..HEAD' and 'git diff origin/$base...HEAD', plus the Invoker task list.
2. For EACH distinct CodeRabbit concern, decide whether it is genuinely valid (a real bug,
   correctness, or safety issue) — not style noise or a false positive.
3. For each concern you judge VALID:
   a. Add a bash repro at scripts/repro/repro-coderabbit-pr$num-<slug>.sh that reproduces the
      finding and exits NON-ZERO on the buggy behavior (follow scripts/repro/ convention:
      'set -euo pipefail', derive the repo root, print a clear PASS/FAIL).
   b. Implement the minimal fix so the repro passes.
4. For concerns you judge NOT valid, take no code action.
5. Commit the repro(s) + fix(es) with a clear message and 'git push' to the PR head branch.

Constraints: change ONLY what the valid concerns require. Do NOT reformat unrelated code, bump
versions, or touch files outside a concern's scope. If NO concern is valid, make no commit and
exit without pushing.
EOF
}

launch_omp() {
  # launch_omp <num> <pr_title> <head_branch> <base_branch>; exits the script.
  local num="$1" pr_title="$2" head_branch="$3" base_branch="$4"

  # Count every real attempt (not just successes) so repeated failures hit the
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

  local pr_view pr_body
  pr_view="$(gh_json pr view "$num" --repo "$TARGET_REPO" --json title,body,headRefName,baseRefName || printf '{}')"
  pr_body="$(jq -r '.body // ""' <<<"$pr_view")"

  local ctx_file
  ctx_file="$(mktemp -t invoker-cr-ctx.XXXXXX)"
  jq -n --arg pr "$num" --arg title "$pr_title" --arg body "$pr_body" \
        --arg head "$head_branch" --arg base "$base_branch" \
        --argjson comments "$COLLECTED_COMMENTS" --argjson tasks "$tasks" '
    { pr: ($pr | tonumber), prTitle: $title, prBody: $body,
      headBranch: $head, baseBranch: $base,
      coderabbitComments: $comments, invokerTasks: $tasks }
  ' > "$ctx_file"

  if ! prepare_checkout "$num"; then
    rm -f "$ctx_file"
    exit 1
  fi

  local omp_cmd prompt
  omp_cmd="${INVOKER_OMP_COMMAND:-omp}"
  prompt="$(build_prompt "$num" "$base_branch" "$head_branch" "$ctx_file")"
  local omp_args=(--no-title --auto-approve)
  [ -n "${INVOKER_PR_CRON_OMP_MODEL:-}" ] && omp_args+=(--model "$INVOKER_PR_CRON_OMP_MODEL")
  omp_args+=(-p "$prompt")

  log_line "PR #$num: launching omp on $CHECKOUT_DIR"
  # omp reads $ctx_file during the run, so clean it up only after omp returns.
  # Bound the run so a hung omp cannot hold the shared cron lock indefinitely;
  # a timeout exits non-zero and is handled exactly like any other failure.
  local omp_run=("$omp_cmd" "${omp_args[@]}")
  if command -v timeout >/dev/null 2>&1; then
    omp_run=(timeout --kill-after=1m "${INVOKER_PR_CRON_OMP_TIMEOUT:-45m}" "$omp_cmd" "${omp_args[@]}")
  fi
  if ( cd "$CHECKOUT_DIR" && "${omp_run[@]}" ); then
    rm -f "$ctx_file"
    ledger_record coderabbit "$num" "$LATEST_MARKER"
    log_line "PR #$num: omp addressed CodeRabbit feedback; recorded marker $LATEST_MARKER"
    exit 0
  fi
  rm -f "$ctx_file"
  log_line "PR #$num: omp exited non-zero; not recording (retry next tick)"
  exit 1
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
  # (incl. failed omp runs), so repeated failures on the same feedback stop but
  # genuinely new CodeRabbit comments still get a fresh budget.
  if [ "$(ledger_count coderabbit-attempt "$num" "$LATEST_MARKER")" -ge "$MAX_CODERABBIT_ATTEMPTS" ]; then
    log_line "PR #$num: CodeRabbit address hit cap of $MAX_CODERABBIT_ATTEMPTS; skip"
    continue
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would launch omp for new CodeRabbit activity at $LATEST_MARKER"
    exit 0
  fi

  launch_omp "$num" "$pr_title" "$head_branch" "$base_branch"
done < <(jq -c '.[]' <<<"$prs_json")

log_line "no PRs with new CodeRabbit feedback this tick"
