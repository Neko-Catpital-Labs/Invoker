from __future__ import annotations

from dataclasses import dataclass
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
ACTIVE_QUEUE_STATES = frozenset({"queued", "merging"})

HUMAN_BLOCKER_KINDS = frozenset({"draft", "human_review_thread", "missing_check", "closed", "human_decision"})
REPAIR_STOP_PREFIX = "Mergify repair stopped: "
MANUAL_SPLIT_STOP_MARKERS = (
    "human stack split required",
    "Split this into one Review Unit per PR.",
    "cannot auto-split",
    "cannot ship with tooling-policy, proof files",
    "cannot ship with policy, proof files",
    "cannot ship with proof files",
)


@dataclass(frozen=True)
class StackFacts:
    stack: StackGroup
    required_checks: frozenset[str]
    trunk: str
    bottom: PrSnapshot | None
    upper_stack_needs_acceptance: bool
    prereq_status: RepairPrereqStatus | None
    queue_only_noop_check: str | None
    suppressed_failed_checks_by_pr: Mapping[int, tuple[str, ...]]
    blockers_by_pr: Mapping[int, tuple[Blocker, ...]]
    all_blockers: tuple[Blocker, ...]


def is_queue_only_required_check(name: str) -> bool:
    # .github/workflows/ci.yml:306-328 gates these required-fast matrix jobs to
    # merge-queue heads, so they do not exist on ordinary PR heads.
    return name in QUEUE_ONLY_REQUIRED_CHECKS


def classify_pr(pr: PrSnapshot, required_checks: Collection[str], trunk: str) -> tuple[Blocker, ...]:
    blockers: list[Blocker] = []
    if pr.state == "MERGED":
        blockers.append(Blocker("merged", "merged", pr.number, "state=MERGED"))
        return tuple(blockers)
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
        elif thread.is_outdated:
            blockers.append(Blocker(thread.id, "outdated_bot_review_thread", pr.number, f"unresolved outdated bot review thread {thread.id}"))
        else:
            blockers.append(Blocker(thread.id, "bot_review_thread", pr.number, f"unresolved bot review thread {thread.id}"))

    if pr.merge_state_status == "DIRTY" or pr.mergeable == "CONFLICTING":
        blockers.append(Blocker("conflict", "conflict", pr.number, "GitHub reports merge conflict"))

    for name in sorted(required_checks):
        ctx = pr.checks.get(name)
        if ctx is None:
            if pr.base_ref_name == trunk and not is_queue_only_required_check(name):
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


def latest_repair_invalid_blocker(pr: PrSnapshot, blocker: Blocker, ledger: Ledger) -> Blocker | None:
    latest = ledger.latest("repair-invalid", pr.number, pr.head_ref_oid, blocker.key)
    if latest is None:
        return None
    meta = latest.get("meta") if isinstance(latest.get("meta"), Mapping) else {}
    errors = meta.get("errors") if isinstance(meta, Mapping) else None
    if isinstance(errors, list):
        detail = "\n".join(str(error) for error in errors if str(error))
        if detail:
            return Blocker(blocker.key, "human_decision", pr.number, detail)
    return Blocker(blocker.key, "human_decision", pr.number, blocker.detail)


def existing_split_stop_blocker(pr: PrSnapshot, blocker: Blocker) -> Blocker | None:
    if blocker.kind != "failed_check":
        return None
    ctx = pr.checks.get(blocker.key)
    completed_at = ctx.completed_at if ctx else ""
    for comment in pr.repair_stop_comments:
        body = comment.body.strip()
        if not body.startswith(REPAIR_STOP_PREFIX):
            continue
        detail = body[len(REPAIR_STOP_PREFIX):].strip()
        if not detail or not any(marker in detail for marker in MANUAL_SPLIT_STOP_MARKERS):
            continue
        if completed_at and comment.updated_at and comment.updated_at < completed_at:
            continue
        return Blocker(blocker.key, "human_decision", pr.number, detail)
    return None


