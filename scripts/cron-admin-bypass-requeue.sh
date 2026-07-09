#!/usr/bin/env bash
# Job 3 — scan admin-bypass PRs, repair finished failures, and queue passed stack bottoms.
#
# Every tick:
#   - scan open PRs carrying `admin-bypass`
#   - collapse them into stacks
#   - for the lowest admin-bypass PR in each stack:
#       * if CI / PR Body is still running or absent, wait
#       * if finished and failing, open a fresh checkout, let Codex fix it, then
#         push or rerun failed checks
#       * if finished and passing, verify stack order and retoggle admin-bypass on
#         the stack bottom so Mergify re-queues it
#   - for higher admin-bypass PRs in the same stack:
#       * if failures are cancelled-only, rerun those checks
#       * otherwise use the same fix path as the bottom PR
#
# Constraints:
#   - bottom-up only for merge queueing
#   - queue only the stack bottom
#   - AI fixes run outside Invoker in a separate checkout
set -euo pipefail

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

STATE_FILE="${INVOKER_PR_REQUEUE_STATE_FILE:-${HOME}/.invoker/admin-bypass-requeue.tsv}"
WORKDIR="${INVOKER_PR_REQUEUE_WORKDIR:-${HOME}/.invoker/pr-requeue-work}"
MAX_PER_HOUR="${INVOKER_PR_REQUEUE_MAX_ATTEMPTS_PER_HOUR:-0}"
MAX_PER_DAY="${INVOKER_PR_REQUEUE_MAX_ATTEMPTS_PER_DAY:-0}"
REQUEUE_TIMEOUT_SECONDS="${INVOKER_PR_REQUEUE_TIMEOUT_SECONDS:-600}"
QUEUE_COOLDOWN_SECONDS="${INVOKER_PR_REQUEUE_QUEUE_COOLDOWN_SECONDS:-1800}"
OMP_TIMEOUT="${INVOKER_PR_CRON_OMP_TIMEOUT:-45m}"
OMP_COMMAND="${INVOKER_OMP_COMMAND:-omp}"
ACTION_LIMIT="${INVOKER_PR_REQUEUE_ACTION_LIMIT:-1}"
ACTIONS_DONE=0

cron_lock
ledger_init "$STATE_FILE"
mkdir -p "$WORKDIR"

mark_action_taken() {
  [ "$DRY_RUN" = "1" ] && return 0
  ACTIONS_DONE=$((ACTIONS_DONE + 1))
}

action_limit_reached() {
  [ "$DRY_RUN" = "1" ] && return 1
  [ "$ACTIONS_DONE" -ge "$ACTION_LIMIT" ]
}

fetch_open_pulls() {
  if [[ -n "${INVOKER_PR_REQUEUE_PULLS_JSON_FILE:-}" ]]; then
    cat "$INVOKER_PR_REQUEUE_PULLS_JSON_FILE"
    return 0
  fi
  local raw
  raw="$(gh_json api "repos/$TARGET_REPO/pulls?state=open&per_page=100" --paginate 2>/dev/null || true)"
  printf '%s' "$raw" | jq -s 'add // []' 2>/dev/null || printf '[]'
}

