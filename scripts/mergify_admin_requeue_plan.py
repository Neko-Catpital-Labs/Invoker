from __future__ import annotations

from typing import Collection, Mapping

try:
    from .mergify_admin_requeue_model import (
        Action,
        BOT_OR_SELF_AUTHORS,
        Blocker,
        Ledger,
        MergifyQueueEvent,
        PrSnapshot,
        RepairPrereqStatus,
        StackExecutionPlan,
        StackGroup,
    )
except ImportError:
    from mergify_admin_requeue_model import (
        Action,
        BOT_OR_SELF_AUTHORS,
        Blocker,
        Ledger,
        MergifyQueueEvent,
        PrSnapshot,
        RepairPrereqStatus,
        StackExecutionPlan,
        StackGroup,
    )


TRUNK = "master"

QUEUE_ONLY_REQUIRED_CHECKS = frozenset({
    "required-fast / Guardrails",
    "required-fast / Vitest Workspace",
    "required-fast / Submit Workflow Chain",
})


def is_queue_only_required_check(name: str) -> bool:
    # .github/workflows/ci.yml:306-328 gates these required-fast matrix jobs to
    # merge-queue heads, so they do not exist on ordinary PR heads.
    return name in QUEUE_ONLY_REQUIRED_CHECKS


def classify_pr(pr: PrSnapshot, required_checks: Collection[str], trunk: str) -> tuple[Blocker, ...]:
    blockers: list[Blocker] = []
    if pr.state != "OPEN":
        blockers.append(Blocker("closed", "closed", pr.number, f"state={pr.state}"))
        return tuple(blockers)
    if pr.is_draft:
        blockers.append(Blocker("draft", "draft", pr.number, "PR is draft"))
        return tuple(blockers)
    if pr.base_ref_name != trunk:
        blockers.append(Blocker("not_current_bottom", "not_current_bottom", pr.number, f"base={pr.base_ref_name}"))
    if "merge-hold" in pr.labels:
        blockers.append(Blocker("merge-hold", "merge_hold", pr.number, "merge-hold label present"))

    for thread in pr.review_threads:
        if thread.is_resolved:
            continue
        authors = set(thread.author_logins)
        if not authors or authors - BOT_OR_SELF_AUTHORS:
            blockers.append(Blocker(thread.id, "human_review_thread", pr.number, f"unresolved human review thread {thread.id}"))
        else:
            blockers.append(Blocker(thread.id, "bot_review_thread", pr.number, f"unresolved bot review thread {thread.id}"))

    if pr.merge_state_status == "DIRTY" or pr.mergeable == "CONFLICTING":
        blockers.append(Blocker("conflict", "conflict", pr.number, "GitHub reports merge conflict"))

    for name in sorted(required_checks):
        ctx = pr.checks.get(name)
        if ctx is None:
            if pr.base_ref_name == trunk:
                blockers.append(Blocker(name, "missing_check", pr.number, f"missing required check {name}"))
            continue
        if ctx.state == "success":
            continue
        if ctx.state == "failure":
            blockers.append(Blocker(name, "failed_check", pr.number, f"required check failed: {name}"))
        elif ctx.state in {"pending", "unknown"}:
            blockers.append(Blocker(name, "pending_check", pr.number, f"required check not green: {name}={ctx.state}"))
    return tuple(blockers)


def public_blocker_kind(kind: str) -> str:
    return kind.replace("_", "-")


def cap_action(pr: PrSnapshot, blocker: Blocker, detail: str) -> Action:
    return Action("comment_blocked", pr.number, "capped", f"{detail}. The retry cap was reached for current head {pr.head_ref_oid}.")


def mergify_condition_map(event: MergifyQueueEvent | None) -> dict[str, str]:
    return dict(event.condition_states) if event else {}


def effective_blockers(
    pr: PrSnapshot,
    required_checks: Collection[str],
    trunk: str,
    suppressed_failed_checks: Collection[str] = (),
) -> tuple[Blocker, ...]:
    suppressed = set(suppressed_failed_checks)
    blockers = [
        b for b in classify_pr(pr, required_checks, trunk)
        if b.kind != "not_current_bottom" and not (b.kind == "failed_check" and b.key in suppressed)
    ]
    latest = pr.latest_mergify
    if not latest or latest.head_sha != pr.head_ref_oid:
        return tuple(blockers)
    conditions = mergify_condition_map(latest)
    return tuple(
        blocker for blocker in blockers
        if not (
            blocker.kind == "missing_check"
            and (
                conditions.get(blocker.key) == "success"
                or (
                    latest.state == "dequeued"
                    and is_queue_only_required_check(blocker.key)
                    and blocker.key in latest.failing_checks
                )
            )
        )
    )


def mergify_failed_check_actions(
    pr: PrSnapshot,
    ledger: Ledger,
    suppressed_failed_checks: Collection[str] = (),
) -> tuple[Action, ...]:
    suppressed = set(suppressed_failed_checks)
    latest = pr.latest_mergify
    if not latest or latest.state != "dequeued" or latest.head_sha != pr.head_ref_oid:
        return ()
    for name in latest.failing_checks:
        if name in suppressed:
            continue
        if ledger.count("repair-check", pr.number, pr.head_ref_oid, name) >= 3:
            return (cap_action(pr, Blocker(name, "failed_check", pr.number, f"Mergify queue check failed: {name}"), f"Mergify queue check failed: {name}"),)
        return (Action("repair_check", pr.number, name, f"Mergify queue check failed: {name}"),)
    return ()

def current_bottom_pr(stack: StackGroup, trunk: str) -> PrSnapshot | None:
    for pr in stack.prs:
        if pr.state == "OPEN" and pr.base_ref_name == trunk:
            return pr
    return None


def stack_has_unaccepted_upper_pr(stack: StackGroup, bottom: PrSnapshot | None) -> bool:
    return bool(bottom) and any(
        pr.state == "OPEN" and pr.number != bottom.number and "admin-bypass" not in pr.labels
        for pr in stack.prs
    )


def latest_repair_prereq_status(
    stack: StackGroup,
    ledger: Ledger,
    open_pr_numbers: Collection[int],
    trunk: str,
) -> RepairPrereqStatus | None:
    bottom = current_bottom_pr(stack, trunk)
    if not bottom:
        return None
    latest_row: dict[str, object] | None = None
    latest_epoch = float("-inf")
    for row in ledger.rows:
        if row.get("kind") != "repair-prereq-created":
            continue
        if int(row.get("pr", -1)) != bottom.number:
            continue
        if row.get("headSha") != bottom.head_ref_oid:
            continue
        epoch = int(row.get("epoch", 0) or 0)
        if latest_row is None or epoch >= latest_epoch:
            latest_row = row
            latest_epoch = epoch
    if latest_row is None:
        return None
    meta = latest_row.get("meta") if isinstance(latest_row.get("meta"), Mapping) else {}
    prereq_pr_number = int(meta.get("prNumber") or 0) if isinstance(meta, Mapping) else 0
    check_name = str(latest_row.get("key") or "")
    needs_followup_requeue = (
        bool(check_name)
        and ledger.latest("repair-prereq-requeue", bottom.number, bottom.head_ref_oid, check_name) is None
    )
    return RepairPrereqStatus(
        check_name=check_name,
        prereq_pr_number=prereq_pr_number,
        prereq_branch=str(meta.get("branch") or "") if isinstance(meta, Mapping) else "",
        is_open=prereq_pr_number in open_pr_numbers,
        needs_followup_requeue=needs_followup_requeue,
    )

def latest_queue_only_noop_check(stack: StackGroup, ledger: Ledger, trunk: str) -> str | None:
    bottom = current_bottom_pr(stack, trunk)
    if not bottom:
        return None
    latest = bottom.latest_mergify
    if (
        not latest
        or latest.state != "dequeued"
        or latest.queue_rule_name != "admin-bypass"
        or latest.head_sha != bottom.head_ref_oid
    ):
        return None
    latest_row: dict[str, object] | None = None
    latest_epoch = float("-inf")
    for row in ledger.rows:
        if row.get("kind") != "queue-only-noop":
            continue
        if int(row.get("pr", -1)) != bottom.number:
            continue
        if row.get("headSha") != bottom.head_ref_oid:
            continue
        epoch = int(row.get("epoch", 0) or 0)
        if latest_row is None or epoch >= latest_epoch:
            latest_row = row
            latest_epoch = epoch
    if latest_row is None:
        return None
    check_name = str(latest_row.get("key") or "")
    if (
        not check_name
        or not is_queue_only_required_check(check_name)
        or check_name not in latest.failing_checks
        or ledger.latest("queue-only-requeue", bottom.number, bottom.head_ref_oid, check_name) is not None
    ):
        return None
    return check_name