def has_exact_repair_stop_comment(pr: PrSnapshot, detail: str) -> bool:
    expected = f"{REPAIR_STOP_PREFIX}{detail}".strip()
    return any(comment.body.strip() == expected for comment in pr.repair_stop_comments)


def latest_mergify_repair_invalid_blockers(
    pr: PrSnapshot,
    ledger: Ledger,
    suppressed_failed_checks: Collection[str],
) -> tuple[Blocker, ...]:
    latest = pr.latest_mergify
    if not latest or latest.state != "dequeued" or latest.head_sha != pr.head_ref_oid:
        return ()
    suppressed = set(suppressed_failed_checks)
    blockers: list[Blocker] = []
    for name in latest.failing_checks:
        if name in suppressed:
            continue
        blocker = latest_repair_invalid_blocker(
            pr,
            Blocker(name, "failed_check", pr.number, f"Mergify queue check failed: {name}"),
            ledger,
        )
        if blocker is not None:
            blockers.append(blocker)
    return tuple(blockers)


def _assert_stack_facts_invariants(facts: StackFacts) -> None:
    assert facts.stack.prs, "stack must contain at least one PR"
    pr_numbers = tuple(pr.number for pr in facts.stack.prs)
    assert len(pr_numbers) == len(set(pr_numbers)), "stack PR numbers must be unique"
    assert set(facts.blockers_by_pr) == set(pr_numbers), "every PR must have blocker facts"
    expected_all = tuple(
        blocker
        for pr in facts.stack.prs
        for blocker in facts.blockers_by_pr[pr.number]
    )
    assert facts.all_blockers == expected_all, "all_blockers must flatten blockers_by_pr in stack order"
    if facts.suppressed_failed_checks_by_pr:
        assert facts.bottom is not None, "suppression requires a current bottom PR"
        assert set(facts.suppressed_failed_checks_by_pr) == {facts.bottom.number}, "derived suppression is bottom-only"
    if facts.prereq_status is not None:
        assert facts.bottom is not None, "prerequisite status requires a current bottom PR"
    if facts.queue_only_noop_check is not None:
        assert facts.bottom is not None, "queue-only noop requires a current bottom PR"
        latest = facts.bottom.latest_mergify
        assert latest is not None, "queue-only noop requires a Mergify event"
        assert latest.state == "dequeued", "queue-only noop requires a dequeued Mergify event"
        assert latest.queue_rule_name == "admin-bypass", "queue-only noop requires the admin-bypass queue"
        assert latest.head_sha == facts.bottom.head_ref_oid, "queue-only noop requires a same-head Mergify event"
        assert facts.queue_only_noop_check in latest.failing_checks, "queue-only noop check must still be failing in Mergify"


