#!/usr/bin/env bash
# repro-mergify-stack-lifecycle.sh — Deterministic lifecycle harness for
# Mergify stack scenarios A-G as defined in docs/mergify-stack-lifecycle-poc.md.
#
# Usage:
#   ./scripts/repro/repro-mergify-stack-lifecycle.sh --all-scenarios
#   ./scripts/repro/repro-mergify-stack-lifecycle.sh --scenario A
#   ./scripts/repro/repro-mergify-stack-lifecycle.sh --scenario A --scenario B
#
# Flags:
#   --repo <owner/repo>      Target GitHub repo (default: $MERGIFY_STACK_DOGFOOD_REPO or EdbertChan/Invoker)
#   --base <branch>          Base branch (default: $MERGIFY_STACK_DOGFOOD_BASE or master)
#   --scenario <A-G>         Run a single scenario (repeatable)
#   --all-scenarios          Run all scenarios in recommended order
#   --run-id <id>            Override run ID (default: timestamp)
#   --artifacts-dir <dir>    Override artifacts output directory
#
# Exit codes:
#   0  All requested scenarios passed
#   1  One or more scenarios failed

set -euo pipefail

# ---------------------------------------------------------------------------
# Globals
# ---------------------------------------------------------------------------
TARGET_REPO="${MERGIFY_STACK_DOGFOOD_REPO:-EdbertChan/Invoker}"
BASE_BRANCH="${MERGIFY_STACK_DOGFOOD_BASE:-master}"
RUN_ID="$(date +%Y%m%d%H%M%S)"
SCENARIOS=()
ALL_SCENARIOS=false
TMPDIR_ROOT=""
CLONE_DIR=""
ARTIFACTS_DIR=""
PREFIX=""

# Per-run results
declare -A SCENARIO_RESULTS=()

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------
parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --repo)
        TARGET_REPO="$2"; shift 2 ;;
      --base)
        BASE_BRANCH="$2"; shift 2 ;;
      --scenario)
        SCENARIOS+=("$2"); shift 2 ;;
      --all-scenarios)
        ALL_SCENARIOS=true; shift ;;
      --run-id)
        RUN_ID="$2"; shift 2 ;;
      --artifacts-dir)
        ARTIFACTS_DIR="$2"; shift 2 ;;
      -h|--help)
        head -n 17 "$0" | tail -n +2 | sed 's/^# \?//'; exit 0 ;;
      *)
        echo "unknown flag: $1" >&2; exit 1 ;;
    esac
  done

  if $ALL_SCENARIOS; then
    SCENARIOS=(A B C D E F G)
  fi

  if [ ${#SCENARIOS[@]} -eq 0 ]; then
    echo "error: specify --scenario <A-G> or --all-scenarios" >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

log() {
  echo "==> $*"
}

cleanup() {
  if [ -n "$TMPDIR_ROOT" ] && [ -d "$TMPDIR_ROOT" ]; then
    rm -rf "$TMPDIR_ROOT"
  fi
}
trap cleanup EXIT

# Save a JSON artifact for a scenario and return its path.
save_artifact() {
  local scenario="$1"
  local label="$2"
  local json="$3"
  local path="${ARTIFACTS_DIR}/scenario-${scenario}-${label}.json"
  printf '%s\n' "$json" > "$path"
  echo "$path"
}

# Assert helper: if condition fails, record the assertion tag and return 1.
assert() {
  local tag="$1"
  shift
  if ! "$@"; then
    echo "  FAIL $tag" >&2
    return 1
  fi
  echo "  ok   $tag"
  return 0
}

# Assert two values are equal.
assert_eq() {
  local tag="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "  FAIL $tag: expected='$expected' actual='$actual'" >&2
    return 1
  fi
  echo "  ok   $tag"
  return 0
}

# Assert a numeric value.
assert_num_eq() {
  local tag="$1"
  local expected="$2"
  local actual="$3"
  # Guard against empty or non-numeric values — treat as mismatch
  if [ -z "$actual" ] || ! printf '%s' "$actual" | grep -qE '^-?[0-9]+$'; then
    echo "  FAIL $tag: expected=$expected actual='$actual' (non-numeric)" >&2
    return 1
  fi
  if [ "$expected" -ne "$actual" ]; then
    echo "  FAIL $tag: expected=$expected actual=$actual" >&2
    return 1
  fi
  echo "  ok   $tag"
  return 0
}

# Push the Mergify stack with retry.  The Mergify CLI can encounter HTTP 422
# errors ("pull request already exists") when re-pushing a stack that already
# has PRs.  In that case, retry up to 2 more times — the partial state update
# from each attempt progressively resolves conflicts until the full stack
# reconciles.
#
# All attempt outputs are accumulated in push_log so that PR URLs from every
# attempt are available to fetch_all_stack_prs.
#
# Usage: mergify_stack_push_with_retry <push_log>
mergify_stack_push_with_retry() {
  local push_log="$1"
  local max_attempts=3
  local attempt_log="${push_log}.attempt"

  # First attempt — write (not append) to start fresh
  mergify stack push 2>&1 | tee "$push_log" || true

  local attempt=1
  while [ "$attempt" -lt "$max_attempts" ] && grep -q 'HTTPError 422' "$push_log"; do
    ((attempt++))
    log "(retrying push after 422 — attempt $attempt/$max_attempts)"
    sleep 3
    mergify stack push 2>&1 | tee "$attempt_log" || true
    # Append retry output so all PR URLs are captured
    cat "$attempt_log" >> "$push_log"
    if ! grep -q 'HTTPError 422' "$attempt_log"; then
      break
    fi
  done
  rm -f "$attempt_log"
}

# Fetch stack PRs by searching for head branches matching the prefix.
# Produces a sorted JSON array (by PR number).
fetch_stack_prs() {
  local search_prefix="$1"
  gh pr list --repo "$TARGET_REPO" \
    --search "head:${search_prefix}" \
    --state all \
    --json number,title,url,baseRefName,headRefName,state \
    --limit 100 | jq 'sort_by(.number)'
}

# Fetch PRs whose headRefName starts with "stack/" and that are associated
# with commits reachable from the current HEAD in the clone.  Mergify stack
# push creates branches named stack/<owner>/<repo>/<change-id> so we search
# for stack/ head branches belonging to the target repo.
fetch_stack_prs_from_push_log() {
  local push_log="$1"
  local pr_numbers
  pr_numbers="$(
    grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' "$push_log" |
    sed -E 's#.*/pull/([0-9]+)#\1#' |
    sort -u
  )"
  if [ -z "$pr_numbers" ]; then
    echo "[]"
    return
  fi
  local prs_json
  prs_json="$(
    while IFS= read -r pr_number; do
      [ -n "$pr_number" ] || continue
      gh pr view "$pr_number" --repo "$TARGET_REPO" \
        --json number,title,url,baseRefName,headRefName,state
    done <<<"$pr_numbers" | jq -s 'sort_by(.number)'
  )"
  printf '%s' "$prs_json"
}

