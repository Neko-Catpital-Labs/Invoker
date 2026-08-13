from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Collection, Literal, Mapping

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

try:
    from .mergify_admin_requeue_async_repair import (
        repair_bot_thread_plan_name,
        repair_check_plan_name,
        repair_conflict_plan_name,
    )
    from .mergify_admin_requeue_infra_signal import (
        SSH_OAUTH_INFRA_SIGNATURE,
        repair_task_crashed_on_infra,
    )
except ImportError:
    from mergify_admin_requeue_async_repair import (
        repair_bot_thread_plan_name,
        repair_check_plan_name,
        repair_conflict_plan_name,
    )
    from mergify_admin_requeue_infra_signal import (
        SSH_OAUTH_INFRA_SIGNATURE,
        repair_task_crashed_on_infra,
    )


TRUNK = "master"

QUEUE_ONLY_REQUIRED_CHECK_PREFIXES = ("required-fast / ",)
ACTIVE_QUEUE_STATES = frozenset({"queued", "merging"})
STALE_QUEUE_EVENT_TTL_SECONDS = 5400
REFRESH_STALE_QUEUE_LEDGER_KIND = "refresh-stale-queue"
STALE_QUEUE_EVENT_REFRESH_KEY = "admin-bypass-current-head"

HUMAN_BLOCKER_KINDS = frozenset({"draft", "human_review_thread", "missing_check", "closed", "human_decision"})
TERMINAL_BLOCKER_KINDS = frozenset({"merged"})
REPAIR_INVALID_BLOCKER_KINDS = frozenset({"failed_check", "bot_review_thread", "conflict"})
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
class BottomTopology:
    kind: Literal["current_bottom", "external_open_base", "stale_unowned_base"]
    root: PrSnapshot
    bottom: PrSnapshot | None
    external_open_base_pr_numbers: tuple[int, ...]


@dataclass(frozen=True)
class StackFacts:
    stack: StackGroup
    required_checks: frozenset[str]
    trunk: str
    bottom_topology: BottomTopology
    bottom: PrSnapshot | None
    upper_stack_needs_acceptance: bool
    prereq_status: RepairPrereqStatus | None
    queue_only_noop_check: str | None
    suppressed_failed_checks_by_pr: Mapping[int, tuple[str, ...]]
    blockers_by_pr: Mapping[int, tuple[Blocker, ...]]
    all_blockers: tuple[Blocker, ...]
    stale_base_by_pr: Mapping[int, bool]


def is_queue_only_required_check(name: str) -> bool:
    # Both required-fast matrices in .github/workflows/ci.yml are gated to
    # merge-queue heads. Classify their shared emitted-name prefix instead of
    # duplicating individual matrix entries here, so promoting a new entry in
    # .mergify.yml cannot silently turn it into a missing PR-head check.
    return name.startswith(QUEUE_ONLY_REQUIRED_CHECK_PREFIXES)


def queue_event_queued_epoch(event: MergifyQueueEvent) -> int | None:
    if not event.queued_at:
        return None
    try:
        queued_at = datetime.fromisoformat(event.queued_at.replace("Z", "+00:00"))
    except ValueError:
        return None
    if queued_at.tzinfo is None:
        queued_at = queued_at.replace(tzinfo=timezone.utc)
    return int(queued_at.timestamp())


def queue_event_is_stale(event: MergifyQueueEvent, now: int) -> bool:
    queued_epoch = queue_event_queued_epoch(event)
    if queued_epoch is None:
        return False
    return now - queued_epoch >= STALE_QUEUE_EVENT_TTL_SECONDS


def has_stale_matching_head_queue_event(pr: PrSnapshot, now: int) -> bool:
    latest = pr.latest_mergify
    return bool(
        latest
        and latest.queue_rule_name == "admin-bypass"
        and latest.state in ACTIVE_QUEUE_STATES
        and latest.head_sha == pr.head_ref_oid
        and queue_event_is_stale(latest, now)
    )


def stale_matching_head_queue_event_detail(pr: PrSnapshot) -> str:
    latest = pr.latest_mergify
    if not latest:
        return "stale Mergify queue event on current head"
    queued_at = latest.queued_at or "unknown time"
    return (
        f"stale Mergify queue event stayed {latest.state} on admin-bypass "
        f"for current head since {queued_at}; force re-evaluation with @mergifyio refresh"
    )


