#!/usr/bin/env python3
from __future__ import annotations

import sys
from typing import Sequence

try:
    from . import mergify_admin_requeue_exec as exec_impl
    from .mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from .mergify_admin_requeue_loader import AdminBypassStackLoader
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Action, Blocker, CheckContext, Ledger, MergifyQueueEvent, PrSnapshot, ReviewThread, StackGroup, latest_contexts_by_required_check, load_mergify_rules
    from .mergify_admin_requeue_plan import classify_pr, default_claim_repair_filing, default_release_repair_filing, plan_stack_actions
    from .mergify_admin_requeue_repairer import AdminBypassRepairer
    from .mergify_admin_requeue_snapshot import group_stack_prs, parse_mergify_queue_event, parse_stack_metadata
except ImportError:
    import mergify_admin_requeue_exec as exec_impl
    from mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from mergify_admin_requeue_loader import AdminBypassStackLoader
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Action, Blocker, CheckContext, Ledger, MergifyQueueEvent, PrSnapshot, ReviewThread, StackGroup, latest_contexts_by_required_check, load_mergify_rules
    from mergify_admin_requeue_plan import classify_pr, default_claim_repair_filing, default_release_repair_filing, plan_stack_actions
    from mergify_admin_requeue_repairer import AdminBypassRepairer
    from mergify_admin_requeue_snapshot import group_stack_prs, parse_mergify_queue_event, parse_stack_metadata

parse_args = exec_impl.parse_args
run_once = exec_impl.run_once
run_loop = exec_impl.run_loop
REPO_ROOT = exec_impl.REPO_ROOT


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    target_repos = [repo.strip() for repo in args.target_repos.split(",") if repo.strip()]
    if target_repos:
        return exec_impl.run_cron_target_repos(
            args, target_repos, default_claim_repair_filing, default_release_repair_filing
        )
    if args.loop:
        return run_loop(args, default_claim_repair_filing, default_release_repair_filing)
    return run_once(args, default_claim_repair_filing, default_release_repair_filing)


if __name__ == "__main__":
    raise SystemExit(main())
