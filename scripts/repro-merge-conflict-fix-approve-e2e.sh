#!/usr/bin/env bash
set -euo pipefail

# End-to-end repro/verification:
#   merge_conflict -> fix with codex -> approve fix -> rerun original task ->
#   non-merge failure -> fix with codex -> approve fix -> completed
#
# Usage:
#   bash scripts/repro-merge-conflict-fix-approve-e2e.sh
#   USE_REAL_CODEX=1 bash scripts/repro-merge-conflict-fix-approve-e2e.sh

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-db.XXXXXX")"
trap 'rm -rf "$INVOKER_DB_DIR" "$PLAN_FILE" "$STUB_DIR"' EXIT

STUB_DIR=""
if [[ "${USE_REAL_CODEX:-0}" != "1" ]]; then
  STUB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-stub.XXXXXX")"
  cat >"$STUB_DIR/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

# Minimal codex stub for deterministic e2e:
# 1) Emits valid JSONL session output.
# 2) Auto-resolves merge conflicts if present.
# 3) Ensures .invoker-repro/ready.txt exists with READY for the second rerun.

SESSION_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id) SESSION_ID="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [[ -z "$SESSION_ID" ]]; then SESSION_ID="stub-$(date +%s)-$$"; fi

TS="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
printf '%s\n' "{\"type\":\"thread.started\",\"thread_id\":\"$SESSION_ID\"}"
printf '%s\n' "{\"timestamp\":\"$TS\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"stub codex applied fix\"}]}}"

UNMERGED=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  UNMERGED="$(git diff --name-only --diff-filter=U 2>/dev/null || true)"
  if [[ -n "$UNMERGED" ]]; then
    # First fix stage: resolve merge conflict only.
    git checkout --theirs . 2>/dev/null || true
    git add -A 2>/dev/null || true
    git -c user.name='stub-codex' -c user.email='stub@local' commit --no-edit 2>/dev/null || true
    exit 0
  fi
fi

# Second fix stage (non-merge failure): add ready marker.
mkdir -p .invoker-repro
printf 'READY\n' > .invoker-repro/ready.txt
if git rev-parse --git-dir >/dev/null 2>&1; then
  git add .invoker-repro/ready.txt 2>/dev/null || true
  git -c user.name='stub-codex' -c user.email='stub@local' commit -m 'stub: add ready marker' 2>/dev/null || true
fi
STUB
  chmod +x "$STUB_DIR/codex"
  export PATH="$STUB_DIR:$PATH"
fi

RUN_ID="$(date +%s)"
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-merge-fix-repro-${RUN_ID}.XXXXXX.yaml")"

cat >"$PLAN_FILE" <<YAML
name: "Repro merge_conflict fix-approve rerun chain ($RUN_ID)"
onFinish: none
mergeMode: manual
baseBranch: master
repoUrl: /home/edbert-chan/Desktop/Github/invoker-v2
tasks:
  - id: make-side-a
    description: "Write side A to force downstream merge conflict"
    command: |
      bash -lc 'mkdir -p .invoker-repro && printf "SIDE_A\n" > .invoker-repro/conflict.txt'
    dependencies: []

  - id: make-side-b
    description: "Write side B to force downstream merge conflict"
    command: |
      bash -lc 'mkdir -p .invoker-repro && printf "SIDE_B\n" > .invoker-repro/conflict.txt'
    dependencies: []

  - id: verify-after-merge
    description: "Fail unless ready marker exists after merge"
    command: |
      bash -lc 'test -f .invoker-repro/ready.txt && grep -q "^READY$" .invoker-repro/ready.txt'
    dependencies: [make-side-a, make-side-b]
YAML

runh() { ./run.sh --headless "$@"; }

task_json() {
  local task_id="$1"
  runh query task "$task_id" --output json | tail -n 1
}

task_status() {
  local task_id="$1"
  task_json "$task_id" | jq -r '.status'
}

task_error() {
  local task_id="$1"
  task_json "$task_id" | jq -r '.execution.error // ""'
}

