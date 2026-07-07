#!/usr/bin/env bash
# Job 2 — PR rebase / CI-repair cron.
#
# Every 5 min: scan open PRs by $PR_AUTHOR for either:
#   - dequeued PRs whose CI or merge-queue draft must be fixed or requeued,
#   - PRs whose current head/base state is already being monitored by this job,
#   - PRs whose GitHub merge state is conflicting (DIRTY / CONFLICTING).
#
# Each PR gets a dedicated per-PR git worktree. If the PR head is behind or
# diverged from its current base, rebase it onto the base and force-push; that
# push is the CI trigger. Once the head is on the current base:
#   - dequeued PRs watch all completed CI jobs, preferring the open merge-queue
#     draft when one exists; failures launch a local fixer, green runs requeue.
#   - other PRs watch the required admin-bypass checks from .mergify.yml;
#     failures launch a local fixer and green runs record success.
#
# Anti-loop guards:
#   1. shared flock/mkdir lock + synchronous execution — one cron op at a time.
#   2. dedicated per-PR worktrees under $INVOKER_PR_CRON_WORKDIR/conflict-rebase.
#   3. per-PR branch-state ledger dedup — each unique head/base SHA pair gets at
#      most $MAX_REBASE_ATTEMPTS real mutation attempts, while a new head/base
#      pair gets a fresh budget.
#
# At most ONE mutating rebase / fix / requeue runs per tick; pure observation
# (CI still pending, already handled) continues scanning later PRs.
#
# Env: INVOKER_GITHUB_TARGET_REPO, INVOKER_PR_CRON_AUTHOR,
#      INVOKER_PR_REBASE_MAX_ATTEMPTS (default 3),
#      INVOKER_PR_CONFLICT_STATE_FILE (ledger path),
#      INVOKER_PR_CRON_WORKDIR (worktree root),
#      INVOKER_OMP_COMMAND (default omp),
#      INVOKER_PR_CRON_OMP_MODEL (optional omp model),
#      INVOKER_PR_CRON_OMP_TIMEOUT (default 45m),
#      INVOKER_PR_CRON_DRY_RUN=1 (print intended actions only).
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

MAX_REBASE_ATTEMPTS="${INVOKER_PR_REBASE_MAX_ATTEMPTS:-3}"
STATE_FILE="${INVOKER_PR_CONFLICT_STATE_FILE:-${HOME}/.invoker/pr-conflict-rebase-submissions.tsv}"
WORKROOT="${INVOKER_PR_CRON_WORKDIR:-${HOME}/.invoker/pr-cron-work}"
WORKDIR="${WORKROOT}/conflict-rebase"
MIRROR_DIR="${WORKDIR}/repo"
CHECKOUT_DIR=""
REQUIRED_CHECKS_JSON="$(awk '
  /^  - name: admin-bypass$/ { in_rule = 1; next }
  in_rule && /^pull_request_rules:/ { exit }
  in_rule && /^    merge_conditions:/ { in_merge = 1; next }
  in_rule && in_merge && /^  - name:/ { exit }
  in_rule && in_merge && /^[[:space:]]*-[[:space:]]*check-success = / {
    sub(/^[[:space:]]*-[[:space:]]*check-success = /, "", $0)
    print
  }
' "$REPO_ROOT/.mergify.yml" | jq -Rsc 'split("\n") | map(select(length > 0))')"

cron_lock
ledger_init "$STATE_FILE"

cleanup_checkout() {
  local dir="${1:-}"
  [ -n "$dir" ] || return 0
  if [ -d "$MIRROR_DIR/.git" ]; then
    git -C "$MIRROR_DIR" worktree remove --force "$dir" >/dev/null 2>&1 || true
    git -C "$MIRROR_DIR" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "$dir" >/dev/null 2>&1 || true
}
trap 'cleanup_checkout "$CHECKOUT_DIR"' EXIT

flag_exhausted() {
  # flag_exhausted <prNumber>
  local num="$1"
  ledger_marker_seen conflict-rebase-flagged "$num" exhausted && return 0
  local body="Invoker conflict-rebase cron gave up after ${MAX_REBASE_ATTEMPTS} automatic rebase / CI-repair attempts for the current PR branch state; this PR still needs manual attention."
  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would post 'exhausted' comment"
    return 0
  fi
  if gh_json pr comment "$num" --repo "$TARGET_REPO" --body "$body" >/dev/null; then
    ledger_record conflict-rebase-flagged "$num" exhausted
  else
    log_line "PR #$num: exhausted-comment post failed (non-fatal); will retry the flag next tick"
  fi
}