def build_stack_facts(
    stack: StackGroup,
    required_checks: Collection[str],
    ledger: Ledger,
    open_pr_numbers: Collection[int],
    trunk: str,
) -> StackFacts:
    required = frozenset(required_checks)
    bottom = current_bottom_pr(stack, trunk)
    upper_stack_needs_acceptance = stack_has_unaccepted_upper_pr(stack, bottom)
    prereq_status = latest_repair_prereq_status(stack, ledger, open_pr_numbers, trunk)
    queue_only_noop_check = latest_queue_only_noop_check(stack, ledger, trunk)

    suppressed_failed_checks_by_pr: dict[int, tuple[str, ...]] = {}
    if prereq_status and prereq_status.needs_followup_requeue and bottom:
        suppressed_failed_checks_by_pr[bottom.number] = suppressed_failed_checks_by_pr.get(bottom.number, ()) + (prereq_status.check_name,)
    if queue_only_noop_check and bottom:
        suppressed_failed_checks_by_pr[bottom.number] = suppressed_failed_checks_by_pr.get(bottom.number, ()) + (queue_only_noop_check,)
    if (
        bottom
        and "PR Body" in required
        and ledger.latest("repair-noop", bottom.number, bottom.head_ref_oid, "PR Body") is not None
    ):
        suppressed_failed_checks_by_pr[bottom.number] = suppressed_failed_checks_by_pr.get(bottom.number, ()) + ("PR Body",)

    blockers_by_pr: dict[int, tuple[Blocker, ...]] = {}
    for pr in stack.prs:
        effective = effective_blockers(pr, required, trunk, suppressed_failed_checks_by_pr.get(pr.number, ()))
        blockers = [
            latest_repair_invalid_blocker(pr, blocker, ledger) or existing_split_stop_blocker(pr, blocker) or blocker
            for blocker in effective
        ]
        existing_keys = {blocker.key for blocker in blockers}
        blockers.extend(
            blocker for blocker in latest_mergify_repair_invalid_blockers(
                pr,
                ledger,
                suppressed_failed_checks_by_pr.get(pr.number, ()),
            )
            if blocker.key not in existing_keys
        )
        blockers_by_pr[pr.number] = tuple(blockers)
    facts = StackFacts(
        stack=stack,
        required_checks=required,
        trunk=trunk,
        bottom=bottom,
        upper_stack_needs_acceptance=upper_stack_needs_acceptance,
        prereq_status=prereq_status,
        queue_only_noop_check=queue_only_noop_check,
        suppressed_failed_checks_by_pr=suppressed_failed_checks_by_pr,
        blockers_by_pr=blockers_by_pr,
        all_blockers=tuple(
            blocker
            for pr in stack.prs
            for blocker in blockers_by_pr[pr.number]
        ),
    )
    _assert_stack_facts_invariants(facts)
    return facts




def summarize_stack(facts: StackFacts) -> dict[str, object]:
    return {
        "stack_id": facts.stack.stack_id,
        "bottom_pr": facts.bottom.number if facts.bottom else None,
        "upper_stack_needs_acceptance": facts.upper_stack_needs_acceptance,
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
                "blockers": [
                    {"kind": blocker.kind, "key": blocker.key, "detail": blocker.detail}
                    for blocker in facts.blockers_by_pr[pr.number]
                ],
            }
            for pr in facts.stack.prs
        ],
    }


def wait_reason_for_facts(facts: StackFacts) -> str:
    if facts.upper_stack_needs_acceptance:
        return "upper-stack-needs-acceptance"
    if facts.bottom and facts.bottom.latest_mergify and facts.bottom.latest_mergify.state in {"queued", "merging"}:
        return "bottom-already-queued"
    for pr in facts.stack.prs:
        blocker_kinds = {blocker.kind for blocker in facts.blockers_by_pr[pr.number]}
        if "pending_check" in blocker_kinds:
            return "pending-check"
        if "merge_hold" in blocker_kinds and len(blocker_kinds) == 1:
            return "merge-hold-only"
        if HUMAN_BLOCKER_KINDS & blocker_kinds:
            return "blocked-needs-human"
    return "no-action"


def _has_pending_or_human_blocker(facts: StackFacts) -> bool:
    return any(blocker.kind == "pending_check" or blocker.kind in HUMAN_BLOCKER_KINDS for blocker in facts.all_blockers)


def _bottom_has_pending_or_human_blocker(facts: StackFacts) -> bool:
    if not facts.bottom:
        return _has_pending_or_human_blocker(facts)
    return any(
        blocker.pr_number == facts.bottom.number
        and (blocker.kind == "pending_check" or blocker.kind in HUMAN_BLOCKER_KINDS)
        for blocker in facts.all_blockers
    )


def _pr_has_human_decision(facts: StackFacts, pr_number: int) -> bool:
    return any(blocker.kind == "human_decision" for blocker in facts.blockers_by_pr[pr_number])


def plan_mergify_queue_repairs(facts: StackFacts, ledger: Ledger, max_repair_attempts: int) -> Action | None:
    del max_repair_attempts
    for pr in facts.stack.prs:
        if _pr_has_human_decision(facts, pr.number):
            continue
        if facts.upper_stack_needs_acceptance and facts.bottom and pr.number == facts.bottom.number:
            continue
        actions = mergify_failed_check_actions(pr, ledger, facts.suppressed_failed_checks_by_pr.get(pr.number, ()))
        if actions:
            return actions[0]
    return None