def summarize_stack(
    stack: StackGroup,
    required_checks: Collection[str],
    trunk: str,
    suppressed_failed_checks_by_pr: Mapping[int, Collection[str]] | None = None,
) -> dict[str, object]:
    suppressed_by_pr = suppressed_failed_checks_by_pr or {}
    blockers_by_pr = {
        pr.number: [
            {"kind": blocker.kind, "key": blocker.key, "detail": blocker.detail}
            for blocker in effective_blockers(pr, required_checks, trunk, suppressed_by_pr.get(pr.number, ()))
        ]
        for pr in stack.prs
    }
    bottom = current_bottom_pr(stack, trunk)
    upper_stack_needs_acceptance = stack_has_unaccepted_upper_pr(stack, bottom)
    return {
        "stack_id": stack.stack_id,
        "bottom_pr": bottom.number if bottom else None,
        "upper_stack_needs_acceptance": upper_stack_needs_acceptance,
        "prs": [
            {
                "number": pr.number,
                "state": pr.state,
                "base": pr.base_ref_name,
                "head": pr.head_ref_name,
                "head_sha": pr.head_ref_oid,
                "labels": sorted(pr.labels),
                "merge_state_status": pr.merge_state_status,
                "mergeable": pr.mergeable,
                "draft": pr.is_draft,
                "latest_mergify": None if not pr.latest_mergify else {
                    "state": pr.latest_mergify.state,
                    "head_sha": pr.latest_mergify.head_sha,
                    "comment_id": pr.latest_mergify.comment_id,
                    "failing_checks": list(pr.latest_mergify.failing_checks),
                    "waiting_for": list(pr.latest_mergify.waiting_for),
                },
                "blockers": blockers_by_pr[pr.number],
            }
            for pr in stack.prs
        ],
    }


def wait_reason_for_summary(summary: Mapping[str, object]) -> str:
    if summary.get("upper_stack_needs_acceptance"):
        return "upper-stack-needs-acceptance"
    bottom_pr = summary.get("bottom_pr")
    prs = summary.get("prs")
    if not isinstance(prs, list):
        return "no-action"
    for pr in prs:
        if not isinstance(pr, Mapping):
            continue
        latest = pr.get("latest_mergify")
        if pr.get("number") == bottom_pr and isinstance(latest, Mapping) and latest.get("state") in {"queued", "merging"}:
            return "bottom-already-queued"
        blockers = pr.get("blockers")
        if not isinstance(blockers, list):
            continue
        blocker_kinds = {str(blocker.get("kind")) for blocker in blockers if isinstance(blocker, Mapping)}
        if "pending_check" in blocker_kinds:
            return "pending-check"
        if "merge_hold" in blocker_kinds and len(blocker_kinds) == 1:
            return "merge-hold-only"
        if {"draft", "human_review_thread", "missing_check", "closed"} & blocker_kinds:
            return "blocked-needs-human"
    return "no-action"