sync_mirror() {
  mkdir -p "$WORKDIR"
  if [ ! -d "$MIRROR_DIR/.git" ]; then
    rm -rf "$MIRROR_DIR"
    if ! gh repo clone "$TARGET_REPO" "$MIRROR_DIR" -- --quiet >/dev/null 2>&1; then
      log_line "mirror clone failed at $MIRROR_DIR" >&2
      return 1
    fi
  fi
  if ! ( cd "$MIRROR_DIR" && git fetch --quiet --all --prune ) >/dev/null 2>&1; then
    log_line "mirror fetch failed at $MIRROR_DIR" >&2
    return 1
  fi
  ( cd "$MIRROR_DIR" && git worktree prune ) >/dev/null 2>&1 || true
}

branch_state_marker() {
  # branch_state_marker <headBranch> <baseBranch> -> <headSha>:<baseSha>
  local head_branch="$1" base_branch="$2" head_sha="" base_sha=""
  head_sha="$(git -C "$MIRROR_DIR" rev-parse "refs/remotes/origin/$head_branch" 2>/dev/null || true)"
  base_sha="$(git -C "$MIRROR_DIR" rev-parse "refs/remotes/origin/$base_branch" 2>/dev/null || true)"
  [ -n "$head_sha" ] || return 1
  [ -n "$base_sha" ] || return 1
  printf '%s:%s' "$head_sha" "$base_sha"
}

head_is_on_base() {
  # head_is_on_base <headBranch> <baseBranch>
  local head_branch="$1" base_branch="$2"
  git -C "$MIRROR_DIR" merge-base --is-ancestor "refs/remotes/origin/$base_branch" "refs/remotes/origin/$head_branch" >/dev/null 2>&1
}

prepare_checkout() {
  # prepare_checkout <prNumber> <headBranch>; sets CHECKOUT_DIR.
  local num="$1" head_branch="$2"
  local dir="$WORKDIR/$num"
  local branch="pr-cron/rebase-$num"
  cleanup_checkout "$dir"
  if ! git -C "$MIRROR_DIR" worktree add --no-track -B "$branch" "$dir" "origin/$head_branch" >/dev/null 2>&1; then
    log_line "PR #$num: worktree add failed" >&2
    cleanup_checkout "$dir"
    return 1
  fi
  CHECKOUT_DIR="$dir"
}

pr_has_label() {
  # pr_has_label <prJson> <label>
  jq -e --arg label "$2" 'any((.labels // [])[]?; .name == $label)' >/dev/null <<<"$1"
}