def has_active_queue_event(pr: PrSnapshot, now: int) -> bool:
    latest = pr.latest_mergify
    if not latest:
        return False
    # A pending `queue` command reports state "waiting" with a null queue
    # rule while Mergify evaluates its conditions; requeueing on top of it is
    # a duplicate Mergify ignores but the retry-cap ledger still counts.
    if latest.state == "waiting":
        if latest.head_sha and latest.head_sha != pr.head_ref_oid:
            return "queued" in pr.labels
        return True
    if latest.queue_rule_name != "admin-bypass" or latest.state not in ACTIVE_QUEUE_STATES:
        return False
    if latest.head_sha == pr.head_ref_oid:
        return not queue_event_is_stale(latest, now)
    if not latest.head_sha:
        return True
    return "queued" in pr.labels


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


# Distinct from repair_in_flight's TTL-bounded "still might be running" check:
# once the submitted attempt's own Invoker workflow already shows the crash
# text below, there is nothing to wait out -- the coding agent never launched,
# so no further wait changes the outcome. Checked before repair_in_flight so a
# confirmed infra crash stops silently eating retry-cap attempts well before
# the TTL would otherwise expire. This module only adjusts what counts toward
# the cap; deciding what (if anything) to do about a crashed pool member is
# the autofix worker's job (packages/execution-engine/src/auto-fix-recovery.ts),
# not this Python-side admin-bypass planner's.
def repair_crash_reason(
    ledger: Ledger,
    pr_number: int,
    head_sha: str,
    submit_kind: str,
    key: str,
    plan_name: str,
) -> str | None:
    submitted = ledger.latest(submit_kind, pr_number, head_sha, key)
    if submitted is None:
        return None
    settled = ledger.latest(f"{submit_kind}-settled", pr_number, head_sha, key)
    if settled is not None and int(settled.get("epoch", 0) or 0) >= int(submitted.get("epoch", 0) or 0):
        return None
    # Named call (not a default-bound parameter) so tests can patch this
    # module's `repair_task_crashed_on_infra` name directly instead of the
    # real one, which shells out to a live Invoker instance.
    if repair_task_crashed_on_infra(plan_name):
        return SSH_OAUTH_INFRA_SIGNATURE
    return None


# The retry-cap count for (pr, head, submit_kind, key) minus one, when the
# most recent unsettled attempt crashed on the known SSH/OAuth infra
# signature -- that attempt never gave the coding agent a chance to touch the
# PR, so it should not spend budget a real attempt would have used. Returns
# the adjusted count and whether an infra crash was found (the caller skips
# the repair_in_flight TTL wait in that case, since there is nothing left to
# wait out).
def repair_attempt_count_excluding_infra_crash(
    ledger: Ledger,
    pr_number: int,
    head_sha: str,
    submit_kind: str,
    key: str,
    plan_name: str,
) -> tuple[int, bool]:
    count = ledger.count(submit_kind, pr_number, head_sha, key)
    crashed_on_infra = repair_crash_reason(ledger, pr_number, head_sha, submit_kind, key, plan_name) is not None
    if crashed_on_infra:
        count -= 1
    return count, crashed_on_infra


# An async repair submission (repairer.py's ledger.record(submit_kind, ...), written
# only after a successful `headless_mutation run` submission) is "in flight" until a
# same-kind "-settled" row lands with an equal-or-later epoch. The submitted plan's
# `normalize` task writes that settle row unconditionally as its first action, so
# reaching `normalize` at all -- pushed, no-op, prereq-created, or still-invalid --
# frees this PR/blocker for its next tick. Only a crash before `normalize` ever runs
# (the `repair` task itself dying) leaves no settle row; the TTL bounds that case so
# a single wedged attempt can't block this (pr, headSha, blockerKey) forever.
REPAIR_IN_FLIGHT_TTL_SECONDS = 5400


