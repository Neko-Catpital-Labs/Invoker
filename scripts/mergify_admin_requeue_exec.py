from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import time
from typing import Sequence

try:
    from .mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from .mergify_admin_requeue_loader import AdminBypassStackLoader
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Action, Ledger, PrSnapshot, load_mergify_rules
    from .mergify_admin_requeue_plan import plan_stack_execution
    from .mergify_admin_requeue_repairer import AdminBypassRepairer
    from .mergify_admin_requeue_snapshot import GhClient
    from .mergify_admin_requeue_workflow_fastpath import (
        resolve_workflow_for_pr,
        settle_workflow_fastpath_rows,
        submit_rebase_recreate,
        submit_repair_review_gate_ci,
    )
except ImportError:
    from mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from mergify_admin_requeue_loader import AdminBypassStackLoader
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Action, Ledger, PrSnapshot, load_mergify_rules
    from mergify_admin_requeue_plan import plan_stack_execution
    from mergify_admin_requeue_repairer import AdminBypassRepairer
    from mergify_admin_requeue_snapshot import GhClient
    from mergify_admin_requeue_workflow_fastpath import (
        resolve_workflow_for_pr,
        settle_workflow_fastpath_rows,
        submit_rebase_recreate,
        submit_repair_review_gate_ci,
    )

REPO_ROOT = Path(__file__).resolve().parents[1]


def print_action(action: Action, pr: PrSnapshot | None, dry_run: bool, as_json: bool) -> None:
    if as_json:
        print(json.dumps(action.__dict__, sort_keys=True))
        return
    prefix = "DRY-RUN " if dry_run else ""
    if action.kind == "requeue":
        head = pr.head_ref_oid if pr else ""
        print(f"{prefix}requeue PR #{action.pr_number} head={head} reason={action.detail}")
    elif action.kind == "repair_check":
        key = action.key.split(":", 1)[-1]
        print(f"{prefix}repair-check PR #{action.pr_number} check={json.dumps(key)}")
    elif action.kind == "comment_blocked":
        print(f"BLOCK PR #{action.pr_number} {action.detail}")
    elif action.kind == "comment_admin_bypass_nudge":
        print(f"{prefix}comment-admin-bypass-nudge PR #{action.pr_number}")
    elif action.kind == "restore_admin_bypass_label":
        print(f"{prefix}restore-admin-bypass-label PR #{action.pr_number}")
    elif action.kind == "retarget_base":
        from_base = pr.base_ref_name if pr else ""
        print(f"{prefix}retarget-base PR #{action.pr_number} from={from_base} to={action.key}")
    elif action.kind == "remove_merge_hold":
        print(f"{prefix}remove-merge-hold PR #{action.pr_number}")
    elif action.kind == "resolve_bot_threads":
        print(f"{prefix}resolve-bot-threads PR #{action.pr_number} thread={action.key}")
    elif action.kind == "repair_conflict":
        print(f"{prefix}repair-conflict PR #{action.pr_number} {action.detail}")


