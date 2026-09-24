from __future__ import annotations

import argparse
import copy
import json
from pathlib import Path
import sys
import time
from typing import Sequence

try:
    from .mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from .mergify_admin_requeue_loader import AdminBypassStackLoader
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import (
        Action,
        DEFAULT_INVOKER_REPO,
        Ledger,
        PrSnapshot,
        load_mergify_rules,
        resolve_admin_bypass_rules_for_repo,
    )
    from .mergify_admin_requeue_plan import (
        REBASE_CONFLICT_REPAIR_FILING_KIND,
        REBASE_ONTO_MASTER_FILING_KIND,
        REBASE_ONTO_MASTER_LEDGER_KIND,
        ClaimRepairFiling,
        ReleaseRepairFiling,
        build_stack_report_sections,
        current_bottom_pr,
        mergify_check_state_sha,
        plan_stack_execution,
        repair_filing_kind_for_check,
        render_stack_report,
    )
    from .mergify_admin_requeue_repairer import AdminBypassRepairer
    from .mergify_admin_requeue_snapshot import GhClient
    from .mergify_admin_requeue_workflow_fastpath import (
        resolve_workflow_for_pr,
        settle_repairer_plan_rows,
        settle_workflow_fastpath_rows,
        submit_rebase_recreate,
        submit_repair_review_gate_ci,
    )