stack_specs() {
  python3 -c '
import json, sys
prs = json.load(sys.stdin)

def state(pr):
    return (pr.get("state") or "").lower()

def labels(pr):
    return {label.get("name") for label in pr.get("labels", [])}

def head_ref(pr):
    return pr.get("headRefName") or ((pr.get("head") or {}).get("ref"))

def base_ref(pr):
    return pr.get("baseRefName") or ((pr.get("base") or {}).get("ref"))

open_prs = [pr for pr in prs if state(pr) == "open"]
by_num = {pr["number"]: pr for pr in open_prs}
by_head = {head_ref(pr): pr for pr in open_prs if head_ref(pr)}
children = {}
for pr in open_prs:
    base = base_ref(pr)
    if base:
        children.setdefault(base, []).append(pr)

targets = [pr for pr in open_prs if "admin-bypass" in labels(pr)]
seen = set()
for pr in sorted(targets, key=lambda item: item["number"]):
    overall_bottom = pr
    while base_ref(overall_bottom) in by_head:
        overall_bottom = by_head[base_ref(overall_bottom)]

    target_bottom = pr
    while base_ref(target_bottom) in by_head:
        parent = by_head[base_ref(target_bottom)]
        if "admin-bypass" not in labels(parent):
            break
        target_bottom = parent

    dedupe_key = (overall_bottom["number"], target_bottom["number"])
    if dedupe_key in seen:
        continue
    seen.add(dedupe_key)

    chain = [overall_bottom]
    current = overall_bottom
    ambiguous = False
    while True:
        next_children = sorted(children.get(head_ref(current), []), key=lambda item: item["number"])
        if not next_children:
            break
        if len(next_children) > 1:
            ambiguous = True
            break
        current = next_children[0]
        chain.append(current)

    print(json.dumps({
        "overallBottom": overall_bottom["number"],
        "targetBottom": target_bottom["number"],
        "prs": [item["number"] for item in chain],
        "ambiguous": ambiguous,
    }))
'
}

relevant_check_rows() {
  jq '[.statusCheckRollup[]? | select((.workflowName // "") == "CI" or (.workflowName // "") == "PR Body")]'
}

failed_check_rows() {
  printf '%s' "$1" | relevant_check_rows | python3 -c '
import json, sys
rows = json.load(sys.stdin)
failed = []
for row in rows:
    conclusion = (row.get("conclusion") or row.get("state") or "").upper()
    if conclusion in {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "ERROR"}:
        failed.append(row)
print(json.dumps(failed))
'
}

