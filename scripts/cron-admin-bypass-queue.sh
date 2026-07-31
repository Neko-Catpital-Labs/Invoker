#!/usr/bin/env bash
set -euo pipefail

# Admin-bypass PR repair queue: ONE scan, ONE classify step, ONE submit-task
# step per PR, then move on. Replaces the old pattern of five separate cron
# scripts racing for one lock while some of them ran an AI repair
# synchronously (holding the lock for the whole run). This script never runs
# repair work itself: every branch below is a fast Invoker task submission
# (an IPC call that returns immediately), so the lock is only ever held for
# the scan+classify+submit loop, not for an AI turn.
#
# Flow per PR:
#   1. classify   -> conflict | failed_checks | changes_requested | none
#   2. route      -> mapped to an Invoker workflow?
#                      yes + conflict        -> rebase-recreate <workflowId>
#                      yes + failed_checks   -> repair-review-gate-ci <pr>
#                      no (or no mutation)   -> submit an ad-hoc repair plan
#   3. move to the next PR immediately; the submitted task runs later on
#      Invoker's own fair launch-dispatch queue.
#
# Env (all optional):
#   INVOKER_ADMIN_BYPASS_QUEUE_STATE_FILE   ledger path (default ~/.invoker/admin-bypass-queue.tsv)
#   INVOKER_ADMIN_BYPASS_QUEUE_MAX_ATTEMPTS attempt cap per fingerprint (default 3)
#   INVOKER_ADMIN_BYPASS_LABEL              label to scan (default admin-bypass)
#   INVOKER_ADMIN_BYPASS_REPO_URL           repoUrl for ad-hoc plans (default https://github.com/$TARGET_REPO.git)
#   INVOKER_PR_CRON_DRY_RUN=1               log the plan instead of submitting

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

cron_lock

STATE_FILE="${INVOKER_ADMIN_BYPASS_QUEUE_STATE_FILE:-$HOME/.invoker/admin-bypass-queue.tsv}"
MAX_ATTEMPTS="${INVOKER_ADMIN_BYPASS_QUEUE_MAX_ATTEMPTS:-3}"
LABEL="${INVOKER_ADMIN_BYPASS_LABEL:-admin-bypass}"
REPO_URL="${INVOKER_ADMIN_BYPASS_REPO_URL:-https://github.com/$TARGET_REPO.git}"
INVOKER_DB_PATH="${INVOKER_DB_PATH:-$HOME/.invoker/invoker.db}"
ledger_init "$STATE_FILE"

# Repros pass INVOKER_ADMIN_BYPASS_QUEUE_PLAN_DIR to inspect submitted plans; a
# caller-provided dir is never cleaned up here.
if [ -n "${INVOKER_ADMIN_BYPASS_QUEUE_PLAN_DIR:-}" ]; then
  PLAN_DIR="$INVOKER_ADMIN_BYPASS_QUEUE_PLAN_DIR"
  mkdir -p "$PLAN_DIR"
else
  PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-admin-bypass-plans.XXXXXX")"
  trap 'rm -rf "$PLAN_DIR"' EXIT
fi

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --label "$LABEL" --state open \
  --json number,title,url,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision \
  --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

submitted=0
repair_workflow_submission_state() {
  local num="$1"
  local fingerprint="$2"
  local workflow_name="admin-bypass-repair-pr-${num}-${fingerprint}"
  if [ ! -f "$INVOKER_DB_PATH" ] || ! command -v python3 >/dev/null 2>&1; then
    printf 'unknown\t\t\t\n'
    return 0
  fi
  python3 - "$INVOKER_DB_PATH" "$workflow_name" <<'PY' || printf 'unknown\t\t\t\n'
import sqlite3
import sys

db_path, workflow_name = sys.argv[1], sys.argv[2]
try:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    workflow = con.execute(
        "select id from workflows where name = ? order by created_at desc, rowid desc limit 1",
        (workflow_name,),
    ).fetchone()
except sqlite3.Error:
    print("unknown\t\t\t")
    raise SystemExit(0)
if workflow is None:
    print("unknown\t\t\t")
    raise SystemExit(0)
workflow_id = str(workflow["id"])
try:
    tasks = list(con.execute("select id, status, coalesce(error, '') as error from tasks where workflow_id = ?", (workflow_id,)))
except sqlite3.Error:
    print("unknown\t\t\t")
    raise SystemExit(0)
failed = next((task for task in tasks if str(task["status"] or "").lower() in {"failed", "cancelled", "canceled"}), None)
if failed is not None:
    error = str(failed["error"] or failed["status"] or "failed").replace("\t", " ").replace("\n", " ")
    print(f"failed\t{workflow_id}\t{failed['id']}\t{error}")
    raise SystemExit(0)
if tasks and all(str(task["status"] or "").lower() in {"completed", "skipped", "review_ready"} for task in tasks):
    print(f"finished\t{workflow_id}\t\t")
    raise SystemExit(0)
print(f"active\t{workflow_id}\t\t")
PY
}

