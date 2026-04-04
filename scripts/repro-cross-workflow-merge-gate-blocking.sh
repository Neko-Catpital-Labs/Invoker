#!/usr/bin/env bash
# Repro: cross-workflow merge-gate dependency blocks downstream until upstream is approved.
#
# Creates two dummy workflows against a temporary bare repo:
#   WF1: w1-a -> merge gate (manual)
#   WF2: w2-a (externalDependencies on WF1 merge gate)
#
# Default expectation ("approved"): WF2/w2-a stays pending while WF1 merge gate is review_ready.
# Future expectation ("review_ready"): WF2/w2-a can run when WF1 merge gate is review_ready.
#
# Usage:
#   bash scripts/repro-cross-workflow-merge-gate-blocking.sh [approved|review_ready]
#
set -euo pipefail

EXPECT_MODE="${1:-approved}"
if [[ "$EXPECT_MODE" != "approved" && "$EXPECT_MODE" != "review_ready" ]]; then
  echo "Usage: $0 [approved|review_ready]"
  exit 1
fi
GATE_POLICY="$EXPECT_MODE"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FAIL: required command not found: $1"
    exit 1
  fi
}

require git
require timeout
require jq

if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "==> Building @invoker/app (dist missing)"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build)
fi

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-xwf-gate-db.XXXXXX")"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-xwf-gate.XXXXXX")"
BARE_DIR="$TMP_ROOT/bare"
WORK_DIR="$TMP_ROOT/work"
PLAN1="$TMP_ROOT/workflow1.yaml"
PLAN2="$TMP_ROOT/workflow2.yaml"

cleanup() {
  local ec=$?
  rm -rf "$TMP_ROOT" "$INVOKER_DB_DIR" 2>/dev/null || true
  return "$ec"
}
trap cleanup EXIT

strip_json_stream() {
  awk '
    BEGIN { started=0 }
    {
      if (!started) {
        if ($0 ~ /^[[:space:]]*[\[{]/ && $0 !~ /^\[init\]/ && $0 !~ /^\[deprecated\]/) {
          started=1
          print
        }
      } else {
        print
      }
    }
  '
}

run_headless() {
  (cd "$REPO_ROOT" && timeout 600 ./run.sh --headless "$@")
}

query_workflows_json() {
  run_headless query workflows --output json | strip_json_stream
}

query_tasks_json() {
  run_headless query tasks --output json | strip_json_stream
}

task_status() {
  local task_id="$1"
  query_tasks_json | jq -r --arg id "$task_id" '.[] | select(.id == $id) | .status // empty' | head -1
}

wait_task_status_in() {
  local task_id="$1"; shift
  local timeout_s="$1"; shift
  local allowed=("$@")
  local start now st ok
  start="$(date +%s)"
  while true; do
    st="$(task_status "$task_id")"
    ok=0
    for s in "${allowed[@]}"; do
      if [[ "$st" == "$s" ]]; then
        echo "$st"
        return 0
      fi
    done
    now="$(date +%s)"
    if (( now - start >= timeout_s )); then
      echo "$st"
      return 1
    fi
    sleep 0.2
  done
}

echo "==> Creating temporary bare repo"
mkdir -p "$BARE_DIR" "$WORK_DIR"
git init --bare "$BARE_DIR/repo.git" >/dev/null
git clone "$BARE_DIR/repo.git" "$WORK_DIR/repo" >/dev/null 2>&1
printf '{"name":"invoker-xwf-gate-repro","private":true}\n' > "$WORK_DIR/repo/package.json"
git -C "$WORK_DIR/repo" add package.json
git -C "$WORK_DIR/repo" -c user.name='repro' -c user.email='repro@local' commit -m 'initial' >/dev/null
git -C "$WORK_DIR/repo" push origin master >/dev/null

REPO_URL="file://$BARE_DIR/repo.git"
WF1_NAME="repro-xwf-gate-1-$(date +%s)"
WF2_NAME="repro-xwf-gate-2-$(date +%s)"

cat > "$PLAN1" <<YAML
name: $WF1_NAME
repoUrl: $REPO_URL
onFinish: merge
mergeMode: manual
baseBranch: master
featureBranch: feature/repro-xwf-gate-1
tasks:
  - id: w1-a
    description: "workflow1: seed marker"
    command: "printf 'W1\\n' > shared.txt"
YAML

echo "==> Submitting workflow 1"
run_headless run "$PLAN1" >/dev/null

WF1_ID="$(query_workflows_json | jq -r --arg n "$WF1_NAME" '[.[] | select(.name == $n)] | sort_by(.createdAt) | last | .id // empty')"
if [[ -z "$WF1_ID" ]]; then
  echo "FAIL: could not resolve workflow 1 ID"
  exit 1
fi
WF1_MERGE="__merge__${WF1_ID}"

WF1_MERGE_STATUS="$(wait_task_status_in "$WF1_MERGE" 20 review_ready awaiting_approval completed failed || true)"
echo "==> WF1 merge gate: $WF1_MERGE status=$WF1_MERGE_STATUS"
if [[ "$WF1_MERGE_STATUS" != "review_ready" ]]; then
  echo "FAIL: expected workflow 1 merge gate to reach review_ready, got '$WF1_MERGE_STATUS'"
  exit 1
fi

cat > "$PLAN2" <<YAML
name: $WF2_NAME
repoUrl: $REPO_URL
onFinish: none
mergeMode: manual
baseBranch: feature/repro-xwf-gate-1
featureBranch: feature/repro-xwf-gate-2
tasks:
  - id: w2-a
    description: "workflow2: depends on workflow1 merge gate"
    command: "printf 'W2\\n' >> shared.txt"
    externalDependencies:
      - workflowId: "$WF1_ID"
        taskId: "__merge__"
        requiredStatus: completed
        gatePolicy: $GATE_POLICY
    dependencies: []
YAML

echo "==> Submitting workflow 2 (depends on $WF1_MERGE)"
run_headless run "$PLAN2" --no-track >/dev/null

WF2_ID="$(query_workflows_json | jq -r --arg n "$WF2_NAME" '[.[] | select(.name == $n)] | sort_by(.createdAt) | last | .id // empty')"
if [[ -z "$WF2_ID" ]]; then
  echo "FAIL: could not resolve workflow 2 ID"
  exit 1
fi
WF2_ROOT="${WF2_ID}/w2-a"
WF2_STATUS="$(task_status "$WF2_ROOT")"

echo "==> WF2 root task: $WF2_ROOT status=$WF2_STATUS (while WF1 merge is review_ready)"

if [[ "$EXPECT_MODE" == "approved" ]]; then
  if [[ "$WF2_STATUS" != "pending" ]]; then
    echo "FAIL: expected '$WF2_ROOT' to stay pending under approved gating; got '$WF2_STATUS'"
    exit 1
  fi
  echo "PASS: approved gating repro confirmed (downstream remains pending)."
  exit 0
fi

if [[ "$WF2_STATUS" == "running" || "$WF2_STATUS" == "completed" || "$WF2_STATUS" == "fixing_with_ai" ]]; then
  echo "PASS: review_ready behavior observed (downstream progressed before upstream approval)."
  exit 0
fi

echo "FAIL: expected review_ready behavior (downstream should progress), got '$WF2_STATUS'"
exit 1