wait_until_status() {
  local task_id="$1"
  local wanted="$2"
  local max_tries="${3:-90}"
  local s=""
  for ((i=1; i<=max_tries; i++)); do
    s="$(task_status "$task_id")"
    if [[ "$s" == "$wanted" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "TIMEOUT: task $task_id did not reach status=$wanted (last=$s)" >&2
  return 1
}

wait_until_settled_non_transient() {
  local task_id="$1"
  local max_tries="${2:-150}"
  local s=""
  for ((i=1; i<=max_tries; i++)); do
    s="$(task_status "$task_id")"
    case "$s" in
      pending|running|fixing_with_ai|awaiting_approval) ;;
      *) echo "$s"; return 0 ;;
    esac
    sleep 2
  done
  echo "TIMEOUT: task $task_id did not settle (last=$s)" >&2
  return 1
}

echo "STEP 1/8: submit workflow"
runh run "$PLAN_FILE" --no-track >/tmp/repro-submit.log 2>&1 || { cat /tmp/repro-submit.log; exit 1; }
WF_ID="$(runh query workflows --output json | tail -n 1 | jq -r '.[-1].id')"
TASK_ID="${WF_ID}/verify-after-merge"
echo "  workflowId=$WF_ID"
echo "  taskId=$TASK_ID"

echo "STEP 2/8: wait for initial failure (merge_conflict)"
S1="$(wait_until_settled_non_transient "$TASK_ID")"
E1="$(task_error "$TASK_ID")"
echo "  status=$S1"
echo "  error=$E1"
if [[ "$S1" != "failed" ]]; then
  echo "Expected initial failed status, got: $S1" >&2
  exit 1
fi
if [[ "$E1" != *'"type":"merge_conflict"'* ]]; then
  echo "Expected merge_conflict initial error, got: $E1" >&2
  exit 1
fi

echo "STEP 3/8: fix with codex (merge_conflict stage)"
runh fix "$TASK_ID" codex >/tmp/repro-fix1.log 2>&1 || { cat /tmp/repro-fix1.log; exit 1; }
wait_until_status "$TASK_ID" "awaiting_approval" 120
echo "  status=awaiting_approval"

echo "STEP 4/8: approve fix #1 (must rerun original task)"
runh approve "$TASK_ID" >/tmp/repro-approve1.log 2>&1 || { cat /tmp/repro-approve1.log; exit 1; }
S2="$(wait_until_settled_non_transient "$TASK_ID")"
E2="$(task_error "$TASK_ID")"
echo "  status=$S2"
echo "  error=$E2"
if [[ "$S2" != "failed" ]]; then
  echo "Expected second-stage failed status before second fix, got: $S2" >&2
  exit 1
fi
if [[ "$E2" == *'"type":"merge_conflict"'* ]]; then
  echo "Regression: still merge_conflict after first fix/approve" >&2
  exit 1
fi

echo "STEP 5/8: fix with codex (non-merge failure stage)"
runh fix "$TASK_ID" codex >/tmp/repro-fix2.log 2>&1 || { cat /tmp/repro-fix2.log; exit 1; }
wait_until_status "$TASK_ID" "awaiting_approval" 120
echo "  status=awaiting_approval"

echo "STEP 6/8: approve fix #2"
runh approve "$TASK_ID" >/tmp/repro-approve2.log 2>&1 || { cat /tmp/repro-approve2.log; exit 1; }

echo "STEP 7/8: verify final completion"
S3="$(wait_until_settled_non_transient "$TASK_ID")"
E3="$(task_error "$TASK_ID")"
echo "  status=$S3"
echo "  error=$E3"
if [[ "$S3" != "completed" ]]; then
  echo "Expected completed after second approve, got: $S3" >&2
  exit 1
fi

echo "STEP 8/8: PASS"
echo "  Sequence verified: merge_conflict -> fix+approve -> rerun(non-merge fail) -> fix+approve -> completed"
