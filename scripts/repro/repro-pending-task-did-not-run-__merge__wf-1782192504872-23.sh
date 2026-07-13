#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="__merge__wf-1782192504872-23"
SOURCE="$ROOT/packages/execution-engine/src/pr-authoring.ts"
TEST_SOURCE="$ROOT/packages/execution-engine/src/__tests__/pr-authoring.test.ts"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: external-review make-pr agent publication had no timeout, so the processless merge executor could heartbeat forever after task.running"

python3 - "$SOURCE" "$TEST_SOURCE" <<'PY'
import pathlib
import sys

source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
test_source = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")

class MergeTask:
    def __init__(self):
        self.status = "running"
        self.phase = "executing"
        self.launch_completed_at = "2026-06-23T08:45:42.355Z"
        self.executor_selected = True
        self.heartbeats = 30
        self.review_ready = False
        self.completed = False
        self.failed = False

def pre_fix_publish_make_pr(task: MergeTask) -> str:
    # Before the fix, spawnAgentPrAuthorViaRegistry waited only for child close.
    # A hung make-pr agent left runMergeGateActionImpl unresolved while the
    # processless MergeGateExecutor heartbeat timer kept the task alive.
    return "pending-forever"

def post_fix_publish_make_pr(task: MergeTask) -> str:
    task.failed = True
    return "timeout-failed"

pre = MergeTask()
assert pre_fix_publish_make_pr(pre) == "pending-forever"
assert pre.status == "running"
assert pre.phase == "executing"
assert pre.launch_completed_at is not None
assert pre.executor_selected
assert pre.heartbeats > 0
assert not pre.review_ready and not pre.completed and not pre.failed

post = MergeTask()
assert post_fix_publish_make_pr(post) == "timeout-failed"
assert post.failed

required_source = [
    "DEFAULT_PR_AUTHORING_TIMEOUT_MS",
    "INVOKER_PR_AUTHORING_TIMEOUT_MS",
    "killProcessGroup(child, 'SIGTERM')",
    "killProcessGroup(child, 'SIGKILL')",
    "detached: process.platform !== 'win32'",
    "PR authoring exceeded timeout",
]
missing = [needle for needle in required_source if needle not in source]
if missing:
    raise SystemExit("fixed PR-authoring timeout invariant missing: " + ", ".join(missing))

if "times out and rejects when the PR-authoring agent never exits" not in test_source:
    raise SystemExit("focused hung PR-authoring regression test is missing")

print("[repro] pre-fix model: task is running/executing with launchCompletedAt, but make-pr publication never resolves")
print("[repro] post-fix model: hung make-pr publication rejects, allowing the merge executor to complete failed")
print("[repro] source check: PR-authoring child processes are now bounded and killed on timeout")
PY

pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/pr-authoring.test.ts -t 'times out and rejects when the PR-authoring agent never exits'

echo "[repro] passed"