def repair_in_flight(
    ledger: Ledger,
    pr_number: int,
    head_sha: str,
    submit_kind: str,
    key: str,
    now: int,
    *,
    ttl_seconds: int = REPAIR_IN_FLIGHT_TTL_SECONDS,
) -> bool:
    submitted = ledger.latest(submit_kind, pr_number, head_sha, key)
    if submitted is None:
        return False
    submitted_epoch = int(submitted.get("epoch", 0) or 0)
    settled = ledger.latest(f"{submit_kind}-settled", pr_number, head_sha, key)
    if settled is not None and int(settled.get("epoch", 0) or 0) >= submitted_epoch:
        return False
    if now - submitted_epoch >= ttl_seconds:
        return False
    return True


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
        if not (b.kind == "failed_check" and b.key in suppressed)
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
    max_repair_attempts: int,
    now: int,
    suppressed_failed_checks: Collection[str] = (),
) -> tuple[Action, ...]:
    suppressed = set(suppressed_failed_checks)
    latest = pr.latest_mergify
    if not latest or latest.state != "dequeued" or latest.head_sha != pr.head_ref_oid:
        return ()
    for name in latest.failing_checks:
        if name in suppressed:
            continue
        detail = f"Mergify queue check failed: {name}"
        count, crashed_on_infra = repair_attempt_count_excluding_infra_crash(
            ledger, pr.number, pr.head_ref_oid, "repair-check", name,
            repair_check_plan_name(pr.number, name, pr.head_ref_oid),
        )
        if count >= max_repair_attempts:
            return (cap_action(pr, Blocker(name, "failed_check", pr.number, detail), detail),)
        if not crashed_on_infra and repair_in_flight(ledger, pr.number, pr.head_ref_oid, "repair-check", name, now):
            continue
        return (Action("repair_check", pr.number, name, detail),)
    return ()


def current_bottom_pr(stack: StackGroup, trunk: str) -> PrSnapshot | None:
    for pr in stack.prs:
        if pr.state == "OPEN" and pr.base_ref_name == trunk:
            return pr
    return None

def classify_bottom_topology(
    stack: StackGroup,
    trunk: str,
    open_pr_numbers_by_head: Mapping[str, Collection[int]],
) -> BottomTopology:
    root = stack.prs[0]
    bottom = current_bottom_pr(stack, trunk)
    if bottom is not None:
        return BottomTopology(
            kind="current_bottom",
            root=root,
            bottom=bottom,
            external_open_base_pr_numbers=(),
        )
    current_stack_numbers = {pr.number for pr in stack.prs}
    external_open_base_pr_numbers = tuple(sorted(
        number
        for number in open_pr_numbers_by_head.get(root.base_ref_name, ())
        if number not in current_stack_numbers
    ))
    if external_open_base_pr_numbers:
        return BottomTopology(
            kind="external_open_base",
            root=root,
            bottom=None,
            external_open_base_pr_numbers=external_open_base_pr_numbers,
        )
    return BottomTopology(
        kind="stale_unowned_base",
        root=root,
        bottom=None,
        external_open_base_pr_numbers=(),
    )




def unaccepted_upper_prs(stack: StackGroup, bottom: PrSnapshot | None) -> tuple[PrSnapshot, ...]:
    if not bottom:
        return ()
    return tuple(
        pr
        for pr in stack.prs
        if pr.state == "OPEN" and pr.number != bottom.number and "admin-bypass" not in pr.labels
    )


def stack_has_unaccepted_upper_pr(stack: StackGroup, bottom: PrSnapshot | None) -> bool:
    return bool(unaccepted_upper_prs(stack, bottom))


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


def repair_invalid_keys_for_blocker(pr: PrSnapshot, blocker: Blocker) -> tuple[str, ...]:
    if blocker.kind == "conflict":
        return ("conflict", f"conflict:{pr.number}")
    return (blocker.key,)


