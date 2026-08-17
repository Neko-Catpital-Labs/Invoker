from __future__ import annotations

import json

try:
    from .mergify_admin_requeue_headless_shell import run_headless
except ImportError:
    from mergify_admin_requeue_headless_shell import run_headless

# Captured verbatim from real SshExecutor crashes seen on PRs #5933, #6976,
# #7012, and #7019 during the same admin-bypass cron tick: the coding agent
# never launches, so no amount of retrying can produce a different repair
# result until an operator refreshes that SSH pool member's credentials.
SSH_OAUTH_INFRA_SIGNATURE = "Failed to authenticate: OAuth session expired and could not be refreshed"


def find_latest_workflow_id(plan_name: str, *, run_headless_fn=run_headless) -> str | None:
    completed = run_headless_fn('headless_query query workflows --output json')
    if completed.returncode != 0:
        return None
    try:
        workflows = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    matches = [w for w in workflows if isinstance(w, dict) and w.get("name") == plan_name]
    if not matches:
        return None
    matches.sort(key=lambda w: str(w.get("createdAt", "")))
    return matches[-1].get("id")


def _repair_task_completed(workflow_id: str, *, run_headless_fn=run_headless) -> bool | None:
    """True/False when the `repair` task's current status is known, None when
    the status lookup itself failed (caller should fail open toward "crashed")."""
    completed = run_headless_fn('headless_query query tasks "$2"', workflow_id)
    if completed.returncode != 0:
        return None
    try:
        tasks = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        return None
    repair_task = next(
        (t for t in tasks if isinstance(t, dict) and str(t.get("id", "")).endswith("/repair")),
        None,
    )
    if repair_task is None:
        return None
    return repair_task.get("status") == "completed"


def repair_task_crashed_on_infra(plan_name: str, *, run_headless_fn=run_headless) -> bool:
    """True when plan_name's most recent Invoker workflow's `repair` task
    crashed with the known SSH/OAuth infra signature -- a submission that
    never gave the coding agent a chance to touch the PR at all.

    A task that ultimately completed proves the agent did launch and finish,
    even if an earlier SSH retry attempt logged the signature before self-
    healing (e.g. credentials still propagating across the pool) -- checking
    the signature alone without the final status flags that case as crashed
    and triggers a redundant resubmission while the first attempt is still
    finishing. See PR #9309's own bot-thread repair (2026-08-16) for a real
    instance: the signature appeared 4 times, then the task completed.
    """
    workflow_id = find_latest_workflow_id(plan_name, run_headless_fn=run_headless_fn)
    if workflow_id is None:
        return False
    completed = run_headless_fn('headless_query query task-output "$2"', f"{workflow_id}/repair")
    if completed.returncode != 0 or SSH_OAUTH_INFRA_SIGNATURE not in completed.stdout:
        return False
    task_completed = _repair_task_completed(workflow_id, run_headless_fn=run_headless_fn)
    return task_completed is not True