def plan_stack_actions(
    stack: StackGroup,
    required_checks: Collection[str],
    ledger: Ledger,
    now_epoch: int,
    max_requeue_attempts: int = 2,
    max_repair_attempts: int = 3,
    suppressed_failed_checks_by_pr: Mapping[int, Collection[str]] | None = None,
) -> tuple[Action, ...]:
    suppressed_by_pr = suppressed_failed_checks_by_pr or {}
    bottom = current_bottom_pr(stack, TRUNK)
    upper_stack_needs_acceptance = stack_has_unaccepted_upper_pr(stack, bottom)
    blockers_by_pr = {
        pr.number: effective_blockers(pr, required_checks, TRUNK, suppressed_by_pr.get(pr.number, ()))
        for pr in stack.prs
    }
    all_blockers = [b for blockers in blockers_by_pr.values() for b in blockers]

    for pr in stack.prs:
        if upper_stack_needs_acceptance and bottom and pr.number == bottom.number:
            continue
        actions = mergify_failed_check_actions(pr, ledger, suppressed_by_pr.get(pr.number, ()))
        if actions:
            return actions

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "conflict":
                key = f"conflict:{pr.number}"
                if ledger.count("conflict-repair", pr.number, pr.head_ref_oid, key) >= max_repair_attempts:
                    return (cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_conflict", pr.number, key, blocker.detail),)
            if blocker.kind == "failed_check":
                if ledger.count("repair-check", pr.number, pr.head_ref_oid, blocker.key) >= max_repair_attempts:
                    return (cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_check", pr.number, blocker.key, blocker.detail),)

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "bot_review_thread":
                if ledger.has_different_head("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key):
                    return (Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail),)
                if ledger.count("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key) >= max_repair_attempts:
                    return (cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_check", pr.number, "bot_review_thread:" + blocker.key, blocker.detail),)

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "pending_check":
                return ()
            if blocker.kind in {"draft", "human_review_thread", "missing_check", "closed"}:
                return (Action("comment_blocked", pr.number, blocker.key, public_blocker_kind(blocker.kind)),)

    if not bottom:
        first = stack.prs[0]
        return (Action("comment_blocked", first.number, "no-current-bottom", "no current bottom on master"),)
    non_hold_blockers = [b for b in all_blockers if b.kind != "merge_hold"]
    hold_blockers = [b for b in all_blockers if b.kind == "merge_hold"]
    if hold_blockers and not non_hold_blockers:
        blocker = hold_blockers[0]
        pr = next(p for p in stack.prs if p.number == blocker.pr_number)
        if ledger.count("remove-merge-hold", pr.number, pr.head_ref_oid, "merge-hold") >= 1:
            return (cap_action(pr, blocker, blocker.detail),)
        return (Action("remove_merge_hold", pr.number, "merge-hold", blocker.detail),)
    if hold_blockers:
        return ()

    latest = bottom.latest_mergify
    queue_only_noop_check = latest_queue_only_noop_check(stack, ledger, TRUNK)
    if "admin-bypass" not in bottom.labels:
        if (
            queue_only_noop_check
            and latest
            and latest.queue_rule_name == "admin-bypass"
            and latest.state == "dequeued"
        ):
            return (
                Action(
                    "restore_admin_bypass_label",
                    bottom.number,
                    queue_only_noop_check,
                    "restore admin-bypass label after queue-only noop",
                ),
            )
        return (Action("comment_admin_bypass_nudge", bottom.number, "admin-bypass", "missing admin-bypass label"),)
    if upper_stack_needs_acceptance:
        return ()

    if latest and latest.head_sha == bottom.head_ref_oid and latest.state in {"queued", "merging"}:
        return ()
    requeue_reason = "eligible-when-ready"
    requeue_key = "ready"
    if latest and latest.state == "dequeued":
        requeue_reason = "eligible-after-dequeue"
        requeue_key = latest.comment_id or "manual"
    elif "dequeued" in bottom.labels:
        requeue_reason = "eligible-after-dequeued-label"
    attempts = ledger.count("requeue", bottom.number, bottom.head_ref_oid, requeue_key)
    if attempts >= max_requeue_attempts:
        return (cap_action(bottom, Blocker(requeue_key, "capped", bottom.number, "requeue"), "requeue"),)
    return (Action("requeue", bottom.number, requeue_key, requeue_reason),)


def plan_stack_execution(
    stack: StackGroup,
    required_checks: Collection[str],
    ledger: Ledger,
    now_epoch: int,
    open_pr_numbers: Collection[int],
    max_requeue_attempts: int = 2,
    max_repair_attempts: int = 3,
    trunk: str = TRUNK,
) -> StackExecutionPlan:
    del now_epoch
    prereq_status = latest_repair_prereq_status(stack, ledger, open_pr_numbers, trunk)
    suppressed_by_pr: Mapping[int, Collection[str]] | None = None
    queue_only_noop_check = latest_queue_only_noop_check(stack, ledger, trunk)
    if prereq_status and prereq_status.is_open:
        return StackExecutionPlan(
            summary=summarize_stack(stack, required_checks, trunk),
            actions=(),
            wait_reason="repair-prereq-open",
            prereq_status=prereq_status,
        )
    suppressed: dict[int, tuple[str, ...]] = {}
    bottom = current_bottom_pr(stack, trunk)
    if prereq_status and prereq_status.needs_followup_requeue and bottom:
        suppressed[bottom.number] = suppressed.get(bottom.number, ()) + (prereq_status.check_name,)
    if queue_only_noop_check and bottom:
        suppressed[bottom.number] = suppressed.get(bottom.number, ()) + (queue_only_noop_check,)
    if suppressed:
        suppressed_by_pr = suppressed
    summary = summarize_stack(stack, required_checks, trunk, suppressed_by_pr)
    actions = plan_stack_actions(
        stack,
        required_checks,
        ledger,
        0,
        max_requeue_attempts,
        max_repair_attempts,
        suppressed_by_pr,
    )
    if actions:
        return StackExecutionPlan(
            summary=summary,
            actions=actions,
            prereq_status=prereq_status,
        )
    return StackExecutionPlan(
        summary=summary,
        actions=(),
        wait_reason=wait_reason_for_summary(summary),
        prereq_status=prereq_status,
    )