def latest_repair_invalid_blocker(pr: PrSnapshot, blocker: Blocker, ledger: Ledger) -> Blocker | None:
    if blocker.kind not in REPAIR_INVALID_BLOCKER_KINDS:
        return None
    latest = None
    for key in repair_invalid_keys_for_blocker(pr, blocker):
        row = ledger.latest("repair-invalid", pr.number, pr.head_ref_oid, key)
        if row is None:
            continue
        if latest is None or int(row.get("epoch", 0) or 0) >= int(latest.get("epoch", 0) or 0):
            latest = row
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
    assert facts.bottom is facts.bottom_topology.bottom, "bottom mirror must track bottom topology"
    assert (facts.bottom_topology.kind == "current_bottom") is (facts.bottom is not None), "current_bottom topology must match bottom presence"
    assert (facts.bottom_topology.kind != "current_bottom") is (facts.bottom is None), "non-current topology must match missing bottom"
    assert (facts.bottom_topology.kind == "external_open_base") is bool(facts.bottom_topology.external_open_base_pr_numbers), "external owners must only appear on external_open_base topology"
    assert (
        facts.bottom_topology.kind == "stale_unowned_base"
    ) is (
        facts.bottom is None and facts.bottom_topology.external_open_base_pr_numbers == ()
    ), "stale_unowned_base must mean no bottom and no external owners"
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
    open_pr_numbers_by_head: Mapping[str, Collection[int]],
    trunk: str,
    stale_base_by_pr: Mapping[int, bool] | None = None,
) -> StackFacts:
    required = frozenset(required_checks)
    bottom_topology = classify_bottom_topology(stack, trunk, open_pr_numbers_by_head)
    bottom = bottom_topology.bottom
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
            latest_repair_invalid_blocker(pr, blocker, ledger)
            or existing_split_stop_blocker(pr, blocker)
            or blocker
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
        bottom_topology=bottom_topology,
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
        stale_base_by_pr=dict(stale_base_by_pr or {}),
    )
    _assert_stack_facts_invariants(facts)
    return facts




