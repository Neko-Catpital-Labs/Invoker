from __future__ import annotations

import json

try:
    from .mergify_admin_requeue_headless_shell import run_headless as _run_headless
except ImportError:
    from mergify_admin_requeue_headless_shell import run_headless as _run_headless


def resolve_workflow_for_pr(pr_number: int) -> str | None:
    # See cron-pr-lib.sh's resolve_workflow_for_pr comment: review-gate exits 0
    # with `{}` for a genuine miss (no local workflow mapping). A non-zero exit
    # means the lookup mechanism itself is broken, which must propagate as an
    # exception rather than silently falling back to ad-hoc repair.
    completed = _run_headless('headless_query query review-gate "$2" --output json', str(pr_number))
    if completed.returncode != 0:
        raise RuntimeError(
            f"resolve_workflow_for_pr failed for PR #{pr_number}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )
    stdout = completed.stdout.strip()
    if not stdout:
        return None
    try:
        record = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"resolve_workflow_for_pr produced invalid JSON for PR #{pr_number}: {stdout!r}") from exc
    if not isinstance(record, dict):
        raise RuntimeError(f"resolve_workflow_for_pr produced non-object JSON for PR #{pr_number}: {stdout!r}")
    workflow_id = record.get("workflowId")
    return str(workflow_id) if workflow_id else None


# Known accepted limitation: no debounce against re-submitting the fast-path
# mutation on every cron tick while a previous submission converges.


def submit_rebase_recreate(workflow_id: str) -> None:
    completed = _run_headless('headless_mutation --no-track rebase-recreate "$2"', workflow_id)
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_rebase_recreate failed for workflow {workflow_id}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )


def submit_repair_review_gate_ci(pr_number: int) -> None:
    completed = _run_headless('headless_mutation --no-track repair-review-gate-ci "$2"', str(pr_number))
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_repair_review_gate_ci failed for PR #{pr_number}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )
