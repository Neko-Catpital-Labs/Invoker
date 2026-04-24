#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="${REPRO_CHAIN_RUN_ID:-$(date +%Y%m%d%H%M%S)}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-chain-dogfood.XXXXXX")"
DB_DIR="$TMP_ROOT/db"
MARKER_DIR="$TMP_ROOT/markers"
PLAN_DIR="$TMP_ROOT/plans"
CONFIG_PATH="$TMP_ROOT/config.json"
API_PORT="${INVOKER_API_PORT:-$((4300 + (RANDOM % 1000)))}"

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd git
require_cmd gh
require_cmd jq
require_cmd mergify

mkdir -p "$DB_DIR" "$MARKER_DIR" "$PLAN_DIR"
printf '{\n  "autoFixRetries": 0\n}\n' > "$CONFIG_PATH"

export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_ALLOW_DELETE_ALL=1
export INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK=1
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_API_PORT="$API_PORT"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"

ensure_app_built() {
  if [ -f "$ROOT/packages/app/dist/main.js" ] && [ -f "$ROOT/packages/ui/dist/index.html" ]; then
    return 0
  fi
  (
    cd "$ROOT"
    pnpm --filter @invoker/ui build
    pnpm --filter @invoker/app build
  )
}

extract_json_stream() {
  awk '
    BEGIN { started = 0 }
    {
      if (!started) {
        if ($0 ~ /^[[:space:]]*[\[{]/ && $0 !~ /^\[init\]/ && $0 !~ /^\[deprecated\]/) {
          started = 1
          print
        }
      } else {
        print
      }
    }
  '
}

headless() {
  (
    cd "$ROOT"
    ./run.sh --headless "$@"
  )
}

headless_no_track() {
  (
    cd "$ROOT"
    ./run.sh --headless --no-track "$@"
  )
}

query_workflows_json() {
  headless query workflows --output json 2>/dev/null | extract_json_stream
}

query_tasks_json() {
  headless query tasks --output json 2>/dev/null | extract_json_stream
}

wait_workflow_exists() {
  local wf_id="$1"
  for _ in $(seq 1 120); do
    if query_workflows_json | jq -e --arg id "$wf_id" '.[] | select(.id == $id)' >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "workflow did not appear: $wf_id" >&2
  return 1
}

wait_task_status() {
  local workflow_id="$1"
  local task_id="$2"
  local expected="$3"
  local full_task_id="${workflow_id}/${task_id}"
  for _ in $(seq 1 240); do
    local status
    status="$(query_tasks_json | jq -r --arg id "$full_task_id" '.[] | select(.id == $id) | .status' | head -1)"
    if [ "$status" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  echo "task $full_task_id did not reach status $expected" >&2
  query_tasks_json | jq -r --arg id "$full_task_id" '.[] | select(.id == $id)' >&2 || true
  return 1
}

wait_merge_gate_ready() {
  local wf_id="$1"
  local merge_id="__merge__${wf_id}"
  for _ in $(seq 1 240); do
    local status
    status="$(query_tasks_json | jq -r --arg id "$merge_id" '.[] | select(.id == $id) | .status' | head -1)"
    case "$status" in
      review_ready|awaiting_approval)
        printf '%s' "$merge_id"
        return 0
        ;;
    esac
    sleep 1
  done
  echo "merge gate did not become review_ready/awaiting_approval for $wf_id" >&2
  return 1
}

wait_merge_gate_ready_with_kick() {
  local wf_id="$1"
  for attempt in $(seq 1 6); do
    if merge_id="$(wait_merge_gate_ready "$wf_id" 2>/dev/null)"; then
      printf '%s' "$merge_id"
      return 0
    fi
    headless_no_track resume "$wf_id" >/dev/null 2>&1 || true
    sleep 2
  done
  echo "merge gate did not become ready after resume retries for $wf_id" >&2
  return 1
}

wait_pr_for_head() {
  local repo="$1"
  local head="$2"
  for _ in $(seq 1 60); do
    local prs
    prs="$(gh pr list --repo "$repo" --head "$head" --state open --json number,title,url,baseRefName,headRefName 2>/dev/null || true)"
    if [ -n "$prs" ] && [ "$(printf '%s' "$prs" | jq 'length')" -gt 0 ]; then
      printf '%s' "$prs"
      return 0
    fi
    sleep 1
  done
  echo "no PR found for repo=$repo head=$head" >&2
  return 1
}

branch_exists_remote() {
  local repo_url="$1"
  local branch="$2"
  git ls-remote --exit-code --heads "$repo_url" "$branch" >/dev/null 2>&1
}

wait_remote_branch() {
  local repo_url="$1"
  local branch="$2"
  for _ in $(seq 1 120); do
    if branch_exists_remote "$repo_url" "$branch"; then
      return 0
    fi
    sleep 1
  done
  echo "remote branch did not appear: $branch" >&2
  return 1
}

wait_remote_branch_with_kick() {
  local repo_url="$1"
  local branch="$2"
  local wf_id="$3"
  for attempt in $(seq 1 6); do
    if wait_remote_branch "$repo_url" "$branch" 2>/dev/null; then
      return 0
    fi
    headless_no_track resume "$wf_id" >/dev/null 2>&1 || true
    sleep 2
  done
  echo "remote branch did not appear after resume retries: $branch" >&2
  return 1
}

delete_remote_branch_if_exists() {
  local repo_dir="$1"
  local branch="$2"
  if git -C "$repo_dir" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    git -C "$repo_dir" push origin --delete "$branch" >/dev/null 2>&1 || true
  fi
}

ensure_change_id_on_head() {
  if git log -1 --format=%B | grep -q '^Change-Id:'; then
    return 0
  fi
  git commit --amend --no-edit >/dev/null
}

publish_invoker_stack_from_chain() {
  local repo="$1"
  local base_branch="$2"
  local branch1="$3"
  local branch2="$4"
  local clone_dir="$TMP_ROOT/publish-invoker"
  local stack_branch="repro/chain-dogfood-stack-${RUN_ID}"
  local push_log="$TMP_ROOT/mergify-push.log"

  rm -rf "$clone_dir"
  git clone "https://github.com/${repo}" "$clone_dir" >/dev/null 2>&1
  (
    cd "$clone_dir"
    git config user.name "${GIT_AUTHOR_NAME:-EdbertChan}"
    git config user.email "${GIT_AUTHOR_EMAIL:-edbert@example.com}"
    mergify stack setup >/dev/null
    git fetch origin "$base_branch" "$branch1" "$branch2" >/dev/null 2>&1

    local commit1
    local commit2
    commit1="$(git rev-list --reverse "origin/${base_branch}..origin/${branch1}" | tail -1)"
    commit2="$(git rev-list --reverse "origin/${branch1}..origin/${branch2}" | tail -1)"
    [ -n "$commit1" ] || { echo "missing unique commit for $branch1" >&2; exit 1; }
    [ -n "$commit2" ] || { echo "missing unique commit for $branch2" >&2; exit 1; }

    git switch -c "$stack_branch" "origin/${base_branch}" >/dev/null
    git cherry-pick "$commit1" >/dev/null
    ensure_change_id_on_head
    git cherry-pick "$commit2" >/dev/null
    ensure_change_id_on_head

    mergify stack push 2>&1 | tee "$push_log"
  )

  local pr_numbers
  pr_numbers="$(
    grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' "$push_log" |
    sed -E 's#.*/pull/([0-9]+)#\1#' |
    sort -u
  )"
  [ -n "$pr_numbers" ] || { echo "mergify stack push did not print PR URLs" >&2; return 1; }

  local prs_json
  prs_json="$(
    while IFS= read -r pr_number; do
      [ -n "$pr_number" ] || continue
      gh pr view "$pr_number" --repo "$repo" --json number,title,url,baseRefName,headRefName,state
    done <<<"$pr_numbers" | jq -s '.'
  )"

  if [ "$(printf '%s' "$prs_json" | jq 'length')" -ne 2 ]; then
    echo "expected exactly 2 stack PRs for invoker dogfood publication" >&2
    printf '%s\n' "$prs_json" >&2
    return 1
  fi

  local first_base second_base
  first_base="$(printf '%s' "$prs_json" | jq -r 'sort_by(.number)[0].baseRefName')"
  second_base="$(printf '%s' "$prs_json" | jq -r 'sort_by(.number)[1].baseRefName')"
  if [ "$first_base" != "$base_branch" ]; then
    echo "expected first stack PR base=$base_branch, got $first_base" >&2
    return 1
  fi
  if ! printf '%s' "$second_base" | grep -q '^stack/'; then
    echo "expected second stack PR base to be a Mergify stack branch, got $second_base" >&2
    return 1
  fi

  echo "==> invoker dogfood Mergify stack PRs"
  printf '%s\n' "$prs_json" | jq -r '.[] | "- #" + (.number|tostring) + " " + .title + " [" + .baseRefName + " <- " + .headRefName + "] " + .url'

  while IFS= read -r pr_number; do
    [ -n "$pr_number" ] || continue
    gh pr close "$pr_number" --repo "$repo" --delete-branch >/dev/null
  done <<<"$pr_numbers"

  delete_remote_branch_if_exists "$clone_dir" "$stack_branch"
}