def run_cycle(args: argparse.Namespace) -> bool:
    rule_path = REPO_ROOT / ".mergify.yml"
    try:
        trunk, _labels, required_checks = load_mergify_rules(rule_path)
    except ValueError as exc:
        print("ERROR: failed to load admin-bypass Mergify rule", file=sys.stderr)
        raise RuntimeError("failed to load admin-bypass Mergify rule") from exc

    logger = AdminBypassLogger()
    logger.trace(
        "admin-bypass-scan-start",
        repo=args.repo,
        author=args.author,
        pr_numbers=list(args.pr),
        dry_run=args.dry_run,
        json_output=args.json,
    )
    gh = GhClient()
    ledger = Ledger(Path(args.state_file).expanduser())
    loader = AdminBypassStackLoader(gh)
    executor = AdminBypassGhExecutor(gh, ledger, logger, args.repo)
    repairer = AdminBypassRepairer(gh, executor, logger, ledger, args.repo)
    loaded = loader.load(args.repo, args.author, args.pr, required_checks, trunk)
    stacks = loaded.stacks
    now = int(time.time())
    try:
        fastpath_settled = settle_workflow_fastpath_rows(ledger, now)
        if fastpath_settled:
            logger.trace("admin-bypass-fastpath-settled", count=fastpath_settled)
    except Exception as exc:
        logger.trace("admin-bypass-fastpath-settle-failed", error=str(exc))
    pr_by_number = {pr.number: pr for stack in stacks for pr in stack.prs}
    logger.trace(
        "admin-bypass-scan-loaded",
        stack_count=len(stacks),
        stack_ids=[stack.stack_id for stack in stacks],
        candidate_pr_numbers=sorted(pr_by_number),
    )
    should_poll = False
    any_progress = False
    repair_dispatch_attempted = 0
    repair_dispatch_failed = 0
    repair_dispatch_succeeded = 0
    repair_dispatch_last_error: str | None = None
    open_pr_numbers = set(pr_by_number)
    for stack in stacks:
        plan = plan_stack_execution(
            stack,
            required_checks,
            ledger,
            now,
            open_pr_numbers,
            loaded.open_pr_numbers_by_head,
            args.max_requeue_attempts,
            args.max_repair_attempts,
            trunk,
        )
        queue_only_noop_check = plan.queue_only_noop_check
        logger.stack("admin-bypass-stack", plan.summary)
        if not plan.actions:
            should_poll = True
            if plan.wait_reason == "repair-prereq-open" and plan.prereq_status:
                logger.trace(
                    "admin-bypass-repair-prereq-wait",
                    repo=args.repo,
                    pr_number=plan.summary.get("bottom_pr"),
                    check_name=plan.prereq_status.check_name,
                    prereq_pr_number=plan.prereq_status.prereq_pr_number,
                )
            logger.trace("admin-bypass-stack-wait", reason=plan.wait_reason, summary=plan.summary)
            continue
        logger.trace("admin-bypass-stack-actions", stack_id=stack.stack_id, actions=logger.stack_action_payload(plan.actions))
        for action in plan.actions:
            pr = pr_by_number.get(action.pr_number)
            print_action(action, pr, args.dry_run, args.json)
            if args.dry_run:
                continue
            if pr is None:
                raise RuntimeError(f"missing PR snapshot for #{action.pr_number}")
            if action.kind == "repair_check":
                try:
                    if action.key.startswith("bot_review_thread:"):
                        thread_id = action.key.split(":", 1)[1]
                        outcome = repairer.repair_bot_thread(pr, thread_id, now)
                        progressed = outcome.status in {"pushed", "prereq_created", "submitted"}
                    else:
                        check_name = action.key
                        workflow_id = resolve_workflow_for_pr(action.pr_number)
                        if workflow_id:
                            submit_repair_review_gate_ci(action.pr_number)
                            ledger.record(
                                "repair-check", action.pr_number, pr.head_ref_oid, check_name, now,
                                meta={"workflowId": workflow_id, "via": "fastpath"},
                            )
                            progressed = True
                        else:
                            outcome = repairer.repair_check(pr, check_name, now)
                            progressed = outcome.status in {"pushed", "prereq_created", "submitted"}
                except Exception as exc:
                    repair_dispatch_attempted += 1
                    repair_dispatch_failed += 1
                    repair_dispatch_last_error = str(exc)
                    logger.trace(
                        "admin-bypass-repair-attempt-failed",
                        repo=args.repo,
                        pr_number=action.pr_number,
                        action_kind=action.kind,
                        key=action.key,
                        error=str(exc),
                    )
                    should_poll = True
                    continue
                if progressed:
                    repair_dispatch_attempted += 1
                    repair_dispatch_succeeded += 1
                    any_progress = True
                else:
                    should_poll = True
                continue
            elif action.kind == "repair_conflict":
                try:
                    workflow_id = resolve_workflow_for_pr(action.pr_number)
                    if workflow_id:
                        submit_rebase_recreate(workflow_id)
                        ledger.record(
                            "conflict-repair", action.pr_number, pr.head_ref_oid, action.key, now,
                            meta={"workflowId": workflow_id, "via": "fastpath"},
                        )
                        progressed = True
                    else:
                        outcome = repairer.repair_conflict(pr, action.detail, now)
                        progressed = outcome.status in {"pushed", "prereq_created", "submitted"}
                except Exception as exc:
                    repair_dispatch_attempted += 1
                    repair_dispatch_failed += 1
                    repair_dispatch_last_error = str(exc)
                    logger.trace(
                        "admin-bypass-repair-attempt-failed",
                        repo=args.repo,
                        pr_number=action.pr_number,
                        action_kind=action.kind,
                        key=action.key,
                        error=str(exc),
                    )
                    should_poll = True
                    continue
                if progressed:
                    repair_dispatch_attempted += 1
                    repair_dispatch_succeeded += 1
                    any_progress = True
                else:
                    should_poll = True
                continue
            else:
                performed = executor.execute(action, pr, now)
                if not performed:
                    should_poll = True
                    continue
                if action.kind == "requeue":
                    if (
                        plan.prereq_status
                        and plan.prereq_status.needs_followup_requeue
                        and action.pr_number == plan.summary.get("bottom_pr")
                    ):
                        ledger.record("repair-prereq-requeue", pr.number, pr.head_ref_oid, plan.prereq_status.check_name, now)
                        logger.trace(
                            "admin-bypass-repair-prereq-requeue",
                            repo=args.repo,
                            pr_number=pr.number,
                            check_name=plan.prereq_status.check_name,
                        )
                    if queue_only_noop_check and action.pr_number == plan.summary.get("bottom_pr"):
                        ledger.record("queue-only-requeue", pr.number, pr.head_ref_oid, queue_only_noop_check, now)
                        logger.trace(
                            "admin-bypass-queue-only-requeue",
                            repo=args.repo,
                            pr_number=pr.number,
                            check_name=queue_only_noop_check,
                        )
                if action.kind not in {"comment_blocked", "comment_admin_bypass_nudge"}:
                    any_progress = True
    if repair_dispatch_attempted >= 1 and repair_dispatch_succeeded == 0:
        logger.error(
            "admin-bypass-dispatch-degraded",
            repo=args.repo,
            attempted=repair_dispatch_attempted,
            failed=repair_dispatch_failed,
            last_error=repair_dispatch_last_error,
        )
    if not stacks:
        logger.trace("admin-bypass-scan-empty")
    return any_progress or should_poll