def summarize_stack(facts: StackFacts) -> dict[str, object]:
    return {
        "stack_id": facts.stack.stack_id,
        "bottom_topology": facts.bottom_topology.kind,
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


def wait_reason_for_facts(facts: StackFacts, now: int) -> str:
    if facts.upper_stack_needs_acceptance:
        return "upper-stack-needs-acceptance"
    for pr in facts.stack.prs:
        blocker_kinds = {blocker.kind for blocker in facts.blockers_by_pr[pr.number]}
        if "pending_check" in blocker_kinds:
            return "pending-check"
        if "merge_hold" in blocker_kinds and len(blocker_kinds) == 1:
            return "merge-hold-only"
        if TERMINAL_BLOCKER_KINDS & blocker_kinds:
            return "terminal-merged"
        if HUMAN_BLOCKER_KINDS & blocker_kinds:
            return "blocked-needs-human"
    if facts.bottom and has_active_queue_event(facts.bottom, now):
        return "bottom-already-queued"
    return "no-action"


def _has_pending_or_human_blocker(facts: StackFacts) -> bool:
    return any(
        blocker.kind == "pending_check"
        or blocker.kind in HUMAN_BLOCKER_KINDS
        or blocker.kind in TERMINAL_BLOCKER_KINDS
        for blocker in facts.all_blockers
    )


def _bottom_has_pending_or_human_blocker(facts: StackFacts) -> bool:
    if not facts.bottom:
        return _has_pending_or_human_blocker(facts)
    return any(
        blocker.pr_number == facts.bottom.number
        and (
            blocker.kind == "pending_check"
            or blocker.kind in HUMAN_BLOCKER_KINDS
            or blocker.kind in TERMINAL_BLOCKER_KINDS
        )
        for blocker in facts.all_blockers
    )


# Kinds plan_direct_repairs/plan_bot_thread_repairs/mergify_failed_check_actions
# normally turn into a repair action. When the one blocking such a kind is
# in-flight, those planners skip it without producing an action -- correct for
# "don't resubmit," but the blocker is still real. Without this check, the
# ladder would fall through to plan_bottom_progress and requeue a PR whose
# required check is still actually failing, just because this tick didn't
# resubmit a repair for it.
REPAIRABLE_BLOCKER_KINDS = frozenset({"failed_check", "conflict", "bot_review_thread", "outdated_bot_review_thread"})


def _bottom_has_repairable_blocker(facts: StackFacts) -> bool:
    if not facts.bottom:
        return False
    return any(
        blocker.pr_number == facts.bottom.number and blocker.kind in REPAIRABLE_BLOCKER_KINDS
        for blocker in facts.all_blockers
    )


def _candidate_prs(facts: StackFacts, pr_numbers: Collection[int] | None = None) -> tuple[PrSnapshot, ...]:
    if pr_numbers is None:
        return facts.stack.prs
    allowed = frozenset(pr_numbers)
    return tuple(pr for pr in facts.stack.prs if pr.number in allowed)


def plan_mergify_queue_repairs(
    facts: StackFacts,
    ledger: Ledger,
    max_repair_attempts: int,
    now: int,
    pr_numbers: Collection[int] | None = None,
) -> Action | None:
    for pr in _candidate_prs(facts, pr_numbers):
        if any(blocker.kind == "human_decision" for blocker in facts.blockers_by_pr[pr.number]):
            continue
        if facts.upper_stack_needs_acceptance and facts.bottom and pr.number == facts.bottom.number:
            continue
        if facts.stale_base_by_pr.get(pr.number) and pr.latest_mergify and pr.latest_mergify.failing_checks:
            return plan_rebase_onto_base(
                pr, facts.trunk, ledger, max_repair_attempts,
                "structural stale base is blocking its failing check(s), not a code problem",
            )
        actions = mergify_failed_check_actions(
            pr, ledger, max_repair_attempts, now, facts.suppressed_failed_checks_by_pr.get(pr.number, ()),
        )
        if actions:
            return actions[0]
    return None


def plan_direct_repairs(
    facts: StackFacts,
    ledger: Ledger,
    max_repair_attempts: int,
    now: int,
    pr_numbers: Collection[int] | None = None,
) -> Action | None:
    for pr in _candidate_prs(facts, pr_numbers):
        if any(blocker.kind == "human_decision" for blocker in facts.blockers_by_pr[pr.number]):
            continue
        for blocker in facts.blockers_by_pr[pr.number]:
            if blocker.kind == "conflict":
                key = f"conflict:{pr.number}"
                count, crashed_on_infra = repair_attempt_count_excluding_infra_crash(
                    ledger, pr.number, pr.head_ref_oid, "conflict-repair", key,
                    repair_conflict_plan_name(pr.number, pr.head_ref_oid),
                )
                if count >= max_repair_attempts:
                    return cap_action(pr, blocker, blocker.detail)
                if not crashed_on_infra and repair_in_flight(ledger, pr.number, pr.head_ref_oid, "conflict-repair", key, now):
                    continue
                return Action("repair_conflict", pr.number, key, blocker.detail)
            if blocker.kind == "failed_check":
                if facts.stale_base_by_pr.get(pr.number):
                    return plan_rebase_onto_base(
                        pr, facts.trunk, ledger, max_repair_attempts,
                        "structural stale base is blocking its failing check(s), not a code problem",
                    )
                count, crashed_on_infra = repair_attempt_count_excluding_infra_crash(
                    ledger, pr.number, pr.head_ref_oid, "repair-check", blocker.key,
                    repair_check_plan_name(pr.number, blocker.key, pr.head_ref_oid),
                )
                if count >= max_repair_attempts:
                    return cap_action(pr, blocker, blocker.detail)
                if not crashed_on_infra and repair_in_flight(ledger, pr.number, pr.head_ref_oid, "repair-check", blocker.key, now):
                    continue
                return Action("repair_check", pr.number, blocker.key, blocker.detail)
    return None


def plan_bot_thread_repairs(
    facts: StackFacts,
    ledger: Ledger,
    max_repair_attempts: int,
    now: int,
    pr_numbers: Collection[int] | None = None,
) -> Action | None:
    for pr in _candidate_prs(facts, pr_numbers):
        if any(blocker.kind == "human_decision" for blocker in facts.blockers_by_pr[pr.number]):
            continue
        for blocker in facts.blockers_by_pr[pr.number]:
            if blocker.kind == "outdated_bot_review_thread":
                return Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail)
            if blocker.kind != "bot_review_thread":
                continue
            if ledger.has_different_head("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key):
                return Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail)
            count, crashed_on_infra = repair_attempt_count_excluding_infra_crash(
                ledger, pr.number, pr.head_ref_oid, "repair-bot-thread", blocker.key,
                repair_bot_thread_plan_name(pr.number, pr.head_ref_oid),
            )
            if count >= max_repair_attempts:
                return cap_action(pr, blocker, blocker.detail)
            if not crashed_on_infra and repair_in_flight(ledger, pr.number, pr.head_ref_oid, "repair-bot-thread", blocker.key, now):
                continue
            return Action("repair_check", pr.number, "bot_review_thread:" + blocker.key, blocker.detail)
    return None