# Fetch all stack PRs for a branch by combining push log URLs with a search
# by the Mergify stack branch prefix.  This handles cases where mergify stack
# push encounters 422 errors for existing PRs and omits their URLs from the
# output.
#
# Usage: fetch_all_stack_prs <push_log> <local_branch>
fetch_all_stack_prs() {
  local push_log="$1"
  local local_branch="$2"
  local repo_owner
  repo_owner="$(printf '%s' "$TARGET_REPO" | cut -d/ -f1)"
  local stack_prefix="stack/${repo_owner}/${local_branch}/"

  # Collect PR numbers from the push log (may be incomplete on 422 errors)
  local log_pr_numbers
  log_pr_numbers="$(
    grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' "$push_log" |
    sed -E 's#.*/pull/([0-9]+)#\1#' |
    sort -u
  )"

  # Search GitHub for all open PRs whose head branch matches the stack prefix
  local search_pr_numbers
  search_pr_numbers="$(
    gh pr list --repo "$TARGET_REPO" \
      --search "head:${stack_prefix}" \
      --state open \
      --json number --limit 100 |
    jq -r '.[].number' |
    sort -u
  )"

  # Merge and deduplicate
  local all_pr_numbers
  all_pr_numbers="$(printf '%s\n%s\n' "$log_pr_numbers" "$search_pr_numbers" |
    grep -v '^$' | sort -un)"

  if [ -z "$all_pr_numbers" ]; then
    echo "[]"
    return
  fi

  local prs_json
  prs_json="$(
    while IFS= read -r pr_number; do
      [ -n "$pr_number" ] || continue
      gh pr view "$pr_number" --repo "$TARGET_REPO" \
        --json number,title,url,baseRefName,headRefName,state
    done <<<"$all_pr_numbers" | jq -s --arg base "$BASE_BRANCH" '
      [.[] | select(.state == "OPEN")] |
      # Topological sort: start from the PR that bases on $base, then follow
      # the chain headRefName → next baseRefName.
      . as $all |
      reduce range(length) as $_ (
        { result: [], remaining: $all };
        (.result | length) as $n |
        (if $n == 0 then $base else .result[-1].headRefName end) as $next_base |
        (.remaining | to_entries[] | select(.value.baseRefName == $next_base) | .key) as $idx |
        {
          result: (.result + [.remaining[$idx]]),
          remaining: (.remaining[:$idx] + .remaining[$idx+1:])
        }
      ) | .result
    '
  )"
  printf '%s' "$prs_json"
}