except ImportError:
    from mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from mergify_admin_requeue_loader import AdminBypassStackLoader
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import (
        Action,
        DEFAULT_INVOKER_REPO,
        Ledger,
        PrSnapshot,
        load_mergify_rules,
        resolve_admin_bypass_rules_for_repo,
    )
    from mergify_admin_requeue_plan import (
        REBASE_CONFLICT_REPAIR_FILING_KIND,
        REBASE_ONTO_MASTER_FILING_KIND,
        REBASE_ONTO_MASTER_LEDGER_KIND,
        ClaimRepairFiling,
        ReleaseRepairFiling,
        build_stack_report_sections,
        current_bottom_pr,
        mergify_check_state_sha,
        plan_stack_execution,
        repair_filing_kind_for_check,
        render_stack_report,
    )
    from mergify_admin_requeue_repairer import AdminBypassRepairer
    from mergify_admin_requeue_snapshot import GhClient
    from mergify_admin_requeue_workflow_fastpath import (
        resolve_workflow_for_pr,
        settle_repairer_plan_rows,
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
    repair_prefix = prefix if dry_run else "PENDING "
    if action.kind == "requeue":
        head = pr.head_ref_oid if pr else ""
        print(f"{prefix}requeue PR #{action.pr_number} head={head} reason={action.detail}")
    elif action.kind == "repair_check":
        key = action.key.split(":", 1)[-1]
        print(f"{repair_prefix}repair-check PR #{action.pr_number} check={json.dumps(key)}")
    elif action.kind == "comment_blocked":
        print(f"BLOCK PR #{action.pr_number} {action.detail}")
    elif action.kind == "escalate_requeue_stuck":
        print(f"{repair_prefix}escalate-requeue-stuck PR #{action.pr_number} {action.detail}")
    elif action.kind == "comment_admin_bypass_nudge":
        print(f"{prefix}comment-admin-bypass-nudge PR #{action.pr_number}")
    elif action.kind == "restore_admin_bypass_label":
        print(f"{prefix}restore-admin-bypass-label PR #{action.pr_number}")
    elif action.kind == "retarget_base":
        from_base = pr.base_ref_name if pr else ""
        print(f"{prefix}retarget-base PR #{action.pr_number} from={from_base} to={action.key}")
    elif action.kind == "squash_merge":
        head = pr.head_ref_oid if pr else ""
        print(f"{prefix}squash-merge PR #{action.pr_number} head={head} reason={action.detail}")
    elif action.kind == "rebase_onto_base":
        print(f"{repair_prefix}rebase-onto-base PR #{action.pr_number} onto={action.key}")
    elif action.kind == "rebase_onto_master":
        print(f"{repair_prefix}rebase-onto-master PR #{action.pr_number} {action.detail}")
    elif action.kind == "remove_merge_hold":
        print(f"{prefix}remove-merge-hold PR #{action.pr_number}")
    elif action.kind == "resolve_bot_threads":
        print(f"{prefix}resolve-bot-threads PR #{action.pr_number} thread={action.key}")


def print_repair_acknowledged(action: Action, as_json: bool) -> None:
    if as_json:
        print(json.dumps({"event": "repair-dispatch-acknowledged", **action.__dict__}, sort_keys=True))
        return
    if action.kind == "repair_check":
        key = action.key.split(":", 1)[-1]
        print(f"ACKNOWLEDGED repair-check PR #{action.pr_number} check={json.dumps(key)}")
    elif action.kind == "rebase_onto_master":
        print(f"ACKNOWLEDGED rebase-onto-master PR #{action.pr_number} {action.detail}")
    elif action.kind == "escalate_requeue_stuck":
        print(f"ACKNOWLEDGED escalate-requeue-stuck PR #{action.pr_number} {action.detail}")


def compute_stale_base_by_pr(stacks: Sequence, trunk: str, repo: str, gh: GhClient, logger: AdminBypassLogger) -> dict[int, bool]:
    # Only checked for each stack's current bottom PR (base already == trunk,
    # otherwise there is nothing to rebase onto yet) -- this bounds the cost
    # to one `gh api compare` call per ready-to-land stack per tick, not one
    # per candidate PR scanned. Uses GitHub's compare API instead of a local
    # git checkout so a normal scan never touches the filesystem or shells
    # out to real git -- the legacy `rebase_onto_base` executor action (no longer
    # planned for behind-master alone) is the one place that actually clones.
    stale_base_by_pr: dict[int, bool] = {}
    for stack in stacks:
        bottom = current_bottom_pr(stack, trunk)
        if bottom is None or "admin-bypass" not in bottom.labels:
            continue
        try:
            status = gh.compare_status(repo, trunk, bottom.head_ref_oid)
            stale_base_by_pr[bottom.number] = status not in {"ahead", "identical"}
        except Exception as exc:
            logger.trace(
                "admin-bypass-stale-base-check-failed",
                repo=repo,
                pr_number=bottom.number,
                error=str(exc),
            )
    return stale_base_by_pr


def report_repair_dispatch_failure(
    executor: AdminBypassGhExecutor,
    logger: AdminBypassLogger,
    pr: PrSnapshot,
    action_kind: str,
    now: int,
) -> None:
    try:
        executor.comment_repair_dispatch_failed(pr, action_kind, now)
    except Exception as exc:
        logger.trace(
            "admin-bypass-repair-dispatch-failure-comment-failed",
            repo=executor.repo,
            pr_number=pr.number,
            action_kind=action_kind,
            error=str(exc),
        )


def run_cycle(
    args: argparse.Namespace,
    claim_repair_filing: ClaimRepairFiling | None = None,
    release_repair_filing: ReleaseRepairFiling | None = None,
    rules: tuple[str, frozenset[str], frozenset[str]] | None = None,
) -> bool:
    # `rules` lets a multi-repo caller (run_cron_target_repos) pass in a
    # rule tuple it already resolved for a foreign repo via
    # resolve_admin_bypass_rules_for_repo, instead of always loading
    # Invoker's own local .mergify.yml regardless of args.repo. Every
    # existing single-repo caller omits it and keeps this exact prior
    # behavior.
    if rules is not None:
        trunk, _labels, required_checks = rules
    else:
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
    try:
        repairer_plan_settled = settle_repairer_plan_rows(ledger, now)
        if repairer_plan_settled:
            logger.trace("admin-bypass-repairer-plan-settled", count=repairer_plan_settled)
    except Exception as exc:
        logger.trace("admin-bypass-repairer-plan-settle-failed", error=str(exc))
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
    stale_base_by_pr = compute_stale_base_by_pr(stacks, trunk, args.repo, gh, logger)
    # A dry run never dispatches a repair (see the `if args.dry_run: continue`
    # below, right after print_action), so it has nothing to dedup against
    # other systems for -- claiming here would perform a real ledger write
    # for a filing that's never going to happen, and a claim that fails
    # closed (ledger/owner unreachable) would silently drop the action from
    # the printed plan instead.
    dry_run_claim_repair_filing = None if args.dry_run else claim_repair_filing
    dry_run_release_repair_filing = None if args.dry_run else release_repair_filing
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
            stale_base_by_pr,
            dry_run_claim_repair_filing,
            dry_run_release_repair_filing,
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
                        workflow_id = resolve_workflow_for_pr(action.pr_number, args.repo)
                        if workflow_id:
                            submit_repair_review_gate_ci(action.pr_number)
                            ledger.record(
                                "repair-check", action.pr_number, pr.head_ref_oid, check_name, now,
                                meta={"workflowId": workflow_id, "via": "fastpath"},
                            )
                            print_repair_acknowledged(action, args.json)
                            progressed = True
                        else:
                            outcome = repairer.repair_check(pr, check_name, now)
                            if outcome.status == "queue_only_noop":
                                # See plan.py's latest_queue_only_noop_check: without this
                                # record, a queue-only check with an empty job log settles
                                # here and then goes nowhere -- plan_bottom_progress can
                                # never see it, so the admin-bypass label never comes back
                                # and the PR is stuck outside the queue for good.
                                ledger.record("queue-only-noop", pr.number, pr.head_ref_oid, check_name, now)
                                logger.trace(
                                    "admin-bypass-queue-only-noop",
                                    repo=args.repo,
                                    pr_number=pr.number,
                                    check_name=check_name,
                                )
                            elif outcome.status == "noop" and check_name == "PR Body":
                                # See plan.py's plan_stack_execution: without this record,
                                # a PR whose body is already valid (or whose PR was merged/
                                # closed mid-repair) keeps re-running the same local PR-Body
                                # checkout+validate cycle every tick instead of the bottom
                                # check staying suppressed.
                                ledger.record("repair-noop", pr.number, pr.head_ref_oid, check_name, now)
                                logger.trace(
                                    "admin-bypass-repair-noop",
                                    repo=args.repo,
                                    pr_number=pr.number,
                                    check_name=check_name,
                                )
                            if outcome.status == "submitted":
                                print_repair_acknowledged(action, args.json)
                            progressed = outcome.status in {"pushed", "prereq_created", "submitted", "queue_only_noop"}
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
                    # The planner already claimed this key (if claim_repair_filing was
                    # wired in) before returning this Action; the actual dispatch
                    # (fastpath or repairer.repair_check) never completed, so release
                    # the claim or this key would be permanently blocked from every
                    # future retry. bot_review_thread repairs are planned by
                    # plan_bot_thread_repairs, which is not gated by claim_repair_filing,
                    # so there is nothing to release for that key shape.
                    #
                    # A "repair_check" Action can come from either
                    # mergify_failed_check_actions (claims with
                    # mergify_check_state_sha, a composite of head_ref_oid and
                    # the Mergify comment_id -- see that function) or
                    # plan_direct_repairs' own failed_check path (claims with
                    # the plain head_ref_oid); the Action itself carries no
                    # record of which one produced it, so release both
                    # possible shapes -- releasing a key that was never
                    # claimed is a safe no-op.
                    if release_repair_filing is not None and not action.key.startswith("bot_review_thread:"):
                        kind = repair_filing_kind_for_check(action.key)
                        release_repair_filing(kind, str(action.pr_number), pr.head_ref_oid)
                        if pr.latest_mergify is not None:
                            release_repair_filing(kind, str(action.pr_number), mergify_check_state_sha(pr, pr.latest_mergify))
                    report_repair_dispatch_failure(executor, logger, pr, action.kind, now)
                    should_poll = True
                    continue
                if progressed:
                    repair_dispatch_attempted += 1
                    repair_dispatch_succeeded += 1
                    any_progress = True
                else:
                    should_poll = True
                continue
            elif action.kind == "rebase_onto_master":
                try:
                    workflow_id = resolve_workflow_for_pr(action.pr_number, args.repo)
                    if workflow_id:
                        submit_rebase_recreate(workflow_id)
                        ledger.record(
                            REBASE_ONTO_MASTER_LEDGER_KIND, action.pr_number, pr.head_ref_oid, action.key, now,
                            meta={"workflowId": workflow_id, "via": "fastpath"},
                        )
                        print_repair_acknowledged(action, args.json)
                        progressed = True
                    else:
                        outcome = repairer.rebase_onto_master(pr, action.detail, now)
                        if outcome.status == "submitted":
                            print_repair_acknowledged(action, args.json)
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
                    if release_repair_filing is not None:
                        release_repair_filing(REBASE_ONTO_MASTER_FILING_KIND, str(action.pr_number), pr.head_ref_oid)
                    report_repair_dispatch_failure(executor, logger, pr, action.kind, now)
                    should_poll = True
                    continue
                if progressed:
                    repair_dispatch_attempted += 1
                    repair_dispatch_succeeded += 1
                    any_progress = True
                else:
                    should_poll = True
                continue
            elif action.kind == "escalate_requeue_stuck":
                try:
                    attempts = ledger.count("requeue", action.pr_number, pr.head_ref_oid, action.key)
                    outcome = repairer.escalate_stuck_requeue(pr, action.key, attempts, now)
                    if outcome.status == "submitted":
                        print_repair_acknowledged(action, args.json)
                    progressed = outcome.status == "submitted"
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
                    report_repair_dispatch_failure(executor, logger, pr, action.kind, now)
                    should_poll = True
                    continue
                if progressed:
                    repair_dispatch_attempted += 1
                    repair_dispatch_succeeded += 1
                    any_progress = True
                else:
                    should_poll = True
                continue
            elif action.kind == "rebase_onto_base":
                try:
                    progressed = executor.rebase_onto_base(pr, action.key, now)
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
                    if release_repair_filing is not None:
                        release_repair_filing(REBASE_CONFLICT_REPAIR_FILING_KIND, str(action.pr_number), pr.head_ref_oid)
                    should_poll = True
                    continue
                repair_dispatch_attempted += 1
                if progressed:
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


def run_once(
    args: argparse.Namespace,
    claim_repair_filing: ClaimRepairFiling | None = None,
    release_repair_filing: ReleaseRepairFiling | None = None,
) -> int:
    try:
        run_cycle(args, claim_repair_filing, release_repair_filing)
    except RuntimeError:
        return 2
    return 0


STATUS_STATE_FIELDS = ("outcomeClass", "workflowStatus", "dispatchState")


def status_state(meta: object) -> str:
    if not isinstance(meta, dict):
        return "-"
    for field in STATUS_STATE_FIELDS:
        value = meta.get(field)
        if value:
            return str(value)
    return "-"


def fold_status_entries(
    rows: Sequence[object],
    pr_filter: Sequence[int] = (),
) -> tuple[list[dict[str, object]], list[str]]:
    # Returns (entries, unreadable): a row this fold cannot key by PR number is
    # reported as unreadable rather than dropped, so a partial digest can never
    # be mistaken for a complete one.
    wanted = {int(number) for number in pr_filter}
    latest: dict[tuple[str, int, str, str], dict[str, object]] = {}
    unreadable: list[str] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            unreadable.append(f"row {index}: not a JSON object ({type(row).__name__})")
            continue
        try:
            pr_number = int(row["pr"])
        except (KeyError, TypeError, ValueError) as exc:
            unreadable.append(f"row {index}: unusable pr field {row.get('pr')!r} ({exc.__class__.__name__}: {exc})")
            continue
        if wanted and pr_number not in wanted:
            continue
        repo = str(row.get("repo") or "")
        kind = str(row.get("kind") or "")
        key = str(row.get("key") or "")
        try:
            epoch = int(row.get("epoch", 0) or 0)
        except (TypeError, ValueError) as exc:
            unreadable.append(
                f"row {index} (PR #{pr_number} {kind}): unusable epoch {row.get('epoch')!r} "
                f"({exc.__class__.__name__}: {exc}); folded as epoch 0"
            )
            epoch = 0
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else None
        entry = {
            "repo": repo or None,
            "pr": pr_number,
            "kind": kind,
            "key": key,
            "state": status_state(meta),
            "headSha": str(row.get("headSha") or ""),
            "epoch": epoch,
            "recordedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch)),
            "meta": dict(meta) if meta else {},
        }
        fold_key = (repo, pr_number, kind, key)
        previous = latest.get(fold_key)
        if previous is None or epoch >= int(previous["epoch"]):
            latest[fold_key] = entry
    return [latest[fold_key] for fold_key in sorted(latest)], unreadable


def group_status_entries(entries: Sequence[dict[str, object]]) -> list[tuple[str, int, list[dict[str, object]]]]:
    groups: dict[tuple[str, int], list[dict[str, object]]] = {}
    for entry in entries:
        groups.setdefault((str(entry["repo"] or ""), int(entry["pr"])), []).append(entry)
    return [(repo, pr_number, groups[(repo, pr_number)]) for repo, pr_number in sorted(groups)]


def count_unparsable_ledger_lines(state_file: Path, parsed_rows: int) -> int:
    # Ledger.__init__ drops any line it cannot decode into a dict. Counting the
    # difference here keeps those lines visible in the digest instead of letting
    # a silently shortened ledger read as a complete one.
    if not state_file.exists():
        return 0
    try:
        text = state_file.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"WARN: --status could not re-read {state_file} to count unparsable lines: {exc}", file=sys.stderr)
        return 0
    return max(0, sum(1 for line in text.splitlines() if line.strip()) - parsed_rows)