def has_active_repair_for_current_blocker(facts: StackFacts, ledger: Ledger, now: int) -> bool:
    for pr in facts.stack.prs:
        latest = pr.latest_mergify
        if latest and latest.state == "dequeued" and latest.head_sha == pr.head_ref_oid:
            for check_name in latest.failing_checks:
                if repair_in_flight(ledger, pr.number, pr.head_ref_oid, "repair-check", check_name, now):
                    return True
        for blocker in facts.blockers_by_pr[pr.number]:
            if blocker.kind == "conflict":
                key = f"conflict:{pr.number}"
                if repair_in_flight(ledger, pr.number, pr.head_ref_oid, "conflict-repair", key, now):
                    return True
            elif blocker.kind == "failed_check":
                if repair_in_flight(ledger, pr.number, pr.head_ref_oid, "repair-check", blocker.key, now):
                    return True
            elif blocker.kind == "bot_review_thread":
                if repair_in_flight(ledger, pr.number, pr.head_ref_oid, "repair-bot-thread", blocker.key, now):
                    return True
    return False


def plan_hard_blockers(
    facts: StackFacts,
    ledger: Ledger,
    pr_numbers: Collection[int] | None = None,
) -> Action | None:
    for pr in _candidate_prs(facts, pr_numbers):
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


def plan_upper_stack_acceptance_blocker(facts: StackFacts, ledger: Ledger) -> Action | None:
    if not facts.upper_stack_needs_acceptance or not facts.bottom or facts.all_blockers:
        return None
    upper_prs = unaccepted_upper_prs(facts.stack, facts.bottom)
    if not upper_prs:
        return None
    key = "upper-stack-needs-acceptance"
    if ledger.count("comment-blocked", facts.bottom.number, facts.bottom.head_ref_oid, key) > 0:
        return None
    upper_list = ", ".join(f"#{pr.number}" for pr in upper_prs)
    return Action(
        "comment_blocked",
        facts.bottom.number,
        key,
        f"PR #{facts.bottom.number} is ready to land, but upper stack PR(s) {upper_list} are open without `admin-bypass`; a human must decide whether to include them in the admin-bypass landing stack or land them separately.",
    )


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


def plan_rebase_onto_base(pr: PrSnapshot, trunk: str, ledger: Ledger, max_attempts: int, reason: str) -> Action:
    rebase_attempts = ledger.count("rebase-onto-base-conflict", pr.number, pr.head_ref_oid, trunk)
    if rebase_attempts >= max_attempts:
        return cap_action(
            pr,
            Blocker("rebase-onto-base", "rebase_conflict", pr.number, "rebase onto base"),
            f"rebase onto `{trunk}` keeps hitting a real conflict; a human needs to rebase PR #{pr.number} manually",
        )
    return Action("rebase_onto_base", pr.number, trunk, f"rebase #{pr.number} onto `{trunk}`: {reason}")


