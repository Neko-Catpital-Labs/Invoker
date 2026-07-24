#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path
from typing import Sequence

try:
    from . import mergify_admin_requeue_exec as exec_impl
    from .mergify_admin_requeue_model import Action, Blocker, CheckContext, Ledger, MergifyQueueEvent, PrSnapshot, ReviewThread, StackGroup, latest_contexts_by_required_check, load_mergify_rules
    from .mergify_admin_requeue_plan import classify_pr, plan_stack_actions
    from .mergify_admin_requeue_snapshot import group_stack_prs, parse_mergify_queue_event, parse_stack_metadata
except ImportError:
    import mergify_admin_requeue_exec as exec_impl
    from mergify_admin_requeue_model import Action, Blocker, CheckContext, Ledger, MergifyQueueEvent, PrSnapshot, ReviewThread, StackGroup, latest_contexts_by_required_check, load_mergify_rules
    from mergify_admin_requeue_plan import classify_pr, plan_stack_actions
    from mergify_admin_requeue_snapshot import group_stack_prs, parse_mergify_queue_event, parse_stack_metadata

REPO_ROOT = Path(__file__).resolve().parents[1]
parse_args = exec_impl.parse_args
run_once = exec_impl.run_once
subprocess = exec_impl.subprocess
execute_action = exec_impl.execute_action
resolve_workflow = exec_impl.resolve_workflow
repair_conflict = exec_impl.repair_conflict
repair_check = exec_impl.repair_check


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
