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


def repair_task_crashed_on_infra(plan_name: str, *, run_headless_fn=run_headless) -> bool:
    """True when plan_name's most recent Invoker workflow's `repair` task
    crashed with the known SSH/OAuth infra signature -- a submission that
    never gave the coding agent a chance to touch the PR at all."""
    workflow_id = find_latest_workflow_id(plan_name, run_headless_fn=run_headless_fn)
    if workflow_id is None:
        return False
    completed = run_headless_fn('headless_query query task-output "$2"', f"{workflow_id}/repair")
    return completed.returncode == 0 and SSH_OAUTH_INFRA_SIGNATURE in completed.stdout