def render_status(
    state_file: Path,
    row_count: int,
    groups: Sequence[tuple[str, int, Sequence[dict[str, object]]]],
    unreadable: Sequence[str] = (),
    unparsable_lines: int = 0,
) -> str:
    header = f"ledger {state_file} rows={row_count} prs={len(groups)}"
    if unreadable or unparsable_lines:
        header += f" unreadable={len(unreadable) + unparsable_lines}"
    lines = [header]
    if not groups:
        lines.append("no recorded state")
    for repo, pr_number, entries in groups:
        lines.append(f"PR #{pr_number}" + (f" ({repo})" if repo else ""))
        for entry in entries:
            lines.append(
                f"  {entry['kind']} state={entry['state']} key={entry['key']!r} "
                f"head={entry['headSha'] or '-'} at={entry['recordedAt']}"
            )
    return "\n".join(lines) + "\n"


# Read-only by construction: loads the ledger file and returns before any
# GhClient, subprocess, or Ledger.record() call path is reachable.
def run_status(args: argparse.Namespace) -> int:
    state_file = Path(args.state_file).expanduser()
    ledger = Ledger(state_file)
    entries, unreadable = fold_status_entries(ledger.rows, args.pr)
    unparsable_lines = count_unparsable_ledger_lines(state_file, len(ledger.rows))
    for note in unreadable:
        print(f"WARN: --status skipped unreadable ledger {note}", file=sys.stderr)
    if unparsable_lines:
        print(
            f"WARN: --status: {unparsable_lines} line(s) in {state_file} were not decodable as JSON objects "
            f"and are absent from this digest",
            file=sys.stderr,
        )
    groups = group_status_entries(entries)
    if args.json:
        for repo, pr_number, pr_entries in groups:
            print(json.dumps(
                {
                    "stateFile": str(state_file),
                    "repo": repo or None,
                    "pr": pr_number,
                    "entries": list(pr_entries),
                    "unreadable": len(unreadable) + unparsable_lines,
                },
                sort_keys=True,
            ))
        return 0
    print(render_status(state_file, len(ledger.rows), groups, unreadable, unparsable_lines), end="")
    return 0