create_plan_files() {
  local prefix="$1"
  local repo_url="$2"
  local base_branch="$3"
  local branch1="$4"
  local branch2="$5"
  local plan1="$PLAN_DIR/${prefix}-1.yaml"
  local plan2="$PLAN_DIR/${prefix}-2.template.yaml"
  local task1="${prefix}-task-1"
  local task2="${prefix}-task-2"

  cat >"$plan1" <<EOF
name: "${prefix} workflow 1"
description: |
  Repro workflow 1 for ${repo_url}.
repoUrl: ${repo_url}
parentRemote: origin
baseBranch: ${base_branch}
featureBranch: ${branch1}
onFinish: pull_request
mergeMode: external_review
reviewProvider: github
tasks:
  - id: ${task1}
    description: "Append a unique repro marker to README"
    command: "printf '\\n${prefix} step1 ${RUN_ID}\\n' >> README.md"
    dependencies: []
EOF

  cat >"$plan2" <<EOF
name: "${prefix} workflow 2"
description: |
  Repro workflow 2 for ${repo_url}.
repoUrl: ${repo_url}
parentRemote: origin
baseBranch: ${base_branch}
featureBranch: ${branch2}
onFinish: pull_request
mergeMode: external_review
reviewProvider: github
externalDependencies:
  - workflowId: "__UPSTREAM_WORKFLOW_ID__"
    requiredStatus: completed
tasks:
  - id: ${task2}
    description: "Append a second unique repro marker to README"
    command: "printf '\\n${prefix} step2 ${RUN_ID}\\n' >> README.md"
    dependencies: []
EOF

  printf '%s\n%s\n' "$plan1" "$plan2"
}

