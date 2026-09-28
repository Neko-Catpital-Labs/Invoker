from __future__ import annotations

from typing import Any

from invoker_worker import Worker, WorkerDecision

RETIRE_CHANNEL = "invoker:delete-workflow"
ACTIVE_STATUSES = frozenset(
    {
        "pending",
        "running",
        "needs_input",
        "blocked",
        "awaiting_approval",
        "fixing",
        "review_ready",
    }
)


class IdleTaskCleanupWorker(Worker):
    kind = "idle-task-cleanup"

    def read_state(self, ctx: dict[str, Any]) -> dict[str, Any]:
        return dict(ctx.get("state") or {})

    def decide(self, state: dict[str, Any], ctx: dict[str, Any]) -> list[WorkerDecision]:
        if state.get("eligible") is False:
            return [{"type": "skip", "reason": "no-eligible-work"}]
        workflows = state.get("workflows") or []
        tasks_by = state.get("tasksByWorkflow") or {}
        decisions: list[WorkerDecision] = []
        for workflow in workflows:
            if not isinstance(workflow, dict):
                continue
            workflow_id = workflow.get("id")
            if not isinstance(workflow_id, str):
                continue
            tasks = tasks_by.get(workflow_id) or []
            if workflow.get("status") == "completed" and not any(
                isinstance(task, dict) and task.get("status") in ACTIVE_STATUSES for task in tasks
            ):
                decisions.append(
                    {
                        "type": "mutation",
                        "workflowId": workflow_id,
                        "channel": RETIRE_CHANNEL,
                        "args": [workflow_id],
                        "priority": "normal",
                    }
                )
        if not decisions:
            return [{"type": "skip", "reason": "no-eligible-work"}]
        return decisions