check_summary() {
  local pr_json="$1"
  printf '%s' "$pr_json" | relevant_check_rows | python3 -c '
import json, sys
rows = json.load(sys.stdin)
active = any((row.get("status") or "").upper() != "COMPLETED" for row in rows)
failed = any((row.get("conclusion") or row.get("state") or "").upper() in {"FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "ERROR"} for row in rows)
finished = len(rows) > 0 and not active
passed = finished and not failed
print(json.dumps({"active": active, "finished": finished, "failed": failed, "passed": passed, "count": len(rows)}))
'
}

cancelled_only_failures() {
  local failed_json="$1"
  printf '%s' "$failed_json" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
print("true" if rows and all((row.get("conclusion") or row.get("state") or "").upper() == "CANCELLED" for row in rows) else "false")
'
}

add_label() {
  local pr="$1" label="$2"
  gh_json api --method POST "repos/$TARGET_REPO/issues/$pr/labels" -f "labels[]=$label" >/dev/null
}

remove_label() {
  local pr="$1" label="$2"
  gh_json api --method DELETE "repos/$TARGET_REPO/issues/$pr/labels/$label" >/dev/null 2>&1 || true
}

attempt_key_hour() { date -u +%Y-%m-%dT%H; }
attempt_key_day() { date -u +%Y-%m-%d; }

cap_reached() {
  local kind="$1" key="$2" label="$3"
  local hour_key day_key
  if [ "$MAX_PER_HOUR" -le 0 ] && [ "$MAX_PER_DAY" -le 0 ]; then
    return 1
  fi
  hour_key="$(attempt_key_hour)"
  day_key="$(attempt_key_day)"
  if [ "$MAX_PER_HOUR" -gt 0 ] && [ "$(ledger_count "$kind-hour" "$key" "$hour_key")" -ge "$MAX_PER_HOUR" ]; then
    log_line "$label: hourly retry cap $MAX_PER_HOUR reached; skip"
    return 0
  fi
  if [ "$MAX_PER_DAY" -gt 0 ] && [ "$(ledger_count "$kind-day" "$key" "$day_key")" -ge "$MAX_PER_DAY" ]; then
    log_line "$label: daily retry cap $MAX_PER_DAY reached; skip"
    return 0
  fi
  return 1
}

record_attempt() {
  local kind="$1" key="$2"
  ledger_record "$kind-hour" "$key" "$(attempt_key_hour)"
  ledger_record "$kind-day" "$key" "$(attempt_key_day)"
}

queue_cooldown_reached() {
  local key="$1" label="$2"
  local last_epoch now
  if [ "$QUEUE_COOLDOWN_SECONDS" -le 0 ]; then
    return 1
  fi
  last_epoch="$(ledger_max_marker "queue-epoch" "$key")"
  [ -n "$last_epoch" ] || return 1
  now="$(date +%s)"
  if [ $((now - last_epoch)) -lt "$QUEUE_COOLDOWN_SECONDS" ]; then
    log_line "$label: queued recently for the same head; cooldown active"
    return 0
  fi
  return 1
}

record_queue_attempt() {
  local key="$1"
  record_attempt queue "$key"
  ledger_record "queue-epoch" "$key" "$(date +%s)"
}

extract_run_id() {
  local url="$1"
  python3 - "$url" <<'PY'
import re, sys
m = re.search(r'/actions/runs/(\d+)', sys.argv[1] or '')
print(m.group(1) if m else '')
PY
}

prepare_checkout() {
  local pr="$1" head_sha="$2"
  local wt="$WORKDIR/pr-$pr"
  local local_ref="refs/heads/cron-src/pr-$pr"
  local branch="cron/admin-bypass-pr-$pr"
  git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" update-ref -d "$local_ref" >/dev/null 2>&1 || true
  if git -C "$REPO_ROOT" fetch --quiet origin "pull/$pr/head:$local_ref" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" worktree add -B "$branch" "$wt" "$local_ref" >/dev/null
    printf '%s\n' "$wt"
    return 0
  fi
  git -C "$REPO_ROOT" fetch --quiet origin "$head_sha" >/dev/null 2>&1 || return 1
  git -C "$REPO_ROOT" worktree add -B "$branch" "$wt" "$head_sha" >/dev/null
  printf '%s\n' "$wt"
}

is_generated_stack_branch() {
  local branch="$1"
  python3 - "$branch" <<'PY'
import sys
parts = (sys.argv[1] or '').split('/')
print('1' if len(parts) >= 4 and parts[0] == 'stack' else '0')
PY
}

derive_stack_parent_branch() {
  local branch="$1"
  python3 - "$branch" <<'PY'
import sys
parts = (sys.argv[1] or '').split('/')
if len(parts) < 4 or parts[0] != 'stack':
    sys.exit(1)
print('/'.join(parts[2:-1]))
PY
}

prepare_stack_parent_checkout() {
  local pr="$1" head_branch="$2" head_sha="$3" base_branch="$4"
  local parent_branch wt="$WORKDIR/pr-$pr" local_ref="refs/heads/cron-src/pr-$pr"
  parent_branch="$(derive_stack_parent_branch "$head_branch")" || return 1
  git -C "$REPO_ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" update-ref -d "$local_ref" >/dev/null 2>&1 || true
  git -C "$REPO_ROOT" fetch --quiet origin "$base_branch" >/dev/null 2>&1 || return 1
  if ! git -C "$REPO_ROOT" fetch --quiet origin "pull/$pr/head:$local_ref" >/dev/null 2>&1; then
    git -C "$REPO_ROOT" fetch --quiet origin "$head_sha" >/dev/null 2>&1 || return 1
    local_ref="$head_sha"
  fi
  git -C "$REPO_ROOT" worktree add -B "$parent_branch" "$wt" "origin/$base_branch" >/dev/null || return 1
  git -C "$wt" cherry-pick "$local_ref" >/dev/null || {
    git -C "$wt" cherry-pick --abort >/dev/null 2>&1 || true
    return 1
  }
  git -C "$wt" branch --set-upstream-to="origin/$base_branch" "$parent_branch" >/dev/null
  printf '%s\n' "$wt"
}

publish_stack_checkout() {
  local checkout_dir="$1" label="$2" push_log published_pr
  push_log="$(mktemp "$WORKDIR/mergify-stack-push.XXXXXX.log")"
  if ! ( cd "$checkout_dir" && mergify stack setup >/dev/null && mergify stack push --skip-rebase --keep-pull-request-title-and-body --no-verify ) >"$push_log" 2>&1; then
    cat "$push_log" >&2
    rm -f "$push_log"
    return 1
  fi
  published_pr="$(grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' "$push_log" | sed -E 's#.*/pull/([0-9]+)#\1#' | awk 'NF { value=$0 } END { print value }')"
  rm -f "$push_log"
  if [ -z "$published_pr" ]; then
    log_line "$label: mergify stack push finished without publishing a PR URL"
    return 1
  fi
  printf '%s\n' "$published_pr"
}

publish_checkout_update() {
  local pr="$1" head_branch="$2" head_sha="$3" base_branch="$4" checkout_dir="$5" label="$6"
  local stack_pr remote_after_json remote_after_sha remote_after_state
  if [ "$(is_generated_stack_branch "$head_branch")" = "1" ]; then
    stack_pr="$(publish_stack_checkout "$checkout_dir" "$label")" || return 1
    remote_after_json="$(gh_json pr view "$stack_pr" --repo "$TARGET_REPO" --json number,headRefOid,state 2>/dev/null || printf '{}')"
    remote_after_sha="$(jq -r '.headRefOid // empty' <<<"$remote_after_json")"
    remote_after_state="$(jq -r '.state // empty' <<<"$remote_after_json")"
    if [ "$remote_after_state" = "OPEN" ]; then
      add_label "$stack_pr" admin-bypass
      remove_label "$stack_pr" dequeued
    fi
    printf '%s\t%s\t%s\n' "$stack_pr" "$remote_after_sha" "$remote_after_state"
    return 0
  fi

  local local_head
  local_head="$(git -C "$checkout_dir" rev-parse HEAD 2>/dev/null || printf '')"
  remote_after_json="$(gh_json pr view "$pr" --repo "$TARGET_REPO" --json number,headRefOid,state 2>/dev/null || printf '{}')"
  remote_after_sha="$(jq -r '.headRefOid // empty' <<<"$remote_after_json")"
  if [ -n "$local_head" ] && [ "$local_head" != "$head_sha" ] && [ "$remote_after_sha" = "$head_sha" ] && [ -n "$head_branch" ]; then
    git -C "$checkout_dir" push origin "HEAD:$head_branch" >/dev/null
    remote_after_json="$(gh_json pr view "$pr" --repo "$TARGET_REPO" --json number,headRefOid,state 2>/dev/null || printf '{}')"
    remote_after_sha="$(jq -r '.headRefOid // empty' <<<"$remote_after_json")"
  fi
  printf '%s\t%s\t%s\n' "$pr" "$remote_after_sha" "$(jq -r '.state // empty' <<<"$remote_after_json")"
}


ensure_local_pr_head() {
  local pr="$1" head_branch="$2" head_sha="$3"
  local local_ref="refs/heads/cron-src/stack-$pr"
  git -C "$REPO_ROOT" update-ref -d "$local_ref" >/dev/null 2>&1 || true
  if [ -n "$head_branch" ] && git -C "$REPO_ROOT" fetch --quiet origin "$head_branch:$local_ref" >/dev/null 2>&1; then
    return 0
  fi
  if git -C "$REPO_ROOT" fetch --quiet origin "pull/$pr/head:$local_ref" >/dev/null 2>&1; then
    return 0
  fi
  if [ -n "$head_sha" ] && git -C "$REPO_ROOT" fetch --quiet origin "$head_sha" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

capture_failed_checks_context() {
  local failed_json="$1" ctx_dir="$2"
  local rows_file="$ctx_dir/failed-checks.jsonl"
  : > "$rows_file"
  while IFS= read -r row; do
    [ -z "$row" ] && continue
    local details_url run_id log_path=""
    details_url="$(jq -r '.detailsUrl // empty' <<<"$row")"
    run_id="$(extract_run_id "$details_url")"
    if [ -n "$run_id" ]; then
      log_path="$ctx_dir/run-$run_id.log"
      if [ ! -f "$log_path" ]; then
        if ! gh run view "$run_id" --repo "$TARGET_REPO" --log-failed >"$log_path" 2>/dev/null; then
          rm -f "$log_path"
          log_path=""
        fi
      fi
    fi
    jq -n --argjson row "$row" --arg runId "$run_id" --arg logPath "$log_path" '
      $row + {
        runId: (if $runId == "" then null else ($runId | tonumber) end),
        logPath: (if $logPath == "" then null else $logPath end)
      }
    ' >> "$rows_file"
  done < <(jq -c '.[]' <<<"$failed_json")
  jq -s '.' "$rows_file"
}

build_fix_prompt() {
  local pr="$1" base_branch="$2" ctx_file="$3"
  cat <<EOF
You are fixing finished failing checks on GitHub PR #$pr in repository $TARGET_REPO.

A fresh checkout of the PR branch is already open in this working directory.
Failure context is in: $ctx_file
It includes PR metadata, stack order, the failed CI / PR Body checks, and local paths
for failed-step logs when GitHub exposed them.

Do this:
1. Read $ctx_file and any logPath files it references.
2. Inspect the actual PR diff with:
   - git log origin/$base_branch..HEAD
   - git diff origin/$base_branch...HEAD
3. Make the smallest real fix for the listed failures.
4. If the problem is clearly non-code (for example PR metadata or rerun-only infra),
   you may use gh instead of editing code.
5. Run only the targeted local checks you need.
6. Commit changes locally if you make any. Push is optional; the wrapper will push a
   new local HEAD if needed.

Constraints:
- Do not open a new PR.
- Change only what the listed failures require.
- No unrelated cleanup or formatting.
EOF
}

launch_omp_fix() {
  local pr="$1" base_branch="$2" ctx_file="$3" checkout_dir="$4"
  local prompt
  prompt="$(build_fix_prompt "$pr" "$base_branch" "$ctx_file")"
  local omp_args=(--no-title --auto-approve)
  [ -n "${INVOKER_PR_CRON_OMP_MODEL:-}" ] && omp_args+=(--model "$INVOKER_PR_CRON_OMP_MODEL")
  omp_args+=(-p "$prompt")
  local omp_run=("$OMP_COMMAND" "${omp_args[@]}")
  if command -v timeout >/dev/null 2>&1; then
    omp_run=(timeout --kill-after=1m "$OMP_TIMEOUT" "$OMP_COMMAND" "${omp_args[@]}")
  fi
  ( cd "$checkout_dir" && "${omp_run[@]}" )
}

rerun_failed_runs() {
  local failed_json="$1" label="$2"
  local runs
  runs="$(jq -r '.[] | .detailsUrl // empty' <<<"$failed_json" | while IFS= read -r url; do [ -n "$url" ] && extract_run_id "$url"; done | awk 'NF && !seen[$0]++ { print $0 }')"
  if [ -z "$runs" ]; then
    log_line "$label: no rerunnable GitHub Actions runs found"
    return 1
  fi
  local run_id
  while IFS= read -r run_id; do
    [ -z "$run_id" ] && continue
    gh run rerun "$run_id" --repo "$TARGET_REPO" --failed >/dev/null
    log_line "$label: reran failed jobs for run $run_id"
  done <<<"$runs"
}

rerun_cancelled_pr() {
  local pr="$1" pr_json="$2" label="$3"
  local head_sha failed_json key
  head_sha="$(jq -r '.headRefOid // empty' <<<"$pr_json")"
  key="$pr@$head_sha"
  if cap_reached rerun "$key" "$label"; then
    return 0
  fi
  failed_json="$(failed_check_rows "$pr_json")"
  if [ "$DRY_RUN" = "1" ]; then
    log_line "$label: would rerun cancelled CI for PR #$pr"
    return 0
  fi
  record_attempt rerun "$key"
  rerun_failed_runs "$failed_json" "$label"
  mark_action_taken
}

evaluate_higher_stack_prs() {
  local bottom="$1" chain_text="$2" label="$3"
  local pr pr_json pr_state summary failed_json member_label
  for pr in $chain_text; do
    [ "$pr" = "$bottom" ] && continue
    pr_json="$(gh_json pr view "$pr" --repo "$TARGET_REPO" --json number,title,headRefName,baseRefName,headRefOid,labels,statusCheckRollup,state 2>/dev/null || printf '{}')"
    pr_state="$(jq -r '.state // empty' <<<"$pr_json")"
    member_label="$label member #$pr"
    if [ "$pr_state" = "CLOSED" ]; then
      if [ "$DRY_RUN" != "1" ]; then
        clear_closed_pr_labels "$pr"
      fi
      log_line "$member_label: PR #$pr is closed; skip"
      continue
    fi
    summary="$(check_summary "$pr_json")"
    if [[ "$(jq -r '.active' <<<"$summary")" = "true" ]]; then
      log_line "$member_label: CI / PR Body still running on PR #$pr; wait"
      return 2
    fi
    if [[ "$(jq -r '.finished' <<<"$summary")" != "true" ]]; then
      log_line "$member_label: CI / PR Body not finished on PR #$pr; wait"
      return 2
    fi
    if [[ "$(jq -r '.passed' <<<"$summary")" = "true" ]]; then
      continue
    fi
    failed_json="$(failed_check_rows "$pr_json")"
    if [ "$(cancelled_only_failures "$failed_json")" = "true" ]; then
      rerun_cancelled_pr "$pr" "$pr_json" "$member_label" || return 1
      return 3
    fi
    fix_failed_pr "$pr" "$chain_text" "$pr_json" "$member_label" || return 1
    return 3
  done
  return 0
}

fix_failed_pr() {
  local pr="$1" chain_text="$2" pr_json="$3" label="$4"
  local head_branch head_sha base_branch title failed_json key checkout_dir ctx_dir ctx_file enriched_json
  head_branch="$(jq -r '.headRefName // empty' <<<"$pr_json")"
  head_sha="$(jq -r '.headRefOid // empty' <<<"$pr_json")"
  base_branch="$(jq -r '.baseRefName // empty' <<<"$pr_json")"
  title="$(jq -r '.title // empty' <<<"$pr_json")"
  key="$pr@$head_sha"

  if cap_reached fix "$key" "$label"; then
    return 0
  fi

  failed_json="$(failed_check_rows "$pr_json")"
  if [ "$DRY_RUN" = "1" ]; then
    if [ "$(is_generated_stack_branch "$head_branch")" = "1" ]; then
      log_line "$label: would launch Codex fix and republish via Mergify stack for PR #$pr (chain [$chain_text])"
    else
      log_line "$label: would launch Codex fix for PR #$pr (chain [$chain_text])"
    fi
    return 0
  fi

  record_attempt fix "$key"
  if [ "$(is_generated_stack_branch "$head_branch")" = "1" ]; then
    checkout_dir="$(prepare_stack_parent_checkout "$pr" "$head_branch" "$head_sha" "$base_branch")" || {
      log_line "$label: could not prepare parent stack checkout for PR #$pr"
      return 1
    }
  else
    checkout_dir="$(prepare_checkout "$pr" "$head_sha")" || {
      log_line "$label: could not prepare checkout for PR #$pr"
      return 1
    }
  fi
  ctx_dir="$(mktemp -d "$WORKDIR/ctx-$pr.XXXXXX")"
  trap "rm -rf '$ctx_dir'" RETURN
  enriched_json="$(capture_failed_checks_context "$failed_json" "$ctx_dir")"
  ctx_file="$ctx_dir/context.json"
  jq -n \
    --arg repo "$TARGET_REPO" \
    --arg checkoutDir "$checkout_dir" \
    --arg chain "$chain_text" \
    --arg pr "$pr" \
    --arg title "$title" \
    --arg headBranch "$head_branch" \
    --arg baseBranch "$base_branch" \
    --arg headSha "$head_sha" \
    --argjson failedChecks "$enriched_json" \
    '{
      repo: $repo,
      checkoutDir: $checkoutDir,
      stackPrs: ($chain | split(" ") | map(select(length > 0) | tonumber)),
      pr: {
        number: ($pr | tonumber),
        title: $title,
        headBranch: $headBranch,
        baseBranch: $baseBranch,
        headSha: $headSha
      },
      failedChecks: $failedChecks
    }' > "$ctx_file"

  if ! launch_omp_fix "$pr" "$base_branch" "$ctx_file" "$checkout_dir"; then
    log_line "$label: Codex fix run failed for PR #$pr"
    return 1
  fi

  local publish_row published_pr remote_after_sha remote_after_state
  publish_row="$(publish_checkout_update "$pr" "$head_branch" "$head_sha" "$base_branch" "$checkout_dir" "$label")" || {
    log_line "$label: could not publish updated checkout for PR #$pr"
    return 1
  }
  published_pr="$(printf '%s' "$publish_row" | cut -f1)"
  remote_after_sha="$(printf '%s' "$publish_row" | cut -f2)"
  remote_after_state="$(printf '%s' "$publish_row" | cut -f3)"

  if [ -n "$remote_after_sha" ] && [ "$remote_after_sha" != "$head_sha" ]; then
    mark_action_taken
    if [ -n "$published_pr" ] && [ "$published_pr" != "$pr" ]; then
      log_line "$label: republished Mergify stack as PR #$published_pr; waiting on fresh CI"
    else
      log_line "$label: updated PR #$pr head $head_sha -> $remote_after_sha; waiting on fresh CI"
    fi
    return 0
  fi
  if [ "$remote_after_state" = "CLOSED" ]; then
    if [ -n "$published_pr" ] && [ "$published_pr" != "$pr" ]; then
      log_line "$label: republished stack PR #$published_pr is closed; skip queueing"
    else
      log_line "$label: PR #$pr is closed after publish; skip queueing"
    fi
    return 0
  fi

  rerun_failed_runs "$failed_json" "$label"
  mark_action_taken
}

queue_passing_stack() {
  local bottom="$1" chain_text="$2" bottom_json="$3" label="$4"
  local head_sha key head_branch head_sha_each pr_json pr
  head_sha="$(jq -r '.headRefOid // empty' <<<"$bottom_json")"
  head_branch="$(jq -r '.headRefName // empty' <<<"$bottom_json")"
  key="$bottom@$head_sha"

  if cap_reached queue "$key" "$label"; then
    return 0
  fi
  if queue_cooldown_reached "$key" "$label"; then
    return 0
  fi

  if [ "$DRY_RUN" = "1" ]; then
    log_line "$label: would queue passing stack [$chain_text] via bottom PR #$bottom"
    return 0
  fi

  for pr in $chain_text; do
    pr_json="$(gh_json pr view "$pr" --repo "$TARGET_REPO" --json number,headRefName,headRefOid 2>/dev/null || printf '{}')"
    head_branch="$(jq -r '.headRefName // empty' <<<"$pr_json")"
    head_sha_each="$(jq -r '.headRefOid // empty' <<<"$pr_json")"
    if ! ensure_local_pr_head "$pr" "$head_branch" "$head_sha_each"; then
      log_line "$label: could not fetch PR #$pr head locally"
      return 1
    fi
  done

  if ! ( cd "$REPO_ROOT" && run_with_optional_timeout "$REQUEUE_TIMEOUT_SECONDS" node scripts/land-stack.mjs $chain_text ); then
    log_line "$label: land-stack verification failed for [$chain_text]"
    return 1
  fi

  record_queue_attempt "$key"
  for pr in $chain_text; do
    remove_label "$pr" dequeued
  done
  remove_label "$bottom" admin-bypass
  add_label "$bottom" admin-bypass
  mark_action_taken
  log_line "$label: queued stack [$chain_text] via bottom PR #$bottom"
}

clear_closed_pr_labels() {
  local pr="$1"
  remove_label "$pr" admin-bypass
  remove_label "$pr" dequeued
}

process_stack() {
  local spec_json="$1"
  local overall_bottom target_bottom ambiguous chain_text label target_json summary target_state
  overall_bottom="$(jq -r '.overallBottom' <<<"$spec_json")"
  target_bottom="$(jq -r '.targetBottom' <<<"$spec_json")"
  ambiguous="$(jq -r '.ambiguous' <<<"$spec_json")"
  chain_text="$(jq -r '.prs | join(" ")' <<<"$spec_json")"
  label="stack overall #$overall_bottom target #$target_bottom"

  if [[ "$ambiguous" = "true" ]]; then
    log_line "$label: ambiguous child linkage; skip"
    return 0
  fi

  if [ "$overall_bottom" != "$target_bottom" ]; then
    log_line "$label: lower PR without admin-bypass blocks stack order; skip"
    return 0
  fi

  target_json="$(gh_json pr view "$target_bottom" --repo "$TARGET_REPO" --json number,title,headRefName,baseRefName,headRefOid,labels,statusCheckRollup,state 2>/dev/null || printf '{}')"
  target_state="$(jq -r '.state // empty' <<<"$target_json")"
  if [ "$target_state" = "CLOSED" ]; then
    if [ "$DRY_RUN" != "1" ]; then
      clear_closed_pr_labels "$target_bottom"
    fi
    log_line "$label: PR #$target_bottom is closed; skip"
    return 0
  fi
  summary="$(check_summary "$target_json")"

  if [[ "$(jq -r '.active' <<<"$summary")" = "true" ]]; then
    log_line "$label: CI / PR Body still running on PR #$target_bottom; wait"
    return 0
  fi
  if [[ "$(jq -r '.failed' <<<"$summary")" = "true" ]]; then
    if ! claim_key "admin-bypass-stack-$target_bottom"; then
      log_line "$label: stack already claimed by another worker; skip"
      return 0
    fi
    fix_failed_pr "$target_bottom" "$chain_text" "$target_json" "$label"
    return $?
  fi
  if [[ "$(jq -r '.passed' <<<"$summary")" = "true" ]]; then
    local higher_status=0
    if ! claim_key "admin-bypass-stack-$target_bottom"; then
      log_line "$label: stack already claimed by another worker; skip"
      return 0
    fi
    evaluate_higher_stack_prs "$target_bottom" "$chain_text" "$label" || higher_status=$?
    case "$higher_status" in
      0)
        queue_passing_stack "$target_bottom" "$chain_text" "$target_json" "$label"
        return $?
        ;;
      2|3)
        return 0
        ;;
      *)
        return 1
        ;;
    esac
  fi

  log_line "$label: no action"
}

pulls_json="$(fetch_open_pulls)"
if ! jq empty >/dev/null 2>&1 <<<"$pulls_json"; then
  log_line "could not parse open pulls JSON; exiting"
  exit 0
fi

matched=0
failed=0
while IFS= read -r spec; do
  [ -z "$spec" ] && continue
  matched=$((matched + 1))
  if ! process_stack "$spec"; then
    failed=$((failed + 1))
  fi
  if action_limit_reached; then
    break
  fi
done < <(printf '%s' "$pulls_json" | stack_specs)

if [ "$matched" -eq 0 ]; then
  log_line "no open admin-bypass PR stacks found"
  exit 0
fi

if [ "$failed" -gt 0 ]; then
  log_line "completed with $failed failed admin-bypass action(s)"
  exit 1
fi

log_line "completed admin-bypass scan for $matched stack(s)"
