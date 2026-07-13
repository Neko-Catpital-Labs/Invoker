#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path
from typing import Mapping, Sequence

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
_repair_conflict = exec_impl.repair_conflict
_repair_check = exec_impl.repair_check
_resolve_workflow = exec_impl.resolve_workflow


def _execute_action(action: Action, repo: str, gh, ledger: Ledger, pr_by_number: Mapping[int, PrSnapshot], now: int) -> None:
    pr = pr_by_number[action.pr_number]
    if action.kind == "requeue":
        gh.comment(repo, action.pr_number, "@mergifyio queue")
        ledger.record("requeue", action.pr_number, pr.head_ref_oid, action.key, now)
    elif action.kind == "add_admin_bypass_label":
        gh.edit_label(repo, action.pr_number, add="admin-bypass")
        ledger.record("add_admin_bypass_label", action.pr_number, pr.head_ref_oid, "admin-bypass", now)
    elif action.kind == "remove_merge_hold":
        gh.edit_label(repo, action.pr_number, remove="merge-hold")
        ledger.record("remove-merge-hold", action.pr_number, pr.head_ref_oid, "merge-hold", now)
    elif action.kind == "resolve_bot_threads":
        gh.resolve_review_thread(action.key)
    elif action.kind == "repair_check":
        check_name = action.key.split(":", 1)[-1]
        kind = "repair-bot-thread" if action.key.startswith("bot_review_thread:") else "repair-check"
        ledger.record(kind, action.pr_number, pr.head_ref_oid, check_name, now)
        _repair_check(repo, pr, check_name)
    elif action.kind == "rebase_recreate":
        ledger.record("conflict-repair", action.pr_number, pr.head_ref_oid, action.key, now)
        try:
            workflow, _generation = _resolve_workflow(action.pr_number)
        except RuntimeError as exc:
            _repair_conflict(repo, pr, str(exc))
            return
        subprocess.run(["node", "scripts/headless-ipc.js", "exec", "--", "rebase-recreate", workflow], cwd=str(REPO_ROOT), check=True, text=True, capture_output=True)
    elif action.kind == "comment_blocked" and action.key == "capped":
        key = f"capped:{action.detail}"
        if ledger.count("comment-blocked", action.pr_number, pr.head_ref_oid, key) == 0:
            gh.comment(repo, action.pr_number, f"Invoker Mergify repair stopped: {action.detail}")
            ledger.record("comment-blocked", action.pr_number, pr.head_ref_oid, key, now)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
