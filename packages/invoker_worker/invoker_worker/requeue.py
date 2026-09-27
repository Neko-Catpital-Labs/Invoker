from __future__ import annotations

from typing import Any

from invoker_worker import Worker, WorkerDecision

REQUEUE_COMMAND_CHANNEL = "invoker:requeue"
REQUEUEABLE_FAILURE_CLASSES = frozenset(
    {
        "liveness_stall",
        "ssh-transport-transient",
    }
)


class RequeueWorker(Worker):
    kind = "heartbeat-requeue"

    def read_state(self, ctx: dict[str, Any]) -> dict[str, Any]:
        return dict(ctx.get("state") or {})

    def decide(self, state: dict[str, Any], ctx: dict[str, Any]) -> list[WorkerDecision]:
        if state.get("eligible") is False:
            return [{"type": "skip", "reason": "no-eligible-work"}]
        status = state.get("status")
        failure_class = state.get("failureClass")
        if status != "failed":
            return [{"type": "skip", "reason": "not-failed"}]
        if failure_class not in REQUEUEABLE_FAILURE_CLASSES:
            return [{"type": "skip", "reason": "not-requeueable-failure"}]
        task_id = state.get("taskId")
        workflow_id = state.get("workflowId")
        if not isinstance(task_id, str) or not isinstance(workflow_id, str):
            return [{"type": "skip", "reason": "missing-ids"}]
        return [
            {
                "type": "mutation",
                "workflowId": workflow_id,
                "channel": REQUEUE_COMMAND_CHANNEL,
                "args": [{"taskId": task_id}],
                "priority": "normal",
            }
        ]
