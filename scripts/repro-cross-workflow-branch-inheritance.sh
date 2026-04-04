#!/usr/bin/env bash
# Repro: cross-workflow dependency gating does not imply branch ancestry/import.
#
# This script creates two workflows against a temporary bare repo:
#   Workflow 1: w1-a -> w1-b (writes W1 markers into shared.txt)
#   Workflow 2: w2-a -> w2-b, where w2-a has externalDependencies on wf1/w1-b
#
# It verifies:
#   1) execution order across workflows and within each workflow,
#   2) branch ancestry across task commits,
#   3) file-content inheritance in downstream branches.
#
# Expected (if cross-workflow branch import works):
#   w1-a <= w1-b <= w2-a <= w2-b and
#   w1-b commit is ancestor of w2-a commit and
#   shared.txt in w2 branches includes W1 markers.
#
# Current behavior in this repo should FAIL the cross-workflow ancestry/content
# checks, which is the bug repro.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FAIL: required command not found: $1"
    exit 1
  fi
}

require sqlite3
require git
require timeout

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-xwf-db.XXXXXX")"

DB_PATH="$INVOKER_DB_DIR/invoker.db"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-xwf.XXXXXX")"
BARE_DIR="$TMP_ROOT/bare"
WORK_DIR="$TMP_ROOT/work"
CHECK_DIR="$TMP_ROOT/check"
PLAN1="$TMP_ROOT/workflow1.yaml"
PLAN2="$TMP_ROOT/workflow2.yaml"