bot_review_thread_detail() {
  local num="$1"
  local owner="${TARGET_REPO%%/*}"
  local repo_name="${TARGET_REPO#*/}"
  local out
  if [ -z "$owner" ] || [ -z "$repo_name" ] || [ "$owner" = "$repo_name" ]; then
    printf ''
    return 0
  fi
  out="$(gh_json api graphql \
    -F owner="$owner" \
    -F name="$repo_name" \
    -F number="$num" \
    -f query='query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 50) { nodes { id isResolved isOutdated comments(first: 20) { nodes { author { login } body } } } } } } }' \
    </dev/null)" \
    || {
      printf ''
      return 0
    }
  jq -r '
    def one_line:
      tostring
      | gsub("[\r\n\t]+"; " ")
      | gsub(" +"; " ")
      | .[0:240];
    def bot_author($login):
      $login == "coderabbitai"
      or $login == "coderabbitai[bot]"
      or $login == "github-actions[bot]";
    [
      .data.repository.pullRequest.reviewThreads.nodes[]?
      | select(.isResolved != true)
      | select(.isOutdated != true)
      | . as $thread
      | [
          $thread.comments.nodes[]?
          | select((.author.login // "") as $login | bot_author($login))
        ][0] as $comment
      | select($comment != null)
      | "unresolved bot review thread \($thread.id // "unknown") by \($comment.author.login // "unknown"): \($comment.body | one_line)"
    ][0] // ""
  ' <<<"$out" 2>/dev/null || true
}

while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"

  if [ "$(jq -r '.isDraft' <<<"$pr")" = "true" ]; then
    log_line "PR #$num: draft; skipping"
    continue
  fi

  # Classify in priority order: conflict > failed checks > changes requested.
  category=""
  detail=""
  mergeable="$(jq -r '.mergeable // ""' <<<"$pr")"
  merge_state="$(jq -r '.mergeStateStatus // ""' <<<"$pr")"
  if [ "$mergeable" = "CONFLICTING" ] || [ "$merge_state" = "DIRTY" ]; then
    category="conflict"
    detail="GitHub reports a merge conflict against $(jq -r '.baseRefName' <<<"$pr")"
  fi
  if [ -z "$category" ]; then
    failed_checks="$(jq -r '[.statusCheckRollup[]? | select((.conclusion // "") as $c
      | $c == "FAILURE" or $c == "ERROR" or $c == "TIMED_OUT" or $c == "CANCELLED")
      | .name] | unique | join(", ")' <<<"$pr")"
    if [ -n "$failed_checks" ]; then
      category="failed_checks"
      detail="$failed_checks"
    fi
  fi
  if [ -z "$category" ]; then
    bot_thread_detail="$(bot_review_thread_detail "$num")"
    if [ -n "$bot_thread_detail" ]; then
      category="bot_review_thread"
      detail="$bot_thread_detail"
    fi
  fi
  if [ -z "$category" ] && [ "$(jq -r '.reviewDecision // ""' <<<"$pr")" = "CHANGES_REQUESTED" ]; then
    category="changes_requested"
    detail="a reviewer requested changes; address the open feedback"
  fi
  if [ -z "$category" ]; then
    log_line "PR #$num: no actionable blocker found; skipping"
    continue
  fi

  head_oid="$(jq -r '.headRefOid' <<<"$pr")"
  fingerprint="$(printf '%s|%s|%s' "$head_oid" "$category" "$detail" \
    | shasum -a 256 2>/dev/null || printf '%s|%s|%s' "$head_oid" "$category" "$detail" | sha256sum)"
  fingerprint="${fingerprint%% *}"
  fingerprint="${fingerprint:0:16}"

  if ledger_marker_seen queue-submitted "$num" "$fingerprint"; then
    submission_info="$(repair_workflow_submission_state "$num" "$fingerprint")"
    IFS=$'\t' read -r submission_state submission_workflow submission_task submission_error <<<"$submission_info"
    if [ "$submission_state" = "failed" ] && [ -n "$submission_workflow" ]; then
      failed_marker="${fingerprint}:${submission_workflow}"
      if [ "$DRY_RUN" != "1" ] && ! ledger_marker_seen queue-failed "$num" "$failed_marker"; then
        ledger_record queue-failed "$num" "$failed_marker"
        ledger_record queue-attempt "$num" "$fingerprint"
      fi
      if [ "$(ledger_count queue-attempt "$num" "$fingerprint")" -ge "$MAX_ATTEMPTS" ]; then
        if [ "$DRY_RUN" = "1" ]; then
          log_line "PR #$num: DRY-RUN would mark attempt cap reached ($MAX_ATTEMPTS)"
          continue
        fi
        if ! ledger_marker_seen queue-exhausted "$num" "$fingerprint"; then
          ledger_record queue-exhausted "$num" "$fingerprint"
          gh pr comment "$num" --repo "$TARGET_REPO" \
            --body "Invoker admin-bypass queue gave up after $MAX_ATTEMPTS repair-task attempts for this head state. Blocker: $category ($detail). Last failed workflow: $submission_workflow/${submission_task:-unknown} (${submission_error:-failed})" \
            >/dev/null 2>&1 || true
          log_line "PR #$num: attempt cap reached ($MAX_ATTEMPTS); posted exhausted comment"
        fi
        continue
      fi
      log_line "PR #$num: previous repair workflow $submission_workflow failed for this head-state ($fingerprint): ${submission_task:-unknown} (${submission_error:-failed}); retrying"
    else
      log_line "PR #$num: repair already submitted for this head-state ($fingerprint); waiting"
      continue
    fi
  fi
  if [ "$(ledger_count queue-attempt "$num" "$fingerprint")" -ge "$MAX_ATTEMPTS" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      log_line "PR #$num: DRY-RUN would mark attempt cap reached ($MAX_ATTEMPTS)"
      continue
    fi
    if ! ledger_marker_seen queue-exhausted "$num" "$fingerprint"; then
      ledger_record queue-exhausted "$num" "$fingerprint"
      gh pr comment "$num" --repo "$TARGET_REPO" \
        --body "Invoker admin-bypass queue gave up after $MAX_ATTEMPTS repair-task attempts for this head state. Blocker: $category ($detail)" \
        >/dev/null 2>&1 || true
      log_line "PR #$num: attempt cap reached ($MAX_ATTEMPTS); posted exhausted comment"
    fi
    continue
  fi

  # Route.
  wf=""
  if rec="$(resolve_workflow_for_pr "$num")"; then
    wf="$(jq -r '.workflowId // empty' <<<"$rec" 2>/dev/null || true)"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: DRY-RUN would route category=$category wf=${wf:-none} ($detail)"
    continue
  fi

  if [ -n "$wf" ] && [ "$category" = "conflict" ]; then
    if output="$(headless_mutation --no-track rebase-recreate "$wf" 2>&1)"; then
      ledger_record queue-attempt "$num" "$fingerprint"
      ledger_record queue-submitted "$num" "$fingerprint"
      submitted=$((submitted + 1))
      log_line "PR #$num: submitted rebase-recreate for workflow $wf ($fingerprint)"
    else
      log_line "PR #$num: rebase-recreate submit failed: $output"
    fi
    continue
  fi

  if [ -n "$wf" ] && [ "$category" = "failed_checks" ]; then
    if output="$(headless_mutation --no-track repair-review-gate-ci "$num" 2>&1)"; then
      ledger_record queue-attempt "$num" "$fingerprint"
      ledger_record queue-submitted "$num" "$fingerprint"
      submitted=$((submitted + 1))
      log_line "PR #$num: submitted repair-review-gate-ci for PR #$num ($fingerprint)"
    else
      log_line "PR #$num: repair-review-gate-ci submit failed: $output"
    fi
    continue
  fi

  # Unmapped PR, or a category with no dedicated mutation (changes_requested)
  # -> submit an ad-hoc repair plan. Always sets repoUrl (parseRawPlan requires
  # it) so the plan actually loads.
  title="$(jq -r '.title' <<<"$pr")"
  url="$(jq -r '.url' <<<"$pr")"
  head_ref="$(jq -r '.headRefName' <<<"$pr")"
  base_ref="$(jq -r '.baseRefName' <<<"$pr")"
  q_head_ref="$(shell_quote "$head_ref")"
  q_head_oid="$(shell_quote "$head_oid")"
  q_state_file="$(shell_quote "$STATE_FILE")"
  q_num="$(shell_quote "$num")"
  q_fingerprint="$(shell_quote "$fingerprint")"
  q_tsv_kind="$(shell_quote "queue-attempt")"

  plan_file="$PLAN_DIR/repair-pr-$num.yaml"
  {
    printf 'name: admin-bypass-repair-pr-%s-%s\n' "$num" "$fingerprint"
    printf 'onFinish: none\n'
    printf 'mergeMode: manual\n'
    printf 'repoUrl: %s\n' "$REPO_URL"
    printf 'baseBranch: %s\n' "$base_ref"
    printf 'tasks:\n'
    printf '  - id: repair\n'
    printf '    description: "Repair PR #%s (%s): %s"\n' "$num" "$category" "$(printf '%s' "$detail" | tr '"' "'")"
    printf '    prompt: |\n'
    {
      printf 'Repair the existing pull request #%s ("%s") on %s.\n' "$num" "$title" "$TARGET_REPO"
      printf 'PR URL: %s\n' "$url"
      printf 'Head branch: %s (at %s), base branch: %s\n\n' "$head_ref" "$head_oid" "$base_ref"
      printf 'Blocker category: %s\n' "$category"
      printf 'Detail: %s\n\n' "$detail"
      printf 'Work directly on its branch:\n'
      printf '  git fetch origin %s && git checkout %s\n\n' "$head_ref" "$head_ref"
      printf 'Rules:\n'
      printf -- '- If this is a merge conflict, rebase onto origin/%s (or merge it) before anything else.\n' "$base_ref"
      printf -- '- If checks are failing, reproduce and fix them locally.\n'
      printf -- '- If a bot review thread is blocking, verify the inline feedback and fix still-valid issues with minimal changes.\n'
      printf -- '- If changes were requested, address the open feedback with real changes or a reasoned reply, never by dismissing.\n'
      printf -- '- Commit locally if changes are needed.\n'
      printf -- '- Do not push, do not open a new PR, and do not force-push. The safe-push task owns publication.\n'
    } | sed 's/^/      /'
    printf '  - id: safe-push\n'
    printf '    description: "Safely push PR #%s only if its head did not move"\n' "$num"
    printf '    dependencies: [repair]\n'
    printf '    command: |\n'
    {
      printf 'set -euo pipefail\n'
      printf 'branch=%s\n' "$q_head_ref"
      printf 'expected=%s\n' "$q_head_oid"
      printf 'ledger=%s\n' "$q_state_file"
      printf 'kind=%s\n' "$q_tsv_kind"
      printf 'key=%s\n' "$q_num"
      printf 'marker=%s\n' "$q_fingerprint"
      printf 'ref="refs/heads/$branch"\n'
      printf 'live="$(git ls-remote origin "$ref" | cut -f1)"\n'
      printf 'if [ "$live" != "$expected" ]; then\n'
      printf '  echo "stale-head: $ref is ${live:-missing}; expected $expected" >&2\n'
      printf '  exit 20\n'
      printf 'fi\n'
      printf 'pushed="$(git rev-parse HEAD)"\n'
      printf 'git push --force-with-lease="$ref:$expected" origin "HEAD:$ref"\n'
      printf 'verified="$(git ls-remote origin "$ref" | cut -f1)"\n'
      printf 'if [ "$verified" != "$pushed" ]; then\n'
      printf '  echo "post-push verification failed: $ref is ${verified:-missing}; expected $pushed" >&2\n'
      printf '  exit 22\n'
      printf 'fi\n'
      printf 'mkdir -p "$(dirname "$ledger")"\n'
      printf 'printf '"'"'%%s\\t%%s\\t%%s\\t%%s\\n'"'"' "$kind" "$key" "$marker" "$(date +%%s)" >> "$ledger"\n'
      printf 'echo "pr-worker-safe-push: pushed $ref to $pushed"\n'
    } | sed 's/^/      /'
  } > "$plan_file"

  if output="$(headless_mutation --no-track run "$plan_file" 2>&1)"; then
    ledger_record queue-submitted "$num" "$fingerprint"
    submitted=$((submitted + 1))
    log_line "PR #$num: submitted ad-hoc repair plan (category=$category, $fingerprint)"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log_line "PR #$num: plan submit failed: $line"
    done <<<"$output"
  fi
done < <(jq -c '.[]' <<<"$prs_json")

log_line "admin-bypass queue scan complete; submitted $submitted repair task(s)"