def plan_bottom_progress(facts: StackFacts, ledger: Ledger, max_requeue_attempts: int, now: int) -> Action | None:
    if _bottom_has_pending_or_human_blocker(facts):
        return None
    if any(blocker.kind == "merge_hold" for blocker in facts.all_blockers):
        return None
    if not facts.bottom:
        if facts.bottom_topology.kind == "current_bottom":
            raise AssertionError("current_bottom topology reached no-bottom branch")
        root = facts.bottom_topology.root
        if facts.bottom_topology.kind == "external_open_base":
            owners = ", ".join(f"#{number}" for number in facts.bottom_topology.external_open_base_pr_numbers)
            return Action(
                "comment_blocked",
                root.number,
                "external-open-base-pr",
                f"lowest open stack PR #{root.number} is based on `{root.base_ref_name}`, which still belongs to open PR(s) {owners} outside this stack; leaving it alone to avoid dropping dependency changes",
            )
        return Action(
            "retarget_base",
            root.number,
            facts.trunk,
            f"retarget stack root from `{root.base_ref_name}` to `{facts.trunk}`",
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
    if has_active_queue_event(bottom, now):
        return None
    if has_stale_matching_head_queue_event(bottom, now):
        detail = stale_matching_head_queue_event_detail(bottom)
        attempts = ledger.count(
            REFRESH_STALE_QUEUE_LEDGER_KIND,
            bottom.number,
            bottom.head_ref_oid,
            STALE_QUEUE_EVENT_REFRESH_KEY,
        )
        if attempts >= max_requeue_attempts:
            return cap_action(
                bottom,
                Blocker(STALE_QUEUE_EVENT_REFRESH_KEY, "stale_queue_event", bottom.number, detail),
                detail,
            )
        return Action("refresh_stale_queue", bottom.number, STALE_QUEUE_EVENT_REFRESH_KEY, detail)
    if bottom.base_ref_name == facts.trunk and facts.stale_base_by_pr.get(bottom.number):
        return plan_rebase_onto_base(bottom, facts.trunk, ledger, max_requeue_attempts, "base pointer moved but content was never rebased")
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
    now: int,
) -> tuple[Action, ...]:
    if facts.bottom:
        bottom_pr_numbers = (facts.bottom.number,)
        action = plan_mergify_queue_repairs(facts, ledger, max_repair_attempts, now, bottom_pr_numbers)
        if action is not None:
            return (action,)
        action = plan_direct_repairs(facts, ledger, max_repair_attempts, now, bottom_pr_numbers)
        if action is not None:
            return (action,)
        action = plan_bot_thread_repairs(facts, ledger, max_repair_attempts, now, bottom_pr_numbers)
        if action is not None:
            return (action,)
        action = plan_hard_blockers(facts, ledger, bottom_pr_numbers)
        if action is not None:
            return (action,)
        if has_active_repair_for_current_blocker(facts, ledger, now):
            return ()
        if _bottom_has_pending_or_human_blocker(facts) or _bottom_has_repairable_blocker(facts):
            return ()
        action = plan_bottom_progress(facts, ledger, max_requeue_attempts, now)
        if action is not None:
            return (action,)
    action = plan_mergify_queue_repairs(facts, ledger, max_repair_attempts, now)
    if action is not None:
        return (action,)
    action = plan_direct_repairs(facts, ledger, max_repair_attempts, now)
    if action is not None:
        return (action,)
    action = plan_bot_thread_repairs(facts, ledger, max_repair_attempts, now)
    if action is not None:
        return (action,)
    if has_active_repair_for_current_blocker(facts, ledger, now):
        return ()
    action = plan_hard_blockers(facts, ledger)
    if action is not None:
        return (action,)
    action = plan_upper_stack_acceptance_blocker(facts, ledger)
    if action is not None:
        return (action,)
    action = plan_merge_hold_cleanup(facts, ledger)
    if action is not None:
        return (action,)
    action = plan_bottom_progress(facts, ledger, max_requeue_attempts, now)
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
    open_pr_numbers_by_head: Mapping[str, Collection[int]] | None = None,
) -> tuple[Action, ...]:
    del suppressed_failed_checks_by_pr
    facts = build_stack_facts(
        stack,
        required_checks,
        ledger,
        open_pr_numbers=(),
        open_pr_numbers_by_head=open_pr_numbers_by_head or {},
        trunk=TRUNK,
    )
    return plan_actions_from_facts(facts, ledger, max_requeue_attempts, max_repair_attempts, now_epoch)


def plan_stack_execution(
    stack: StackGroup,
    required_checks: Collection[str],
    ledger: Ledger,
    now_epoch: int,
    open_pr_numbers: Collection[int],
    open_pr_numbers_by_head: Mapping[str, Collection[int]],
    max_requeue_attempts: int = 2,
    max_repair_attempts: int = 3,
    trunk: str = TRUNK,
    stale_base_by_pr: Mapping[int, bool] | None = None,
) -> StackExecutionPlan:
    facts = build_stack_facts(stack, required_checks, ledger, open_pr_numbers, open_pr_numbers_by_head, trunk, stale_base_by_pr=stale_base_by_pr)
    summary = summarize_stack(facts)
    if facts.prereq_status and facts.prereq_status.is_open:
        return StackExecutionPlan(
            summary=summary,
            actions=(),
            wait_reason="repair-prereq-open",
            prereq_status=facts.prereq_status,
            queue_only_noop_check=facts.queue_only_noop_check,
        )
    actions = plan_actions_from_facts(facts, ledger, max_requeue_attempts, max_repair_attempts, now_epoch)
    if actions:
        return StackExecutionPlan(
            summary=summary,
            actions=actions,
            prereq_status=facts.prereq_status,
            queue_only_noop_check=facts.queue_only_noop_check,
        )
    wait_reason = "repair-in-flight" if has_active_repair_for_current_blocker(facts, ledger, now_epoch) else wait_reason_for_facts(facts, now_epoch)
    return StackExecutionPlan(
        summary=summary,
        actions=(),
        wait_reason=wait_reason,
        prereq_status=facts.prereq_status,
        queue_only_noop_check=facts.queue_only_noop_check,
    )
