from __future__ import annotations

from typing import Collection

try:
    from .mergify_admin_requeue_model import Action, BOT_OR_SELF_AUTHORS, Blocker, Ledger, MergifyQueueEvent, PrSnapshot, StackGroup
except ImportError:
    from mergify_admin_requeue_model import Action, BOT_OR_SELF_AUTHORS, Blocker, Ledger, MergifyQueueEvent, PrSnapshot, StackGroup


TRUNK = "master"


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


def effective_blockers(pr: PrSnapshot, required_checks: Collection[str], trunk: str) -> tuple[Blocker, ...]:
    blockers = [b for b in classify_pr(pr, required_checks, trunk) if b.kind != "not_current_bottom"]
    latest = pr.latest_mergify
    if not latest or latest.head_sha != pr.head_ref_oid:
        return tuple(blockers)
    conditions = mergify_condition_map(latest)
    return tuple(
        blocker for blocker in blockers
        if not (blocker.kind == "missing_check" and conditions.get(blocker.key) == "success")
    )


def mergify_failed_check_actions(pr: PrSnapshot, ledger: Ledger) -> tuple[Action, ...]:
    latest = pr.latest_mergify
    if not latest or latest.state != "dequeued" or latest.head_sha != pr.head_ref_oid:
        return ()
    for name in latest.failing_checks:
        if ledger.count("repair-check", pr.number, pr.head_ref_oid, name) >= 3:
            return (cap_action(pr, Blocker(name, "failed_check", pr.number, f"Mergify queue check failed: {name}"), f"Mergify queue check failed: {name}"),)
        return (Action("repair_check", pr.number, name, f"Mergify queue check failed: {name}"),)
    return ()


def plan_stack_actions(stack: StackGroup, required_checks: Collection[str], ledger: Ledger, now_epoch: int) -> tuple[Action, ...]:
    del now_epoch
    blockers_by_pr = {pr.number: effective_blockers(pr, required_checks, TRUNK) for pr in stack.prs}
    all_blockers = [b for blockers in blockers_by_pr.values() for b in blockers]

    for pr in stack.prs:
        actions = mergify_failed_check_actions(pr, ledger)
        if actions:
            return actions

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "conflict":
                key = f"conflict:{pr.number}"
                if ledger.count("conflict-repair", pr.number, pr.head_ref_oid, key) >= 3:
                    return (cap_action(pr, blocker, blocker.detail),)
                return (Action("rebase_recreate", pr.number, key, blocker.detail),)
            if blocker.kind == "failed_check":
                if ledger.count("repair-check", pr.number, pr.head_ref_oid, blocker.key) >= 3:
                    return (cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_check", pr.number, blocker.key, blocker.detail),)

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "bot_review_thread":
                if ledger.has_different_head("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key):
                    return (Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail),)
                if ledger.count("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key) >= 3:
                    return (cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_check", pr.number, "bot_review_thread:" + blocker.key, blocker.detail),)

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "pending_check":
                return ()
            if blocker.kind in {"draft", "human_review_thread", "missing_check", "closed"}:
                return (Action("comment_blocked", pr.number, blocker.key, public_blocker_kind(blocker.kind)),)

    current_bottoms = [pr for pr in stack.prs if pr.state == "OPEN" and pr.base_ref_name == TRUNK]
    if not current_bottoms:
        first = stack.prs[0]
        return (Action("comment_blocked", first.number, "no-current-bottom", "no current bottom on master"),)
    bottom = current_bottoms[0]

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

    if "admin-bypass" not in bottom.labels:
        if ledger.count("add_admin_bypass_label", bottom.number, bottom.head_ref_oid, "admin-bypass") >= 1:
            return (cap_action(bottom, Blocker("admin-bypass", "capped", bottom.number, "admin-bypass label add"), "admin-bypass label add"),)
        return (Action("add_admin_bypass_label", bottom.number, "admin-bypass", "missing admin-bypass label"),)

    latest = bottom.latest_mergify
    requeue_reason = ""
    requeue_key = "manual"
    if latest and latest.state == "dequeued":
        requeue_reason = "eligible-after-dequeue"
        requeue_key = latest.comment_id or "manual"
    elif "dequeued" in bottom.labels:
        requeue_reason = "eligible-after-dequeued-label"
    if not requeue_reason:
        return ()
    if ledger.count("requeue", bottom.number, bottom.head_ref_oid, requeue_key) >= 2:
        return (cap_action(bottom, Blocker(requeue_key, "capped", bottom.number, "requeue"), "requeue"),)
    return (Action("requeue", bottom.number, requeue_key, requeue_reason),)