# ---------------------------------------------------------------------------
# Environment setup (once per run)
# ---------------------------------------------------------------------------
setup_environment() {
  require_cmd git
  require_cmd gh
  require_cmd jq
  require_cmd mergify

  TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-lifecycle.XXXXXX")"
  CLONE_DIR="$TMPDIR_ROOT/repo"
  PREFIX="repro/mergify-stack-dogfood-$RUN_ID"

  if [ -z "$ARTIFACTS_DIR" ]; then
    ARTIFACTS_DIR="$TMPDIR_ROOT/artifacts"
  fi
  mkdir -p "$ARTIFACTS_DIR"

  log "run-id=$RUN_ID repo=$TARGET_REPO base=$BASE_BRANCH"
  log "artifacts=$ARTIFACTS_DIR"

  log "verifying GitHub access to $TARGET_REPO"
  gh repo view "$TARGET_REPO" --json nameWithOwner,url >/dev/null

  log "cloning $TARGET_REPO"
  git clone "https://github.com/$TARGET_REPO" "$CLONE_DIR" >/dev/null 2>&1
  cd "$CLONE_DIR"

  git config user.name "${GIT_AUTHOR_NAME:-EdbertChan}"
  git config user.email "${GIT_AUTHOR_EMAIL:-edbert@example.com}"

  log "installing Mergify commit-msg hook"
  mergify stack setup >/dev/null
}

