#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="__merge__wf-1782192500131-3"
SOURCE="$ROOT/packages/execution-engine/src/merge-gate-executor.ts"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: merge gate worktree creation ran inside executor.start(), before task.running"

python3 - "$SOURCE" <<'PY'
import pathlib
import re
import sys

source_path = pathlib.Path(sys.argv[1])
source = source_path.read_text(encoding="utf-8")
task_id = "__merge__wf-1782192500131-3"

class Task:
    def __init__(self):
        self.status = "pending"
        self.phase = "launching"
        self.launch_completed_at = None
        self.running_counted_by_dispatch = True
        self.real_merge_clone_blocked = True

def pre_fix_start(task: Task) -> bool:
    # Before the fix, MergeGateExecutor.start awaited createMergeWorktree().
    # If the clone/fetch path blocked, start() never returned a handle.
    if task.real_merge_clone_blocked:
        return False
    return True

def post_fix_start(task: Task) -> bool:
    # After the fix, start() creates only a lightweight launch directory and
    # schedules real merge work asynchronously.
    return True

def task_runner_launch(task: Task, start_returns: bool) -> None:
    if not start_returns:
        return
    task.status = "running"
    task.phase = "executing"
    task.launch_completed_at = "2026-06-23T06:02:27.000Z"

pre = Task()
task_runner_launch(pre, pre_fix_start(pre))
assert pre.running_counted_by_dispatch
assert pre.status == "pending"
assert pre.phase == "launching"
assert pre.launch_completed_at is None

post = Task()
task_runner_launch(post, post_fix_start(post))
assert post.status == "running"
assert post.phase == "executing"
assert post.launch_completed_at is not None

start_match = re.search(r"async start\(request: WorkRequest\): Promise<ExecutorHandle> \{(?P<body>.*?)\n  async kill", source, re.S)
if not start_match:
    raise SystemExit("could not locate MergeGateExecutor.start()")
start_body = start_match.group("body")

required_needles = [
    "const launchWorkspacePath = this.createLaunchWorkspace(task.id);",
    "handle.workspacePath = launchWorkspacePath;",
    "void this.run(handle, task, launchWorkspacePath);",
    "const result = await runMergeGateActionImpl(this.host, task);",
    "workspacePath: result.taskChanges.execution.workspacePath ?? launchWorkspacePath",
]
missing = [needle for needle in required_needles if needle not in source]
if missing:
    raise SystemExit("fixed merge launch handoff source invariant missing: " + ", ".join(missing))

if "await this.host.createMergeWorktree" in start_body or "await this.host.detectDefaultBranch" in start_body:
    raise SystemExit("MergeGateExecutor.start() still performs blocking merge setup before launch completion")

print("[repro] pre-fix model: dispatch counted running while task stayed pending/launching with no launchCompletedAt")
print("[repro] post-fix model: start returns a handle, allowing TaskRunner to mark the task running")
print("[repro] source check: blocking merge worktree creation is outside MergeGateExecutor.start()")
PY

echo "[repro] passed"
