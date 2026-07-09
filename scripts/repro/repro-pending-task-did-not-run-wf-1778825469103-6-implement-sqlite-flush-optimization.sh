#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="wf-1778825469103-6/implement-sqlite-flush-optimization"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: prepareTaskForNewAttempt cleared workspacePath but retained stale branch metadata."
echo "[repro] effect: the next worktree launch was not forced fresh, so content-hash reuse could select an old attempt workspace."

python3 <<'PY'
TASK_ID = "wf-1778825469103-6/implement-sqlite-flush-optimization"

task = {
    "id": TASK_ID,
    "status": "running",
    "execution": {
        "generation": 189,
        "selectedAttemptId": f"{TASK_ID}-a82665236",
        "phase": "executing",
        "launchStartedAt": "2026-06-05T02:22:31.311Z",
        "launchCompletedAt": "2026-06-05T02:23:16.452Z",
    },
}

executor_selected_event = {
    "eventType": "task.executor.selected",
    "payload": {
        "attemptId": f"{TASK_ID}-a82665236",
        "workspacePath": (
            "/Users/edbertchan/.invoker/worktrees/64a63486912a/"
            "experiment-wf-1778825469103-6-implement-sqlite-flush-optimization-"
            "g78.t188.a-a3ed992b9-fbfdc0f9"
        ),
        "branch": (
            "experiment/wf-1778825469103-6/implement-sqlite-flush-optimization/"
            "g78.t189.a-a82665236-fbfdc0f9"
        ),
    },
}

pre_fix_reset_execution = {
    # This was the bad shape produced by prepareTaskForNewAttempt: generation
    # changed and workspacePath was cleared, but branch still pointed at the
    # previous attempt.
    "generation": 189,
    "selectedAttemptId": f"{TASK_ID}-a82665236",
    "branch": (
        "experiment/wf-1778825469103-6/implement-sqlite-flush-optimization/"
        "g78.t188.a-a3ed992b9-fbfdc0f9"
    ),
    "workspacePath": None,
}

def lifecycle_fragment(value: str) -> str:
    for fragment in value.replace("/", "-").split("-"):
        if fragment.startswith("g78.t"):
            return fragment
    raise AssertionError(f"missing lifecycle fragment in {value!r}")

branch = executor_selected_event["payload"]["branch"]
workspace_path = executor_selected_event["payload"]["workspacePath"]
assert task["status"] == "running"
assert task["execution"]["phase"] == "executing"
assert executor_selected_event["payload"]["attemptId"] == task["execution"]["selectedAttemptId"]
assert "g78.t189.a-a82665236" in branch
assert "g78.t188.a-a3ed992b9" in workspace_path
assert lifecycle_fragment(branch) != lifecycle_fragment(workspace_path)

old_should_force_fresh_workspace = (
    pre_fix_reset_execution["generation"] > 0
    and pre_fix_reset_execution.get("branch") is None
    and pre_fix_reset_execution.get("workspacePath") is None
)
assert old_should_force_fresh_workspace is False

fixed_reset_execution = {
    **pre_fix_reset_execution,
    "branch": None,
}
fixed_should_force_fresh_workspace = (
    fixed_reset_execution["generation"] > 0
    and fixed_reset_execution.get("branch") is None
    and fixed_reset_execution.get("workspacePath") is None
)
assert fixed_should_force_fresh_workspace is True

print("[repro] pre-fix diagnostic confirmed: branch lifecycle t189 selected workspace lifecycle t188")
print("[repro] pre-fix reset shape would not force a fresh worktree")
print("[repro] fixed reset shape clears branch and forces fresh worktree selection")
PY

echo "[repro] Prove the fix in workflow-core."
pnpm --filter @invoker/workflow-core exec vitest run \
  src/__tests__/orchestrator.test.ts \
  -t "resets a running launching task to pending with a fresh selected attempt and clears launch lineage"

echo "[repro] passed"