def run_once(args: argparse.Namespace) -> int:
    try:
        run_cycle(args)
    except RuntimeError:
        return 2
    return 0


def run_loop(args: argparse.Namespace) -> int:
    try:
        while run_cycle(args):
            time.sleep(args.poll_seconds)
    except RuntimeError:
        return 2
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair and queue open admin-bypass Mergify stacks.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Run one scan/action cycle and exit. Cron uses this.")
    mode.add_argument("--loop", action="store_true", help="Poll until no actionable stack remains.")
    parser.add_argument("--poll-seconds", type=float, default=60, help="Seconds to wait between loop scans. Default: 60.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned actions; perform no GitHub mutations.")
    parser.add_argument("--repo", default="Neko-Catpital-Labs/Invoker", help="Default: Neko-Catpital-Labs/Invoker.")
    parser.add_argument("--author", help="Limit scan to one author. Default: all authors.")
    parser.add_argument("--state-file", default=str(Path.home() / ".invoker" / "mergify-admin-requeue-state.jsonl"), help="Ledger JSONL path.")
    parser.add_argument("--pr", type=int, action="append", default=[], help="Limit to a PR; repeatable.")
    parser.add_argument("--max-requeue-attempts", type=int, default=2, help="Default: 2 per PR/head/dequeue event.")
    parser.add_argument("--max-repair-attempts", type=int, default=3, help="Default: 3 per PR/head/blocker.")
    parser.add_argument("--json", action="store_true", help="Emit one JSON object per decision/action.")
    return parser.parse_args(argv)