def run_report(args: argparse.Namespace) -> int:
    gh = GhClient()
    try:
        trunk, _labels, required_checks = resolve_rules_for_repo(args.repo, gh)
    except RuntimeError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    logger = AdminBypassLogger()
    ledger = Ledger(Path(args.state_file).expanduser())
    loader = AdminBypassStackLoader(gh)
    loaded = loader.load(args.repo, args.author, args.pr, required_checks, trunk)
    stacks = loaded.stacks
    now = int(time.time())
    stale_base_by_pr = compute_stale_base_by_pr(stacks, trunk, args.repo, gh, logger)
    pr_by_number = {pr.number for stack in stacks for pr in stack.prs}
    sections = build_stack_report_sections(
        stacks,
        required_checks,
        ledger,
        now,
        pr_by_number,
        loaded.open_pr_numbers_by_head,
        args.max_requeue_attempts,
        args.max_repair_attempts,
        trunk,
        stale_base_by_pr,
    )
    print(render_stack_report(args.repo, sections), end="")
    return 0


def run_loop(
    args: argparse.Namespace,
    claim_repair_filing: ClaimRepairFiling | None = None,
    release_repair_filing: ReleaseRepairFiling | None = None,
) -> int:
    try:
        while run_cycle(args, claim_repair_filing, release_repair_filing):
            time.sleep(args.poll_seconds)
    except RuntimeError:
        return 2
    return 0


