#!/usr/bin/env python3
from __future__ import annotations

import sys
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

parse_args = exec_impl.parse_args
run_once = exec_impl.run_once
run_loop = exec_impl.run_loop
REPO_ROOT = exec_impl.REPO_ROOT
_repair_conflict = exec_impl.repair_conflict
_repair_check = exec_impl.repair_check
_execute_action = exec_impl.execute_action


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return run_loop(args) if args.loop else run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