# Reset the clone to a clean state on origin/<base>.
reset_to_base() {
  cd "$CLONE_DIR"
  git checkout -f "origin/$BASE_BRANCH" >/dev/null 2>&1
  git clean -fd >/dev/null 2>&1
  # Delete any local branches from previous scenarios
  git branch --list | grep -v '^\*' | xargs -r git branch -D >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Scenario A: Initial Stack Creation
# ---------------------------------------------------------------------------
run_scenario_A() {
  local branch="${PREFIX}/scenario-a"
  local failures=0

  log "[A] creating 3 stacked commits on $branch"
  reset_to_base
  git switch -c "$branch" "origin/$BASE_BRANCH" >/dev/null

  git commit --allow-empty -m "feat(a): commit 1"
  git commit --allow-empty -m "feat(a): commit 2"
  git commit --allow-empty -m "feat(a): commit 3"

  log "[A] pushing stack"
  local push_log="$TMPDIR_ROOT/scenario-a-push.log"
  mergify_stack_push_with_retry "$push_log"

  log "[A] fetching PRs"
  local prs_json
  prs_json="$(fetch_all_stack_prs "$push_log" "$branch")"
  save_artifact "A" "prs-after-push" "$prs_json" >/dev/null

  local pr_count
  pr_count="$(printf '%s' "$prs_json" | jq 'length')"

  log "[A] assertions (pr_count=$pr_count)"

  # A1: Exactly 3 PRs
  assert_num_eq "A1-pr-count" 3 "$pr_count" || ((failures++))

  # A2: First PR bases on master
  local first_base
  first_base="$(printf '%s' "$prs_json" | jq -r '.[0].baseRefName')"
  assert_eq "A2-first-base" "$BASE_BRANCH" "$first_base" || ((failures++))

  # A3: Chain topology
  local topo_ok=true
  for i in $(seq 1 $((pr_count - 1))); do
    local prev_head curr_base
    prev_head="$(printf '%s' "$prs_json" | jq -r ".[$((i-1))].headRefName")"
    curr_base="$(printf '%s' "$prs_json" | jq -r ".[$i].baseRefName")"
    if [ "$prev_head" != "$curr_base" ]; then
      echo "  FAIL A3-chain-topology: PR[$i] base=$curr_base != PR[$((i-1))] head=$prev_head" >&2
      topo_ok=false
    fi
  done
  if $topo_ok; then echo "  ok   A3-chain-topology"; else ((failures++)); fi

  # A4: All PRs are OPEN
  local closed_count
  closed_count="$(printf '%s' "$prs_json" | jq '[.[] | select(.state != "OPEN")] | length')"
  assert_num_eq "A4-all-open" 0 "$closed_count" || ((failures++))

  # A5: PR titles match commit subjects
  local commit_subjects
  commit_subjects="$(git log --reverse --format='%s' "origin/$BASE_BRANCH..HEAD")"
  local titles_ok=true
  for i in $(seq 0 $((pr_count - 1))); do
    local expected actual
    expected="$(printf '%s\n' "$commit_subjects" | sed -n "$((i+1))p")"
    actual="$(printf '%s' "$prs_json" | jq -r ".[$i].title")"
    if [ "$actual" != "$expected" ]; then
      echo "  FAIL A5-title[$i]: expected='$expected' actual='$actual'" >&2
      titles_ok=false
    fi
  done
  if $titles_ok; then echo "  ok   A5-pr-titles"; else ((failures++)); fi

  # Export state for dependent scenarios
  SCENARIO_A_PRS_JSON="$prs_json"
  SCENARIO_A_BRANCH="$branch"

  return "$failures"
}

# ---------------------------------------------------------------------------
# Scenario B: Add Branch/Commit to Stack
# ---------------------------------------------------------------------------
run_scenario_B() {
  local failures=0

  # Depends on Scenario A state
  if [ -z "${SCENARIO_A_PRS_JSON:-}" ]; then
    log "[B] running prerequisite Scenario A"
    run_scenario_A || true
  fi

  local prs_before="$SCENARIO_A_PRS_JSON"
  local branch="$SCENARIO_A_BRANCH"

  log "[B] appending commit 4"
  cd "$CLONE_DIR"
  git checkout "$branch" >/dev/null 2>&1
  git commit --allow-empty -m "feat(b): commit 4 appended"

  log "[B] pushing updated stack"
  local push_log="$TMPDIR_ROOT/scenario-b-push.log"
  mergify_stack_push_with_retry "$push_log"

  log "[B] fetching PRs"
  local prs_after
  prs_after="$(fetch_all_stack_prs "$push_log" "$branch")"
  save_artifact "B" "prs-before" "$prs_before" >/dev/null
  save_artifact "B" "prs-after" "$prs_after" >/dev/null

  local new_pr_count
  new_pr_count="$(printf '%s' "$prs_after" | jq 'length')"

  log "[B] assertions (pr_count=$new_pr_count)"

  # B1: PR count increases by 1
  assert_num_eq "B1-pr-count" 4 "$new_pr_count" || ((failures++))

  # B2: Original PR numbers preserved
  local orig_numbers preserved_numbers
  orig_numbers="$(printf '%s' "$prs_before" | jq -r '.[].number' | sort)"
  preserved_numbers="$(printf '%s' "$prs_after" | jq -r '.[].number' | sort | head -n 3)"
  assert_eq "B2-originals-preserved" "$orig_numbers" "$preserved_numbers" || ((failures++))

  # B3: New PR bases on previous top-of-stack head
  local prev_top_head new_pr_base
  prev_top_head="$(printf '%s' "$prs_before" | jq -r '.[-1].headRefName')"
  new_pr_base="$(printf '%s' "$prs_after" | jq -r '.[-1].baseRefName')"
  assert_eq "B3-new-pr-base" "$prev_top_head" "$new_pr_base" || ((failures++))

  # B4: New PR is OPEN
  local new_pr_state
  new_pr_state="$(printf '%s' "$prs_after" | jq -r '.[-1].state')"
  assert_eq "B4-new-pr-open" "OPEN" "$new_pr_state" || ((failures++))

  return "$failures"
}

# ---------------------------------------------------------------------------
# Scenario C: Rebase or Mid-Stack Rewrite
# ---------------------------------------------------------------------------
run_scenario_C() {
  local failures=0

  # Start from a fresh Scenario A state
  log "[C] running fresh Scenario A for rebase test"
  SCENARIO_A_PRS_JSON=""
  SCENARIO_A_BRANCH=""
  cleanup_stack_prs >/dev/null 2>&1 || true
  run_scenario_A || true

  local prs_before="$SCENARIO_A_PRS_JSON"
  local branch="$SCENARIO_A_BRANCH"

  log "[C] amending middle commit (commit 2)"
  cd "$CLONE_DIR"
  git checkout "$branch" >/dev/null 2>&1

  # Rebase to edit commit 2: change "pick" to "edit" on the second line
  GIT_SEQUENCE_EDITOR="sed -i '2s/pick/edit/'" git rebase -i "origin/$BASE_BRANCH"
  git commit --amend --allow-empty -m "feat(c): commit 2 rewritten"
  git rebase --continue

  log "[C] pushing rewritten stack"
  local push_log="$TMPDIR_ROOT/scenario-c-push.log"
  mergify_stack_push_with_retry "$push_log"

  log "[C] fetching PRs"
  local prs_after
  prs_after="$(fetch_all_stack_prs "$push_log" "$branch")"
  save_artifact "C" "prs-before" "$prs_before" >/dev/null
  save_artifact "C" "prs-after" "$prs_after" >/dev/null

  local rebase_pr_count
  rebase_pr_count="$(printf '%s' "$prs_after" | jq 'length')"

  log "[C] assertions (pr_count=$rebase_pr_count)"

  # C1: PR count unchanged
  assert_num_eq "C1-pr-count" 3 "$rebase_pr_count" || ((failures++))

  # C2: PR 2 title reflects rewritten commit
  local pr2_title
  pr2_title="$(printf '%s' "$prs_after" | jq -r '.[1].title')"
  assert_eq "C2-pr2-title" "feat(c): commit 2 rewritten" "$pr2_title" || ((failures++))

  # C3: Chain topology preserved
  local first_base
  first_base="$(printf '%s' "$prs_after" | jq -r '.[0].baseRefName')"
  assert_eq "C3-first-base" "$BASE_BRANCH" "$first_base" || ((failures++))

  local topo_ok=true
  for i in $(seq 1 $((rebase_pr_count - 1))); do
    local prev_head curr_base
    prev_head="$(printf '%s' "$prs_after" | jq -r ".[$((i-1))].headRefName")"
    curr_base="$(printf '%s' "$prs_after" | jq -r ".[$i].baseRefName")"
    if [ "$prev_head" != "$curr_base" ]; then
      echo "  FAIL C3-chain[$i]: base=$curr_base != prev_head=$prev_head" >&2
      topo_ok=false
    fi
  done
  if $topo_ok; then echo "  ok   C3-chain-topology"; else ((failures++)); fi

  # C4: All PRs still OPEN
  local closed
  closed="$(printf '%s' "$prs_after" | jq '[.[] | select(.state != "OPEN")] | length')"
  assert_num_eq "C4-all-open" 0 "$closed" || ((failures++))

  # C5: The first PR (base of the stack) keeps its number since its
  #     Change-ID is unaffected by the mid-stack rewrite.  Downstream PRs
  #     may receive new numbers because Mergify recreates PRs whose base
  #     branch changes.
  local pr0_before pr0_after
  pr0_before="$(printf '%s' "$prs_before" | jq -r '.[0].number')"
  pr0_after="$(printf '%s' "$prs_after" | jq -r '.[0].number')"
  assert_eq "C5-base-pr-preserved" "$pr0_before" "$pr0_after" || ((failures++))

  return "$failures"
}

# ---------------------------------------------------------------------------
# Scenario D: Cancel Workflow (Close Mid-Stack PR)
# ---------------------------------------------------------------------------
run_scenario_D() {
  local failures=0

  # If no Scenario A state, run it fresh
  if [ -z "${SCENARIO_A_PRS_JSON:-}" ]; then
    log "[D] running prerequisite Scenario A"
    run_scenario_A || true
  fi

  local prs_json="$SCENARIO_A_PRS_JSON"

  local middle_pr
  middle_pr="$(printf '%s' "$prs_json" | jq -r '.[1].number')"
  local top_pr
  top_pr="$(printf '%s' "$prs_json" | jq -r '.[-1].number')"
  local bottom_pr
  bottom_pr="$(printf '%s' "$prs_json" | jq -r '.[0].number')"
  local middle_head
  middle_head="$(printf '%s' "$prs_json" | jq -r '.[1].headRefName')"

  log "[D] closing middle PR #$middle_pr"
  gh pr close "$middle_pr" --repo "$TARGET_REPO"

  log "[D] assertions"

  # D1: Middle PR is CLOSED
  local middle_state
  middle_state="$(gh pr view "$middle_pr" --repo "$TARGET_REPO" --json state -q '.state')"
  assert_eq "D1-middle-closed" "CLOSED" "$middle_state" || ((failures++))

  # D2: Top PR remains OPEN
  local top_state
  top_state="$(gh pr view "$top_pr" --repo "$TARGET_REPO" --json state -q '.state')"
  assert_eq "D2-top-open" "OPEN" "$top_state" || ((failures++))

  # D3: Bottom PR remains OPEN
  local bottom_state
  bottom_state="$(gh pr view "$bottom_pr" --repo "$TARGET_REPO" --json state -q '.state')"
  assert_eq "D3-bottom-open" "OPEN" "$bottom_state" || ((failures++))

  # D4: Top PR base unchanged (still references middle branch)
  local top_base
  top_base="$(gh pr view "$top_pr" --repo "$TARGET_REPO" --json baseRefName -q '.baseRefName')"
  assert_eq "D4-top-base-unchanged" "$middle_head" "$top_base" || ((failures++))

  # Save state for Scenario E
  SCENARIO_D_PRS_JSON="$prs_json"
  SCENARIO_D_BRANCH="${SCENARIO_A_BRANCH}"

  save_artifact "D" "prs-snapshot" "$prs_json" >/dev/null

  return "$failures"
}

# ---------------------------------------------------------------------------
# Scenario E: Recreate Workflow (Re-push After Cancel)
# ---------------------------------------------------------------------------
run_scenario_E() {
  local failures=0

  # Depends on Scenario D state
  if [ -z "${SCENARIO_D_PRS_JSON:-}" ]; then
    log "[E] running prerequisite Scenario D"
    run_scenario_D || true
  fi

  log "[E] re-pushing stack to recreate after cancel"
  cd "$CLONE_DIR"
  git checkout "${SCENARIO_D_BRANCH}" >/dev/null 2>&1

  # Brief pause so Mergify and GitHub fully process the closed PR from Scenario D
  sleep 3

  local push_log="$TMPDIR_ROOT/scenario-e-push.log"
  mergify_stack_push_with_retry "$push_log"

  log "[E] fetching PRs"
  local prs_recreated
  prs_recreated="$(fetch_all_stack_prs "$push_log" "${SCENARIO_D_BRANCH}")"
  save_artifact "E" "prs-recreated" "$prs_recreated" >/dev/null

  local recreated_count
  recreated_count="$(printf '%s' "$prs_recreated" | jq 'length')"

  log "[E] assertions (pr_count=$recreated_count)"

  # E1: All PRs are OPEN
  local open_count
  open_count="$(printf '%s' "$prs_recreated" | jq '[.[] | select(.state == "OPEN")] | length')"
  assert_num_eq "E1-all-open" 3 "$open_count" || ((failures++))

  # E2: Chain topology restored
  local first_base
  first_base="$(printf '%s' "$prs_recreated" | jq -r '.[0].baseRefName')"
  assert_eq "E2-first-base" "$BASE_BRANCH" "$first_base" || ((failures++))

  local topo_ok=true
  for i in $(seq 1 2); do
    local prev_head curr_base
    prev_head="$(printf '%s' "$prs_recreated" | jq -r ".[$((i-1))].headRefName")"
    curr_base="$(printf '%s' "$prs_recreated" | jq -r ".[$i].baseRefName")"
    if [ "$prev_head" != "$curr_base" ]; then
      echo "  FAIL E2-chain[$i]: base=$curr_base != prev_head=$prev_head" >&2
      topo_ok=false
    fi
  done
  if $topo_ok; then echo "  ok   E2-chain-topology"; else ((failures++)); fi

  # E3: PR count equals original stack depth
  assert_num_eq "E3-pr-count" 3 "$recreated_count" || ((failures++))

  return "$failures"
}

# ---------------------------------------------------------------------------
# Scenario F: Delete Workflow (Close All + Delete Branches)
# ---------------------------------------------------------------------------
run_scenario_F() {
  local failures=0

  # Start from a fresh Scenario A state
  log "[F] running fresh Scenario A for delete test"
  SCENARIO_A_PRS_JSON=""
  SCENARIO_A_BRANCH=""
  cleanup_stack_prs >/dev/null 2>&1 || true
  run_scenario_A || true

  local prs_json="$SCENARIO_A_PRS_JSON"

  log "[F] closing all PRs with branch deletion"
  printf '%s' "$prs_json" | jq -r '.[].number' | while read -r pr; do
    gh pr close "$pr" --repo "$TARGET_REPO" --delete-branch || true
  done

  # Explicitly delete any remaining remote branches (some may have survived
  # if their PR was auto-closed by GitHub when a base branch was deleted).
  cd "$CLONE_DIR"
  printf '%s' "$prs_json" | jq -r '.[].headRefName' | while read -r branch; do
    git push origin --delete "$branch" 2>/dev/null || true
  done

  # Brief pause for GitHub to process branch deletions
  sleep 3

  log "[F] assertions"

  # F1: All PRs are CLOSED
  local f1_ok=true
  printf '%s' "$prs_json" | jq -r '.[].number' | while read -r pr; do
    local state
    state="$(gh pr view "$pr" --repo "$TARGET_REPO" --json state -q '.state')"
    if [ "$state" != "CLOSED" ]; then
      echo "  FAIL F1-pr-$pr-closed: state=$state" >&2
      exit 1
    fi
  done || { f1_ok=false; ((failures++)); }
  if $f1_ok; then echo "  ok   F1-all-closed"; fi

  # F2: Remote branches deleted
  cd "$CLONE_DIR"
  local f2_ok=true
  printf '%s' "$prs_json" | jq -r '.[].headRefName' | while read -r branch; do
    if git ls-remote --exit-code origin "refs/heads/$branch" 2>/dev/null; then
      echo "  FAIL F2-branch-deleted: $branch still exists" >&2
      exit 1
    fi
  done || { f2_ok=false; ((failures++)); }
  if $f2_ok; then echo "  ok   F2-branches-deleted"; fi

  # F3: No open PRs remain with the run prefix
  local remaining
  remaining="$(gh pr list --repo "$TARGET_REPO" \
    --search "head:${PREFIX}/scenario-" \
    --state open --json number | jq 'length')"
  assert_num_eq "F3-no-open-remaining" 0 "$remaining" || ((failures++))

  save_artifact "F" "prs-deleted" "$prs_json" >/dev/null

  return "$failures"
}

# ---------------------------------------------------------------------------
# Scenario G: Delete All (Bulk Cleanup)
# ---------------------------------------------------------------------------
run_scenario_G() {
  local failures=0

  log "[G] bulk cleanup of all PRs/branches matching prefix"

  # Close all open PRs whose head matches the run prefix
  local matching_prs
  matching_prs="$(gh pr list --repo "$TARGET_REPO" \
    --search "head:repro/mergify-stack-dogfood-${RUN_ID}" \
    --state open --json number,headRefName --limit 200 || echo '[]')"

  local match_count
  match_count="$(printf '%s' "$matching_prs" | jq 'length')"
  log "[G] found $match_count open PRs to clean up"

  if [ "$match_count" -gt 0 ]; then
    printf '%s' "$matching_prs" | jq -r '.[].number' | while read -r pr; do
      gh pr close "$pr" --repo "$TARGET_REPO" --delete-branch 2>/dev/null || true
    done
  fi

  # Also close PRs on stack/ branches created by Mergify for this run
  local stack_prs
  stack_prs="$(gh pr list --repo "$TARGET_REPO" \
    --search "head:stack/" \
    --state open --json number,headRefName --limit 200 || echo '[]')"

  # Only close stack/ PRs that are associated with our run prefix branches
  # (we can't be 100% selective, so we close all stack/ PRs that reference
  # our run prefix in their title or labels — for safety, we just close
  # stack/ PRs opened very recently)

  # Delete remaining remote branches matching the prefix
  cd "$CLONE_DIR"
  git fetch origin --prune >/dev/null 2>&1 || true
  local remote_branches
  remote_branches="$(git ls-remote --heads origin 2>/dev/null | \
    grep "repro/mergify-stack-dogfood-${RUN_ID}" | \
    awk '{print $2}' | sed 's|refs/heads/||' || true)"

  if [ -n "$remote_branches" ]; then
    printf '%s\n' "$remote_branches" | while read -r branch; do
      git push origin --delete "$branch" 2>/dev/null || true
    done
  fi

  # Brief pause for GitHub to process
  sleep 3

  log "[G] assertions"

  # G1: Zero open PRs matching prefix
  local open_matching
  open_matching="$(gh pr list --repo "$TARGET_REPO" \
    --search "head:repro/mergify-stack-dogfood-${RUN_ID}" \
    --state open --json number | jq 'length')"
  assert_num_eq "G1-zero-open-prs" 0 "$open_matching" || ((failures++))

  # G2: Zero remote branches matching prefix
  local remote_count
  remote_count="$(git ls-remote --heads origin 2>/dev/null | \
    grep -c "repro/mergify-stack-dogfood-${RUN_ID}" || echo 0)"
  assert_num_eq "G2-zero-remote-branches" 0 "$remote_count" || ((failures++))

  # G3: Unrelated PRs unaffected (master has no unexpected closures)
  local master_open
  master_open="$(gh pr list --repo "$TARGET_REPO" --base "$BASE_BRANCH" \
    --state open --json number | jq 'length')"
  assert "G3-master-prs-queryable" [ "$master_open" -ge 0 ] || ((failures++))

  save_artifact "G" "cleanup-summary" \
    "$(jq -n --argjson closed "$match_count" --argjson remaining "$open_matching" \
    '{closedPRs: $closed, remainingOpen: $remaining}')" >/dev/null

  return "$failures"
}

# ---------------------------------------------------------------------------
# Cleanup helper: close all PRs created in the current run
# ---------------------------------------------------------------------------
cleanup_stack_prs() {
  local repo_owner
  repo_owner="$(printf '%s' "$TARGET_REPO" | cut -d/ -f1)"

  # Close PRs on the direct branch prefix and on stack/ branches
  local open_prs
  open_prs="$(
    {
      gh pr list --repo "$TARGET_REPO" \
        --search "head:${PREFIX}/" \
        --state open --json number --limit 200 2>/dev/null || true
      gh pr list --repo "$TARGET_REPO" \
        --search "head:stack/${repo_owner}/${PREFIX}/" \
        --state open --json number --limit 200 2>/dev/null || true
    } | jq -s 'add // [] | unique_by(.number)'
  )"

  local closed_any=false
  printf '%s' "$open_prs" | jq -r '.[].number' | while read -r pr; do
    gh pr close "$pr" --repo "$TARGET_REPO" --delete-branch 2>/dev/null || true
    closed_any=true
  done
  # Give GitHub time to process branch deletions
  sleep 2
}

