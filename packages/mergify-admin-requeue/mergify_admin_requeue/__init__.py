#!/usr/bin/env python3
from __future__ import annotations

import sys
from importlib import import_module
from typing import Sequence

from .gh_executor import AdminBypassGhExecutor
from .loader import AdminBypassStackLoader
from .logger import AdminBypassLogger
from .model import Action, Blocker, CheckContext, Ledger, MergifyQueueEvent, PrSnapshot, ReviewThread, StackGroup, latest_contexts_by_required_check, load_mergify_rules
from .plan import classify_pr, plan_stack_actions
from .repairer import AdminBypassRepairer
from .snapshot import group_stack_prs, parse_mergify_queue_event, parse_stack_metadata

exec_impl = import_module(".exec", __name__)

parse_args = exec_impl.parse_args
run_once = exec_impl.run_once
run_loop = exec_impl.run_loop
REPO_ROOT = exec_impl.REPO_ROOT


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return run_loop(args) if args.loop else run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