def plan_direct_repairs(facts: StackFacts, ledger: Ledger, max_repair_attempts: int) -> Action | None:
    for pr in facts.stack.prs:
        if _pr_has_human_decision(facts, pr.number):
            continue
        for blocker in facts.blockers_by_pr[pr.number]:
            if blocker.kind == "conflict":
                key = f"conflict:{pr.number}"
                if ledger.count("conflict-repair", pr.number, pr.head_ref_oid, key) >= max_repair_attempts:
                    return cap_action(pr, blocker, blocker.detail)
                return Action("repair_conflict", pr.number, key, blocker.detail)
            if blocker.kind == "failed_check":
                attempts = ledger.count("repair-check", pr.number, pr.head_ref_oid, blocker.key)
                if attempts >= max_repair_attempts and ledger.latest("repair-evaluated", pr.number, pr.head_ref_oid, blocker.key) is not None:
                    return cap_action(pr, blocker, blocker.detail)
                return Action("repair_check", pr.number, blocker.key, blocker.detail)
    return None


def plan_bot_thread_repairs(facts: StackFacts, ledger: Ledger, max_repair_attempts: int) -> Action | None:
    for pr in facts.stack.prs:
        if _pr_has_human_decision(facts, pr.number):
            continue
        for blocker in facts.blockers_by_pr[pr.number]:
            if blocker.kind == "outdated_bot_review_thread":
                return Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail)
            if blocker.kind != "bot_review_thread":
                continue
            if ledger.has_different_head("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key):
                return Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail)
            if ledger.count("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key) >= max_repair_attempts:
                return cap_action(pr, blocker, blocker.detail)
            return Action("repair_check", pr.number, "bot_review_thread:" + blocker.key, blocker.detail)
    return None


def plan_hard_blockers(facts: StackFacts, ledger: Ledger) -> Action | None:
    for pr in facts.stack.prs:
        if _pr_has_human_decision(facts, pr.number):
            continue
        for blocker in facts.blockers_by_pr[pr.number]:
            if blocker.kind == "pending_check":
                return None
            if blocker.kind == "human_decision":
                return None
            if blocker.kind in HUMAN_BLOCKER_KINDS:
                if ledger.count("comment-blocked", pr.number, pr.head_ref_oid, blocker.key) > 0:
                    return None
                return Action("comment_blocked", pr.number, blocker.key, blocker.detail)
    return None


def plan_merge_hold_cleanup(facts: StackFacts, ledger: Ledger) -> Action | None:
    if _has_pending_or_human_blocker(facts) or not facts.bottom:
        return None
    non_hold_blockers = [blocker for blocker in facts.all_blockers if blocker.kind != "merge_hold"]
    hold_blockers = [blocker for blocker in facts.all_blockers if blocker.kind == "merge_hold"]
    if hold_blockers and not non_hold_blockers:
        blocker = hold_blockers[0]
        pr = next(pr for pr in facts.stack.prs if pr.number == blocker.pr_number)
        if ledger.count("remove-merge-hold", pr.number, pr.head_ref_oid, "merge-hold") >= 1:
            return cap_action(pr, blocker, blocker.detail)
        return Action("remove_merge_hold", pr.number, "merge-hold", blocker.detail)
    return None


def plan_bottom_progress(facts: StackFacts, ledger: Ledger, max_requeue_attempts: int) -> Action | None:
    if _bottom_has_pending_or_human_blocker(facts):
        return None
    if any(blocker.kind == "merge_hold" for blocker in facts.all_blockers):
        return None
    if not facts.bottom:
        first = next((pr for pr in facts.stack.prs if pr.state == "OPEN"), None)
        if first is None:
            return None
        detail = (
            f"no current bottom on {facts.trunk}: lowest open stack PR #{first.number} "
            f"is based on `{first.base_ref_name}`, not `{facts.trunk}`; land or retarget "
            "that base before babysitting can queue this stack"
        )
        if has_exact_repair_stop_comment(first, detail):
            return None
        return Action(
            "comment_blocked",
            first.number,
            "no-current-bottom",
            detail,
        )

    bottom = facts.bottom
    latest = bottom.latest_mergify
    if "admin-bypass" not in bottom.labels:
        if (
            facts.queue_only_noop_check
            and latest
            and latest.queue_rule_name == "admin-bypass"
            and latest.state == "dequeued"
        ):
            return Action(
                "restore_admin_bypass_label",
                bottom.number,
                facts.queue_only_noop_check,
                "restore admin-bypass label after queue-only noop",
            )
        return Action("comment_admin_bypass_nudge", bottom.number, "admin-bypass", "missing admin-bypass label")
    if facts.upper_stack_needs_acceptance:
        return None
    if latest and latest.state in ACTIVE_QUEUE_STATES and (latest.head_sha == bottom.head_ref_oid or "queued" in bottom.labels):
        return None
    requeue_reason = "eligible-when-ready"
    requeue_key = "ready"
    if latest and latest.state == "dequeued":
        requeue_reason = "eligible-after-dequeue"
        requeue_key = latest.comment_id or "manual"
    elif "dequeued" in bottom.labels:
        requeue_reason = "eligible-after-dequeued-label"
    attempts = ledger.count("requeue", bottom.number, bottom.head_ref_oid, requeue_key)
    if attempts >= max_requeue_attempts:
        return cap_action(bottom, Blocker(requeue_key, "capped", bottom.number, "requeue"), "requeue")
    return Action("requeue", bottom.number, requeue_key, requeue_reason)


def plan_actions_from_facts(
    facts: StackFacts,
    ledger: Ledger,
    max_requeue_attempts: int,
    max_repair_attempts: int,
) -> tuple[Action, ...]:
    action = plan_mergify_queue_repairs(facts, ledger, max_repair_attempts)
    if action is not None:
        return (action,)
    action = plan_direct_repairs(facts, ledger, max_repair_attempts)
    if action is not None:
        return (action,)
    action = plan_bot_thread_repairs(facts, ledger, max_repair_attempts)
    if action is not None:
        return (action,)
    action = plan_hard_blockers(facts, ledger)
    if action is not None:
        return (action,)
    action = plan_merge_hold_cleanup(facts, ledger)
    if action is not None:
        return (action,)
    action = plan_bottom_progress(facts, ledger, max_requeue_attempts)
    if action is not None:
        return (action,)
    return ()


def plan_stack_actions(
    stack: StackGroup,
    required_checks: Collection[str],
    ledger: Ledger,
    now_epoch: int,
    max_requeue_attempts: int = 2,
    max_repair_attempts: int = 3,
    suppressed_failed_checks_by_pr: Mapping[int, Collection[str]] | None = None,
) -> tuple[Action, ...]:
    del now_epoch
    del suppressed_failed_checks_by_pr
    facts = build_stack_facts(stack, required_checks, ledger, open_pr_numbers=(), trunk=TRUNK)
    return plan_actions_from_facts(facts, ledger, max_requeue_attempts, max_repair_attempts)


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
    facts = build_stack_facts(stack, required_checks, ledger, open_pr_numbers, trunk)
    summary = summarize_stack(facts)
    if facts.prereq_status and facts.prereq_status.is_open:
        return StackExecutionPlan(
            summary=summary,
            actions=(),
            wait_reason="repair-prereq-open",
            prereq_status=facts.prereq_status,
            queue_only_noop_check=facts.queue_only_noop_check,
        )
    actions = plan_actions_from_facts(facts, ledger, max_requeue_attempts, max_repair_attempts)
    if actions:
        return StackExecutionPlan(
            summary=summary,
            actions=actions,
            prereq_status=facts.prereq_status,
            queue_only_noop_check=facts.queue_only_noop_check,
        )
    return StackExecutionPlan(
        summary=summary,
        actions=(),
        wait_reason=wait_reason_for_facts(facts),
        prereq_status=facts.prereq_status,
        queue_only_noop_check=facts.queue_only_noop_check,
    )