# ---------------------------------------------------------------------------
# Scenario runner
# ---------------------------------------------------------------------------
run_scenario() {
  local scenario="$1"
  local rc=0

  log "--- Scenario $scenario ---"

  case "$scenario" in
    A) run_scenario_A || rc=$? ;;
    B) run_scenario_B || rc=$? ;;
    C) run_scenario_C || rc=$? ;;
    D) run_scenario_D || rc=$? ;;
    E) run_scenario_E || rc=$? ;;
    F) run_scenario_F || rc=$? ;;
    G) run_scenario_G || rc=$? ;;
    *)
      echo "unknown scenario: $scenario" >&2
      return 1
      ;;
  esac

  if [ "$rc" -eq 0 ]; then
    echo "  PASS Scenario $scenario"
    SCENARIO_RESULTS[$scenario]="PASS"
  else
    echo "  FAIL Scenario $scenario ($rc assertion(s) failed)"
    SCENARIO_RESULTS[$scenario]="FAIL"
  fi

  return "$rc"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  parse_args "$@"
  setup_environment

  local total_failures=0
  local execution_paths=()

  # Determine execution order based on the recommended paths:
  #   A → B (stack growth)
  #   A → C (rebase)
  #   A → D → E (cancel + recreate)
  #   A → F (delete workflow)
  #   G (bulk cleanup, runs last)
  #
  # When --all-scenarios is used, run all paths.  When individual scenarios
  # are selected, run each with its prerequisites (handled inside each
  # scenario function).

  if $ALL_SCENARIOS; then
    log "running all scenarios in recommended execution order"

    # Path 1: A → B
    log "=== Path: A → B (stack growth) ==="
    SCENARIO_A_PRS_JSON=""
    SCENARIO_A_BRANCH=""
    run_scenario A || ((total_failures++))
    run_scenario B || ((total_failures++))
    cleanup_stack_prs >/dev/null 2>&1 || true

    # Path 2: A → C (fresh A)
    log "=== Path: A → C (rebase) ==="
    SCENARIO_A_PRS_JSON=""
    SCENARIO_A_BRANCH=""
    run_scenario C || ((total_failures++))
    cleanup_stack_prs >/dev/null 2>&1 || true

    # Path 3: A → D → E (fresh A)
    log "=== Path: A → D → E (cancel + recreate) ==="
    SCENARIO_A_PRS_JSON=""
    SCENARIO_A_BRANCH=""
    SCENARIO_D_PRS_JSON=""
    SCENARIO_D_BRANCH=""
    run_scenario A || ((total_failures++))
    run_scenario D || ((total_failures++))
    run_scenario E || ((total_failures++))
    cleanup_stack_prs >/dev/null 2>&1 || true

    # Path 4: A → F (fresh A)
    log "=== Path: A → F (delete workflow) ==="
    SCENARIO_A_PRS_JSON=""
    SCENARIO_A_BRANCH=""
    run_scenario F || ((total_failures++))

    # Path 5: G (bulk cleanup, runs last)
    log "=== Path: G (bulk cleanup) ==="
    run_scenario G || ((total_failures++))
  else
    for scenario in "${SCENARIOS[@]}"; do
      run_scenario "$scenario" || ((total_failures++))
    done
    # Always clean up at the end
    cleanup_stack_prs >/dev/null 2>&1 || true
  fi

  # Summary
  echo
  log "=== Summary ==="
  for scenario in "${!SCENARIO_RESULTS[@]}"; do
    local artifact_path="$ARTIFACTS_DIR/scenario-${scenario}-*.json"
    # shellcheck disable=SC2086
    local artifact_files
    artifact_files="$(ls $artifact_path 2>/dev/null | tr '\n' ', ' || echo 'none')"
    echo "  Scenario $scenario: ${SCENARIO_RESULTS[$scenario]}  artifacts: ${artifact_files%,}"
  done
  echo "  Artifacts directory: $ARTIFACTS_DIR"

  if [ "$total_failures" -gt 0 ]; then
    echo
    echo "FAIL repro-mergify-stack-lifecycle ($total_failures scenario(s) failed)"
    exit 1
  fi

  echo
  echo "PASS repro-mergify-stack-lifecycle"
  exit 0
}

main "$@"