required_checks_state() {
  # required_checks_state <prViewJson>
  local pr_view="$1"
  jq -cn \
    --argjson required "$REQUIRED_CHECKS_JSON" \
    --argjson items "$(jq '
      def item_name: .name // .context // "";
      def item_ts: .completedAt // .startedAt // "";
      (.statusCheckRollup // [])
      | map(select((item_name | length) > 0))
      | sort_by(item_name, item_ts)
      | group_by(item_name)
      | map(max_by(item_ts))
    ' <<<"$pr_view")" '
      def item_name: .name // .context // "";
      def details_url: .detailsUrl // .targetUrl // "";
      def item_state:
        if (.state? // null) != null then
          if .state == "SUCCESS" then {state: "success"}
          elif .state == "PENDING" or .state == "EXPECTED" then {state: "pending"}
          else {state: "failure", conclusion: (.state // "UNKNOWN")}
          end
        else
          if (.status // "") != "COMPLETED" then {state: "pending"}
          elif (.conclusion // "") == "SUCCESS" then {state: "success"}
          else {state: "failure", conclusion: (.conclusion // "UNKNOWN")}
          end
        end;
      [
        $required[] as $name |
        (($items | map(select(item_name == $name)) | first) // null) as $item |
        if $item == null then
          {name: $name, state: "pending", conclusion: "MISSING", detailsUrl: "", summary: "required check has not reported yet"}
        else
          ($item | item_state) as $s |
          {
            name: $name,
            state: $s.state,
            conclusion: ($s.conclusion // ""),
            detailsUrl: ($item | details_url),
            summary: ($item.summary // $item.description // "")
          }
        end
      ] as $checks |
      if any($checks[]; .state == "failure") then
        {state: "failure", failed: [$checks[] | select(.state == "failure")]}
      elif any($checks[]; .state == "pending") then
        {state: "pending", pending: [$checks[] | select(.state == "pending")]}
      else
        {state: "success", failed: []}
      end
    '
}

all_ci_checks_state() {
  # all_ci_checks_state <prViewJson>
  local pr_view="$1"
  jq -cn \
    --argjson items "$(jq '
      def item_name: .name // .context // "";
      def item_ts: .completedAt // .startedAt // "";
      def is_ci_job:
        (.__typename // "") == "CheckRun"
        and (item_name | length) > 0
        and ((item_name | startswith("Rule: ")) | not)
        and item_name != "Mergify Merge Queue"
        and item_name != "Summary";
      (.statusCheckRollup // [])
      | map(select(is_ci_job))
      | sort_by(item_name, item_ts)
      | group_by(item_name)
      | map(max_by(item_ts))
    ' <<<"$pr_view")" '
      def item_name: .name // .context // "";
      def details_url: .detailsUrl // .targetUrl // "";
      def item_state:
        if (.state? // null) != null then
          if .state == "SUCCESS" then {state: "success"}
          elif .state == "PENDING" or .state == "EXPECTED" then {state: "pending"}
          else {state: "failure", conclusion: (.state // "UNKNOWN")}
          end
        else
          if (.status // "") != "COMPLETED" then {state: "pending"}
          elif (.conclusion // "") == "SUCCESS" or (.conclusion // "") == "SKIPPED" or (.conclusion // "") == "NEUTRAL" then {state: "success"}
          else {state: "failure", conclusion: (.conclusion // "UNKNOWN")}
          end
        end;
      ($items | map(
        (item_state) as $s |
        {
          name: item_name,
          state: $s.state,
          conclusion: ($s.conclusion // ""),
          detailsUrl: details_url,
          summary: (.summary // .description // "")
        }
      )) as $checks |
      if ($checks | length) == 0 then
        {state: "pending", pending: [{name: "ci", state: "pending", conclusion: "MISSING", detailsUrl: "", summary: "CI jobs have not reported yet"}], failed: []}
      elif any($checks[]; .state == "failure") then
        {state: "failure", failed: [$checks[] | select(.state == "failure")]}
      elif any($checks[]; .state == "pending") then
        {state: "pending", pending: [$checks[] | select(.state == "pending")], failed: []}
      else
        {state: "success", failed: []}
      end
    '
}

merge_queue_pr_view() {
  # merge_queue_pr_view <prNumber>
  local num="$1"
  local queue_candidates queue_num
  queue_candidates="$(gh_json pr list --repo "$TARGET_REPO" --state open \
    --json number,title,headRefName,isDraft --limit 200 2>/dev/null || printf '[]')"
  queue_num="$(jq -r --arg needle "#$num" '
    [ .[]
      | select((.isDraft // false) and ((.headRefName // "") | startswith("mergify/merge-queue/")) and ((.title // "") | contains($needle)))
    ]
    | if length == 0 then "" else (max_by(.number).number | tostring) end
  ' <<<"$queue_candidates")"
  [ -n "$queue_num" ] || return 1
  gh_json pr view "$queue_num" --repo "$TARGET_REPO" --json number,title,url,statusCheckRollup
}

dequeued_checks_state() {
  # dequeued_checks_state <prNumber> <prViewJson>
  local num="$1" pr_view="$2"
  local source_view source_kind source_number source_url source_title
  if source_view="$(merge_queue_pr_view "$num" 2>/dev/null)" && [ -n "$(jq -r '.number // empty' <<<"$source_view")" ]; then
    source_kind="merge-queue-pr"
  else
    source_view="$pr_view"
    source_kind="pull-request"
  fi
  source_number="$(jq -r '.number // empty' <<<"$source_view")"
  source_url="$(jq -r '.url // empty' <<<"$source_view")"
  source_title="$(jq -r '.title // empty' <<<"$source_view")"
  jq \
    --arg sourceKind "$source_kind" \
    --arg sourceNumber "$source_number" \
    --arg sourceUrl "$source_url" \
    --arg sourceTitle "$source_title" '
      . + {
        sourceKind: $sourceKind,
        sourceNumber: ($sourceNumber | if length == 0 then null else tonumber end),
        sourceUrl: $sourceUrl,
        sourceTitle: $sourceTitle
      }
    ' <<<"$(all_ci_checks_state "$source_view")"
}

build_fix_prompt() {
  # build_fix_prompt <num> <base_branch> <head_branch> <ctx_file>
  local num="$1" base="$2" head="$3" ctx="$4"
  cat <<EOF
You are repairing failing CI on GitHub PR #$num in repository $TARGET_REPO.
You are running inside a fresh checkout of the PR head branch ($head); HEAD is already on that
branch and 'git push' updates the PR.

Context for this PR is in the JSON file: $ctx
Fields: .pr, .prUrl, .prTitle, .prBody, .headBranch, .baseBranch,
        .failingChecks (array of {name, conclusion, detailsUrl, summary}),
        .failingChecksSource ({kind, number, url, title}),
        .invokerTasks (the Invoker tasks that produced this PR, or null if none).

Do this:
1. Read the PR summary and failing checks in $ctx. Also read the actual change under review:
   'git log --format=%H%x09%s origin/$base..HEAD' and 'git diff origin/$base...HEAD'.
2. Infer the intended purpose from the commit messages and PR summary. Stay aligned to that
   purpose; do not broaden the change.
3. For EACH failing CI check, inspect the failure details/logs from its detailsUrl or via the
   GitHub CLI. When .failingChecksSource.kind is "merge-queue-pr", use that merge-queue draft
   only to understand the speculative failure; still fix the actual PR branch.
4. Implement the minimal fix needed for the real failure(s). Do NOT add unrelated cleanup,
   refactors, formatting churn, or feature changes.
5. Run the narrowest local verification that matches the failing CI surface.
6. Commit the fix with a clear message and 'git push' to the PR head branch.
7. If the failures are flaky, external, or not fixable without violating the PR intent, exit
   NON-ZERO and make no push.
EOF
}

launch_ci_fixer() {
  # launch_ci_fixer <num> <pr_title> <head_branch> <base_branch> <marker> <pr_view_json> <check_state_json>; exits the script.
  local num="$1" pr_title="$2" head_branch="$3" base_branch="$4" marker="$5" pr_view="$6" check_state="$7"
  local current_head="${marker%%:*}" base_sha="${marker##*:}"

  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would launch CI fixer for state $marker"
    exit 0
  fi

  ledger_record conflict-rebase-attempt "$num" "$marker"

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

  local ctx_file
  ctx_file="$(mktemp -t invoker-ci-fix-ctx.XXXXXX)"
  local source_kind source_number source_url source_title
  source_kind="$(jq -r '.sourceKind // "pull-request"' <<<"$check_state")"
  source_number="$(jq -r '.sourceNumber // empty' <<<"$check_state")"
  source_url="$(jq -r '.sourceUrl // empty' <<<"$check_state")"
  source_title="$(jq -r '.sourceTitle // empty' <<<"$check_state")"
  jq -n \
    --arg pr "$num" \
    --arg url "$(jq -r '.url // ""' <<<"$pr_view")" \
    --arg title "$pr_title" \
    --arg body "$(jq -r '.body // ""' <<<"$pr_view")" \
    --arg head "$head_branch" \
    --arg base "$base_branch" \
    --arg sourceKind "$source_kind" \
    --arg sourceNumber "$source_number" \
    --arg sourceUrl "$source_url" \
    --arg sourceTitle "$source_title" \
    --argjson failing "$(jq '.failed // []' <<<"$check_state")" \
    --argjson tasks "$tasks" '
      {
        pr: ($pr | tonumber),
        prUrl: $url,
        prTitle: $title,
        prBody: $body,
        headBranch: $head,
        baseBranch: $base,
        failingChecks: $failing,
        failingChecksSource: {
          kind: $sourceKind,
          number: ($sourceNumber | if length == 0 then null else tonumber end),
          url: $sourceUrl,
          title: $sourceTitle
        },
        invokerTasks: $tasks
      }
    ' > "$ctx_file"

  if ! prepare_checkout "$num" "$head_branch"; then
    rm -f "$ctx_file"
    exit 1
  fi

  local omp_cmd prompt
  omp_cmd="${INVOKER_OMP_COMMAND:-omp}"
  prompt="$(build_fix_prompt "$num" "$base_branch" "$head_branch" "$ctx_file")"
  local omp_args=(--no-title --auto-approve)
  [ -n "${INVOKER_PR_CRON_OMP_MODEL:-}" ] && omp_args+=(--model "$INVOKER_PR_CRON_OMP_MODEL")
  omp_args+=(-p "$prompt")

  log_line "PR #$num: launching omp CI fixer on $CHECKOUT_DIR"
  local omp_run=("$omp_cmd" "${omp_args[@]}")
  if command -v timeout >/dev/null 2>&1; then
    omp_run=(timeout --kill-after=1m "${INVOKER_PR_CRON_OMP_TIMEOUT:-45m}" "$omp_cmd" "${omp_args[@]}")
  fi

  if ( cd "$CHECKOUT_DIR" && "${omp_run[@]}" ); then
    rm -f "$ctx_file"
    local remote_head
    remote_head="$(git -C "$CHECKOUT_DIR" ls-remote --heads origin "$head_branch" 2>/dev/null | awk '{print $1}' | head -n 1)"
    if [ -n "$remote_head" ] && [ "$remote_head" != "$current_head" ]; then
      ledger_record conflict-rebase-await-ci "$num" "$remote_head:$base_sha"
      log_line "PR #$num: pushed CI fix as $remote_head; awaiting CI"
      exit 0
    fi
    log_line "PR #$num: omp exited 0 but did not push a new head; retry next tick"
    exit 1
  fi
  rm -f "$ctx_file"
  log_line "PR #$num: omp exited non-zero; not recording success (retry next tick)"
  exit 1
}

queue_after_green() {
  # queue_after_green <prNumber> <marker>; exits the script.
  local num="$1" marker="$2"
  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would comment '@mergify queue' and remove 'dequeued' for state $marker"
    exit 0
  fi
  if ! gh_json pr comment "$num" --repo "$TARGET_REPO" --body "@mergify queue" >/dev/null; then
    log_line "PR #$num: failed to comment @mergify queue; retry next tick"
    exit 1
  fi
  if ! gh_json pr edit "$num" --repo "$TARGET_REPO" --remove-label dequeued >/dev/null; then
    log_line "PR #$num: failed to remove dequeued label; retry next tick"
    exit 1
  fi
  ledger_record conflict-rebase "$num" "$marker"
  log_line "PR #$num: CI passed; requeued and removed dequeued for state $marker"
  exit 0
}

dispatch_conflict_rebase() {
  # dispatch_conflict_rebase <prNumber> <headBranch> <baseBranch> <marker> <expectedHeadSha>; exits the script.
  local num="$1" head_branch="$2" base_branch="$3" marker="$4" expected_head="$5"
  local base_sha="${marker##*:}"
  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: would rebase $head_branch onto $base_branch at $marker"
    exit 0
  fi

  ledger_record conflict-rebase-attempt "$num" "$marker"
  if ! prepare_checkout "$num" "$head_branch"; then
    exit 1
  fi

  log_line "PR #$num: rebasing $head_branch onto $base_branch in $CHECKOUT_DIR"
  if ! ( cd "$CHECKOUT_DIR" && git rebase "origin/$base_branch" ) >/dev/null 2>&1; then
    ( cd "$CHECKOUT_DIR" && git rebase --abort ) >/dev/null 2>&1 || true
    cleanup_checkout "$CHECKOUT_DIR"
    CHECKOUT_DIR=""
    log_line "PR #$num: git rebase onto $base_branch failed; retry next tick"
    exit 1
  fi

  if ! ( cd "$CHECKOUT_DIR" && git push "--force-with-lease=refs/heads/$head_branch:$expected_head" origin "HEAD:refs/heads/$head_branch" ) >/dev/null 2>&1; then
    cleanup_checkout "$CHECKOUT_DIR"
    CHECKOUT_DIR=""
    log_line "PR #$num: push after rebase failed; retry next tick"
    exit 1
  fi

  local pushed_head
  pushed_head="$(git -C "$CHECKOUT_DIR" rev-parse HEAD 2>/dev/null || true)"
  cleanup_checkout "$CHECKOUT_DIR"
  CHECKOUT_DIR=""
  if [ -n "$pushed_head" ]; then
    ledger_record conflict-rebase-await-ci "$num" "$pushed_head:$base_sha"
    log_line "PR #$num: rebased $head_branch onto $base_branch, pushed $pushed_head, awaiting CI"
    exit 0
  fi
  log_line "PR #$num: rebased and pushed, but could not resolve new HEAD; retry next tick"
  exit 1
}

if [ "$REQUIRED_CHECKS_JSON" = "[]" ]; then
  log_line "could not parse required admin-bypass checks from .mergify.yml; exiting"
  exit 0
fi

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --author "$PR_AUTHOR" --state open \
  --json number,title,headRefName,baseRefName,mergeable,mergeStateStatus,labels --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"
  pr_title="$(jq -r '.title // ""' <<<"$pr")"
  head_branch="$(jq -r '.headRefName // empty' <<<"$pr")"
  base_branch="$(jq -r '.baseRefName // empty' <<<"$pr")"
  if [ -z "$head_branch" ] || [ -z "$base_branch" ]; then
    log_line "PR #$num: missing head/base branch metadata; skip"
    continue
  fi

  if ! sync_mirror; then
    log_line "PR #$num: repo sync failed; skip (retry next tick)"
    continue
  fi

  if ! marker="$(branch_state_marker "$head_branch" "$base_branch")"; then
    log_line "PR #$num: could not resolve origin/$head_branch or origin/$base_branch; skip"
    continue
  fi
  expected_head="${marker%%:*}"

  is_dequeued=0
  pr_has_label "$pr" dequeued && is_dequeued=1 || true
  is_conflict=0
  if [ "$(jq -r '.mergeStateStatus // empty' <<<"$pr")" = "DIRTY" ] || [ "$(jq -r '.mergeable // empty' <<<"$pr")" = "CONFLICTING" ]; then
    is_conflict=1
  fi
  awaiting_ci=0
  ledger_marker_seen conflict-rebase-await-ci "$num" "$marker" && awaiting_ci=1 || true

  if [ "$is_conflict" -ne 1 ] && [ "$awaiting_ci" -ne 1 ] && [ "$is_dequeued" -ne 1 ]; then
    continue
  fi

  if [ "$(ledger_count conflict-rebase-attempt "$num" "$marker")" -ge "$MAX_REBASE_ATTEMPTS" ]; then
    log_line "PR #$num: giving up — automatic rebase / CI repair hit cap of $MAX_REBASE_ATTEMPTS for state $marker"
    flag_exhausted "$num"
    continue
  fi

  if ledger_marker_seen conflict-rebase "$num" "$marker" && [ "$is_dequeued" -ne 1 ]; then
    log_line "PR #$num: already handled for state $marker; skip"
    continue
  fi

  if ! head_is_on_base "$head_branch" "$base_branch"; then
    dispatch_conflict_rebase "$num" "$head_branch" "$base_branch" "$marker" "$expected_head"
  fi

  pr_view="$(gh_json pr view "$num" --repo "$TARGET_REPO" --json title,body,url,headRefOid,headRefName,baseRefName,labels,statusCheckRollup || printf '{}')"
  fresh_head="$(jq -r '.headRefOid // empty' <<<"$pr_view")"
  if [ -z "$fresh_head" ]; then
    log_line "PR #$num: could not load fresh PR state; skip"
    continue
  fi
  if [ "$fresh_head" != "$expected_head" ]; then
    log_line "PR #$num: head changed while scanning ($expected_head -> $fresh_head); retry next tick"
    continue
  fi

  current_dequeued=0
  pr_has_label "$pr_view" dequeued && current_dequeued=1 || true

  if ledger_marker_seen conflict-rebase "$num" "$marker" && [ "$current_dequeued" -ne 1 ]; then
    log_line "PR #$num: already handled for state $marker; skip"
    continue
  fi

  if [ "$current_dequeued" -eq 1 ]; then
    check_state="$(dequeued_checks_state "$num" "$pr_view")"
    ci_state="$(jq -r '.state // "pending"' <<<"$check_state")"
    case "$ci_state" in
      pending)
        log_line "PR #$num: dequeued CI still pending for state $marker"
        continue
        ;;
      failure)
        launch_ci_fixer "$num" "$pr_title" "$head_branch" "$base_branch" "$marker" "$pr_view" "$check_state"
        ;;
      success)
        queue_after_green "$num" "$marker"
        ;;
    esac
  fi

  check_state="$(required_checks_state "$pr_view")"
  ci_state="$(jq -r '.state // "pending"' <<<"$check_state")"
  case "$ci_state" in
    pending)
      log_line "PR #$num: required CI still pending for state $marker"
      continue
      ;;
    failure)
      launch_ci_fixer "$num" "$pr_title" "$head_branch" "$base_branch" "$marker" "$pr_view" "$check_state"
      ;;
    success)
      if ! ledger_marker_seen conflict-rebase "$num" "$marker"; then
        ledger_record conflict-rebase "$num" "$marker"
        log_line "PR #$num: required CI passed for state $marker"
      else
        log_line "PR #$num: already handled for state $marker; skip"
      fi
      continue
      ;;
  esac
done < <(jq -c '
  def has_label($label): any((.labels // [])[]?; .name == $label);
  ([.[] | select(has_label("dequeued"))]
   + [.[] | select((has_label("dequeued")) | not)])[]
' <<<"$prs_json")

log_line "no actionable PRs this tick"