cleanup() {
  local ec=$?
  rm -rf "$TMP_ROOT" "$INVOKER_DB_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

run_headless() {
  (cd "$REPO_ROOT" && timeout 600 ./run.sh --headless "$@")
}

sql() {
  sqlite3 "$DB_PATH" "$1"
}

task_status() {
  local wf="$1"; local task="$2"
  sql "SELECT status FROM tasks WHERE id = '$wf/$task';"
}

task_branch() {
  local wf="$1"; local task="$2"
  sql "SELECT branch FROM tasks WHERE id = '$wf/$task';"
}

task_commit() {
  local wf="$1"; local task="$2"
  sql "SELECT commit_hash FROM tasks WHERE id = '$wf/$task';"
}

task_started_at() {
  local wf="$1"; local task="$2"
  sql "SELECT started_at FROM tasks WHERE id = '$wf/$task';"
}

task_completed_at() {
  local wf="$1"; local task="$2"
  sql "SELECT completed_at FROM tasks WHERE id = '$wf/$task';"
}

assert_completed() {
  local wf="$1"; local task="$2"
  local st
  st="$(task_status "$wf" "$task")"
  if [[ "$st" != "completed" ]]; then
    echo "FAIL: expected $wf/$task status=completed, got '$st'"
    exit 1
  fi
}

assert_ancestor() {
  local older="$1"; local newer="$2"; local label="$3"
  if git -C "$CHECK_DIR" merge-base --is-ancestor "$older" "$newer"; then
    echo "  PASS ancestry: $label"
  else
    echo "  FAIL ancestry: $label"
    return 1
  fi
}

assert_file_lines_exact() {
  local branch="$1"; shift
  local expected=("$@")
  git -C "$CHECK_DIR" checkout -q "$branch"
  if [[ ! -f "$CHECK_DIR/shared.txt" ]]; then
    echo "  FAIL content: branch '$branch' missing shared.txt"
    return 1
  fi
  mapfile -t actual < "$CHECK_DIR/shared.txt"
  if [[ "${actual[*]}" == "${expected[*]}" ]]; then
    echo "  PASS content: $branch => ${expected[*]}"
  else
    echo "  FAIL content: $branch"
    echo "    expected: ${expected[*]}"
    echo "    actual:   ${actual[*]}"
    return 1
  fi
}

echo "==> Creating temporary bare repo"
mkdir -p "$BARE_DIR" "$WORK_DIR"
git init --bare "$BARE_DIR/repo.git" >/dev/null
git clone "$BARE_DIR/repo.git" "$WORK_DIR/repo" >/dev/null 2>&1
printf '{"name":"invoker-xwf-repro","private":true}\n' > "$WORK_DIR/repo/package.json"
git -C "$WORK_DIR/repo" add package.json
git -C "$WORK_DIR/repo" -c user.name='repro' -c user.email='repro@local' commit -m 'initial' >/dev/null
git -C "$WORK_DIR/repo" push origin master >/dev/null

REPO_URL="file://$BARE_DIR/repo.git"

WF1_NAME="repro-xwf-1-$(date +%s)"
WF2_NAME="repro-xwf-2-$(date +%s)"

cat > "$PLAN1" <<YAML
name: $WF1_NAME
repoUrl: $REPO_URL
onFinish: none
mergeMode: manual
baseBranch: master
tasks:
  - id: w1-a
    description: "workflow1: create shared.txt"
    command: "printf 'W1-A\\n' > shared.txt"
  - id: w1-b
    description: "workflow1: append marker"
    command: "printf 'W1-B\\n' >> shared.txt"
    dependencies: [w1-a]
YAML

echo "==> Submitting workflow 1"
run_headless run "$PLAN1" >/dev/null

WF1_ID="$(sql "SELECT id FROM workflows WHERE name = '$WF1_NAME' ORDER BY created_at DESC LIMIT 1;")"
if [[ -z "$WF1_ID" ]]; then
  echo "FAIL: could not resolve workflow 1 ID"
  exit 1
fi

echo "==> Workflow 1 ID: $WF1_ID"
assert_completed "$WF1_ID" "w1-a"
assert_completed "$WF1_ID" "w1-b"

cat > "$PLAN2" <<YAML
name: $WF2_NAME
repoUrl: $REPO_URL
onFinish: none
mergeMode: manual
baseBranch: master
tasks:
  - id: w2-a
    description: "workflow2: depends on workflow1 w1-b"
    command: "printf 'W2-A\\n' >> shared.txt"
    externalDependencies:
      - workflowId: $WF1_ID
        taskId: w1-b
  - id: w2-b
    description: "workflow2: append marker"
    command: "printf 'W2-B\\n' >> shared.txt"
    dependencies: [w2-a]
YAML

echo "==> Submitting workflow 2 (externally gated on $WF1_ID/w1-b)"
run_headless run "$PLAN2" >/dev/null

WF2_ID="$(sql "SELECT id FROM workflows WHERE name = '$WF2_NAME' ORDER BY created_at DESC LIMIT 1;")"
if [[ -z "$WF2_ID" ]]; then
  echo "FAIL: could not resolve workflow 2 ID"
  exit 1
fi

echo "==> Workflow 2 ID: $WF2_ID"
assert_completed "$WF2_ID" "w2-a"
assert_completed "$WF2_ID" "w2-b"

W1A_START="$(task_started_at "$WF1_ID" "w1-a")"
W1B_START="$(task_started_at "$WF1_ID" "w1-b")"
W1B_DONE="$(task_completed_at "$WF1_ID" "w1-b")"
W2A_START="$(task_started_at "$WF2_ID" "w2-a")"
W2B_START="$(task_started_at "$WF2_ID" "w2-b")"

echo "==> Execution timestamps"
echo "  $WF1_ID/w1-a started_at=$W1A_START"
echo "  $WF1_ID/w1-b started_at=$W1B_START completed_at=$W1B_DONE"
echo "  $WF2_ID/w2-a started_at=$W2A_START"
echo "  $WF2_ID/w2-b started_at=$W2B_START"

ORDER_OK="$(sql "
SELECT CASE
  WHEN datetime('$W1A_START') <= datetime('$W1B_START')
   AND datetime('$W1B_DONE') <= datetime('$W2A_START')
   AND datetime('$W2A_START') <= datetime('$W2B_START')
  THEN 1 ELSE 0 END;
")"

if [[ "$ORDER_OK" != "1" ]]; then
  echo "FAIL: execution order check failed"
  exit 1
fi

echo "  PASS order: w1-a <= w1-b <= w2-a <= w2-b"

W1A_BRANCH="$(task_branch "$WF1_ID" "w1-a")"
W1B_BRANCH="$(task_branch "$WF1_ID" "w1-b")"
W2A_BRANCH="$(task_branch "$WF2_ID" "w2-a")"
W2B_BRANCH="$(task_branch "$WF2_ID" "w2-b")"

W1A_COMMIT="$(task_commit "$WF1_ID" "w1-a")"
W1B_COMMIT="$(task_commit "$WF1_ID" "w1-b")"
W2A_COMMIT="$(task_commit "$WF2_ID" "w2-a")"
W2B_COMMIT="$(task_commit "$WF2_ID" "w2-b")"

echo "==> Branches"
echo "  w1-a: $W1A_BRANCH @ $W1A_COMMIT"
echo "  w1-b: $W1B_BRANCH @ $W1B_COMMIT"
echo "  w2-a: $W2A_BRANCH @ $W2A_COMMIT"
echo "  w2-b: $W2B_BRANCH @ $W2B_COMMIT"

mkdir -p "$CHECK_DIR"
git clone "$BARE_DIR/repo.git" "$CHECK_DIR" >/dev/null 2>&1

FAILURES=0

echo "==> Verifying ancestry"
assert_ancestor "$W1A_COMMIT" "$W1B_COMMIT" "w1-a -> w1-b" || FAILURES=$((FAILURES+1))
assert_ancestor "$W1B_COMMIT" "$W2A_COMMIT" "w1-b -> w2-a (cross-workflow import)" || FAILURES=$((FAILURES+1))
assert_ancestor "$W2A_COMMIT" "$W2B_COMMIT" "w2-a -> w2-b" || FAILURES=$((FAILURES+1))

echo "==> Verifying shared.txt content"
assert_file_lines_exact "$W1B_BRANCH" "W1-A" "W1-B" || FAILURES=$((FAILURES+1))
assert_file_lines_exact "$W2A_BRANCH" "W1-A" "W1-B" "W2-A" || FAILURES=$((FAILURES+1))
assert_file_lines_exact "$W2B_BRANCH" "W1-A" "W1-B" "W2-A" "W2-B" || FAILURES=$((FAILURES+1))

if [[ "$FAILURES" -gt 0 ]]; then
  echo ""
  echo "FAIL: cross-workflow branch inheritance repro caught $FAILURES failure(s)."
  echo "This indicates externalDependencies gated execution but did not import upstream branch ancestry/content."
  exit 1
fi

echo ""
echo "PASS: cross-workflow branch inheritance behaves as expected."