run_chain_case() {
  local label="$1"
  local repo="$2"
  local base_branch="$3"
  local mode="$4"
  local branch1="repro/${label}-${RUN_ID}-1"
  local branch2="repro/${label}-${RUN_ID}-2"
  local repo_url="https://github.com/${repo}"
  local plan_paths
  local plan1
  local plan2
  local output
  local wf1
  local wf2
  echo "==> ${label}: creating chain plans for ${repo}"
  plan_paths="$(create_plan_files "$label" "$repo_url" "$base_branch" "$branch1" "$branch2")"
  plan1="$(printf '%s' "$plan_paths" | sed -n '1p')"
  plan2="$(printf '%s' "$plan_paths" | sed -n '2p')"

  echo "==> ${label}: submitting workflow chain"
  output="$(
    cd "$ROOT" && \
    bash scripts/submit-workflow-chain.sh "$plan1" "$plan2"
  )"
  printf '%s\n' "$output"

  wf1="$(printf '%s\n' "$output" | sed -n 's/^WF1=\([^ ]*\).*/\1/p' | tail -1)"
  wf2="$(printf '%s\n' "$output" | sed -n 's/^WF2=\([^ ]*\).*/\1/p' | tail -1)"
  [ -n "$wf1" ] || { echo "failed to parse WF1 from chain output" >&2; return 1; }
  [ -n "$wf2" ] || { echo "failed to parse WF2 from chain output" >&2; return 1; }

  wait_workflow_exists "$wf1"
  wait_workflow_exists "$wf2"
  echo "==> ${label}: resume workflow 1 to drive orphaned work"
  headless_no_track resume "$wf1" >/dev/null 2>&1 || true

  if [ "$mode" = "mergify" ]; then
    local merge1
    local merge2
    merge1="$(wait_merge_gate_ready_with_kick "$wf1")"
    wait_remote_branch_with_kick "$repo_url" "$branch1" "$wf1"
    echo "==> ${label}: resume workflow 2 after upstream gate is ready"
    headless_no_track resume "$wf2" >/dev/null 2>&1 || true
    merge2="$(wait_merge_gate_ready_with_kick "$wf2")"
    wait_remote_branch_with_kick "$repo_url" "$branch2" "$wf2"
    echo "==> ${label}: merge gates ready ($merge1, $merge2)"
    publish_invoker_stack_from_chain "$repo" "$base_branch" "$branch1" "$branch2"
    local cleanup_dir="$TMP_ROOT/${label}-cleanup"
    rm -rf "$cleanup_dir"
    git clone "$repo_url" "$cleanup_dir" >/dev/null 2>&1
    delete_remote_branch_if_exists "$cleanup_dir" "$branch1"
    delete_remote_branch_if_exists "$cleanup_dir" "$branch2"
  else
    local merge1
    local merge2
    merge1="$(wait_merge_gate_ready_with_kick "$wf1")"
    wait_remote_branch_with_kick "$repo_url" "$branch1" "$wf1"
    echo "==> ${label}: resume workflow 2 after upstream gate is ready"
    headless_no_track resume "$wf2" >/dev/null 2>&1 || true
    merge2="$(wait_merge_gate_ready_with_kick "$wf2")"
    wait_remote_branch_with_kick "$repo_url" "$branch2" "$wf2"
    echo "==> ${label}: approving merge gates for ordinary PR creation"
    headless approve "$merge1" >/dev/null
    headless approve "$merge2" >/dev/null

    local pr1_json
    local pr2_json
    pr1_json="$(wait_pr_for_head "$repo" "$branch1")"
    pr2_json="$(wait_pr_for_head "$repo" "$branch2")"

    local pr1_base pr2_base pr1_number pr2_number
    pr1_base="$(printf '%s' "$pr1_json" | jq -r '.[0].baseRefName')"
    pr2_base="$(printf '%s' "$pr2_json" | jq -r '.[0].baseRefName')"
    pr1_number="$(printf '%s' "$pr1_json" | jq -r '.[0].number')"
    pr2_number="$(printf '%s' "$pr2_json" | jq -r '.[0].number')"

    if [ "$pr1_base" != "$base_branch" ]; then
      echo "expected first external PR base=$base_branch, got $pr1_base" >&2
      return 1
    fi
    if [ "$pr2_base" != "$branch1" ]; then
      echo "expected second external PR base=$branch1, got $pr2_base" >&2
      return 1
    fi

    echo "==> ${label}: ordinary chained PRs"
    printf '%s\n%s\n' "$pr1_json" "$pr2_json" | jq -s 'add | .[] | "- #" + (.number|tostring) + " " + .title + " [" + .baseRefName + " <- " + .headRefName + "] " + .url' -r

    gh pr close "$pr2_number" --repo "$repo" --delete-branch >/dev/null
    gh pr close "$pr1_number" --repo "$repo" --delete-branch >/dev/null
  fi
}

ensure_app_built

echo "==> resetting isolated Invoker DB"
headless delete-all >/dev/null 2>&1 || true

run_chain_case "invoker-dogfood" "EdbertChan/Invoker" "master" "mergify"
run_chain_case "external-playground" "EdbertChan/test-playground" "main" "ordinary"

echo "PASS repro-chain-dogfood-vs-external"