def resolve_rules_for_repo(repo: str, gh: GhClient) -> tuple[str, frozenset[str], frozenset[str]]:
    # The Invoker repo itself always reads its own local checkout's
    # .mergify.yml (matches load_mergify_rules' pre-existing single-repo
    # behavior exactly, and avoids a needless network round trip for the
    # repo cron already runs from). Every other target repo has no local
    # checkout to read, so its rule (if any) and default branch come from
    # the GitHub API instead.
    if repo == DEFAULT_INVOKER_REPO:
        try:
            return load_mergify_rules(REPO_ROOT / ".mergify.yml")
        except ValueError as exc:
            raise RuntimeError(f"failed to load admin-bypass Mergify rule for {repo}") from exc
    file_text = gh.file_text(repo, ".mergify.yml")
    default_branch = gh.default_branch(repo)
    try:
        return resolve_admin_bypass_rules_for_repo(repo, file_text, default_branch)
    except ValueError as exc:
        raise RuntimeError(f"failed to resolve admin-bypass rules for {repo}") from exc


def rotate_target_repos(target_repos: Sequence[str], rotation_path: Path) -> list[str]:
    repos = list(target_repos)
    if len(repos) < 2:
        return repos
    offset = 0
    try:
        offset = int(rotation_path.read_text().strip() or "0")
    except FileNotFoundError:
        offset = 0
    except (OSError, ValueError) as exc:
        print(f"WARN: unreadable repo rotation state {rotation_path}: {exc}; starting from the first repo", file=sys.stderr)
        offset = 0
    start = offset % len(repos)
    try:
        rotation_path.parent.mkdir(parents=True, exist_ok=True)
        rotation_path.write_text(str((start + 1) % len(repos)))
    except OSError as exc:
        print(f"WARN: could not write repo rotation state {rotation_path}: {exc}", file=sys.stderr)
    return repos[start:] + repos[:start]


def run_cron_target_repos(
    args: argparse.Namespace,
    target_repos: Sequence[str],
    claim_repair_filing: ClaimRepairFiling | None = None,
    release_repair_filing: ReleaseRepairFiling | None = None,
    gh: GhClient | None = None,
) -> int:
    # Cron entry point for scanning more than one repo in a single tick.
    # Each repo gets its own rule resolution (its own Mergify text/default
    # branch, per resolve_rules_for_repo) and its own args.repo so every
    # downstream call (ledger, executor, repairer, fastpath) stays scoped
    # to that one repo. One repo's rule-resolution or scan failure is
    # logged and skipped rather than aborting the whole cron tick.
    gh = gh or GhClient()
    had_failure = False
    ordered_repos = rotate_target_repos(target_repos, Path(args.state_file).expanduser().with_suffix(".repo-rotation"))
    for repo in ordered_repos:
        repo_args = copy.copy(args)
        repo_args.repo = repo
        try:
            rules = resolve_rules_for_repo(repo, gh)
        except RuntimeError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            had_failure = True
            continue
        try:
            run_cycle(repo_args, claim_repair_filing, release_repair_filing, rules=rules)
        except RuntimeError:
            had_failure = True
    return 2 if had_failure else 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair and queue open admin-bypass Mergify stacks.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Run one scan/action cycle and exit. Cron uses this.")
    mode.add_argument("--loop", action="store_true", help="Poll until no actionable stack remains.")
    mode.add_argument("--report", action="store_true", help="Render a read-only stack, blocker, cap, and repair workflow report.")
    mode.add_argument(
        "--status",
        action="store_true",
        help="Print the latest recorded kind/state/key per PR from --state-file. Reads the ledger only: no GitHub access, no subprocess, no writes.",
    )
    parser.add_argument("--poll-seconds", type=float, default=60, help="Seconds to wait between loop scans. Default: 60.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned actions; perform no GitHub mutations.")
    parser.add_argument("--repo", default="Neko-Catpital-Labs/Invoker", help="Default: Neko-Catpital-Labs/Invoker.")
    parser.add_argument(
        "--target-repos",
        default="",
        help="Comma-separated repos to cron over in one tick (owner/name,owner/name,...). "
        "Default: --repo alone. Any repo other than --repo's default is treated as foreign: "
        "its own Mergify rule (or default branch) is resolved via the GitHub API, and its "
        "repair plans never invoke Invoker-only repair helper scripts.",
    )
    parser.add_argument("--author", help="Limit scan to one author. Default: all authors.")
    parser.add_argument("--state-file", default=str(Path.home() / ".invoker" / "mergify-admin-requeue-state.jsonl"), help="Ledger JSONL path.")
    parser.add_argument("--pr", type=int, action="append", default=[], help="Limit to a PR; repeatable.")
    parser.add_argument("--max-requeue-attempts", type=int, default=2, help="Default: 2 per PR/head/dequeue event.")
    parser.add_argument("--max-repair-attempts", type=int, default=3, help="Default: 3 per PR/head/blocker.")
    parser.add_argument("--json", action="store_true", help="Emit one JSON object per decision/action.")
    args = parser.parse_args(argv)
    if args.report and args.target_repos:
        parser.error("--report cannot be combined with --target-repos; pass one --repo instead")
    return args
