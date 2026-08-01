"""Pure policy for the PR duplicate/landed-close worker.

Every function here takes already-fetched state (CandidatePr, GitFacts,
patch-ids, Ledger) and returns CloseAction objects. No `gh`/`git` calls, no
mutation — this is what makes the classification cheap, deterministic, and
directly unit-testable (see scripts/test_pr_duplicate_close_plan.py).
"""

from __future__ import annotations

from typing import Mapping, Sequence

try:
    from .pr_duplicate_close_model import (
        CLOSE_DUPLICATE,
        CLOSE_LANDED,
        DUPLICATE_SAME_BRANCH,
        DUPLICATE_SAME_DIFF,
        LANDED_ANCESTOR,
        LANDED_EMPTY_DIFF,
        LANDED_PATCH_EQUIVALENT,
        LEDGER_KIND_SUBMIT,
        CandidatePr,
        CloseAction,
        DuplicateGroup,
        GitFacts,
        ledger_key,
    )
except ImportError:
    from pr_duplicate_close_model import (
        CLOSE_DUPLICATE,
        CLOSE_LANDED,
        DUPLICATE_SAME_BRANCH,
        DUPLICATE_SAME_DIFF,
        LANDED_ANCESTOR,
        LANDED_EMPTY_DIFF,
        LANDED_PATCH_EQUIVALENT,
        LEDGER_KIND_SUBMIT,
        CandidatePr,
        CloseAction,
        DuplicateGroup,
        GitFacts,
        ledger_key,
    )


def classify_landed(pr: CandidatePr, facts: GitFacts | None) -> CloseAction | None:
    if facts is None:
        return None
    signals: list[str] = []
    if facts.is_ancestor:
        signals.append(LANDED_ANCESTOR)
    if facts.is_empty_diff:
        signals.append(LANDED_EMPTY_DIFF)
    if facts.all_commits_equivalent:
        signals.append(LANDED_PATCH_EQUIVALENT)
    if not signals:
        return None
    evidence = f"content already on origin/master ({', '.join(signals)}; head {pr.head_ref_oid})"
    return CloseAction(
        kind=CLOSE_LANDED,
        pr_number=pr.number,
        expected_head_oid=pr.head_ref_oid,
        reason=signals[0],
        evidence=evidence,
    )


def group_duplicates(
    prs: Sequence[CandidatePr],
    patch_ids: Mapping[int, str | None],
) -> tuple[DuplicateGroup, ...]:
    groups: list[DuplicateGroup] = []
    covered: set[int] = set()

    by_branch: dict[str, list[int]] = {}
    for pr in prs:
        if not pr.head_ref_name:
            continue
        by_branch.setdefault(pr.head_ref_name, []).append(pr.number)
    for branch in sorted(by_branch):
        numbers = sorted(by_branch[branch])
        if len(numbers) < 2:
            continue
        groups.append(DuplicateGroup(
            reason=DUPLICATE_SAME_BRANCH,
            kept_pr_number=numbers[-1],
            closed_pr_numbers=tuple(numbers[:-1]),
        ))
        covered.update(numbers)

    by_patch: dict[str, list[int]] = {}
    for pr in prs:
        if pr.number in covered:
            continue
        patch_id = patch_ids.get(pr.number)
        if not patch_id:
            continue
        by_patch.setdefault(patch_id, []).append(pr.number)
    for patch_id in sorted(by_patch):
        numbers = sorted(by_patch[patch_id])
        if len(numbers) < 2:
            continue
        groups.append(DuplicateGroup(
            reason=DUPLICATE_SAME_DIFF,
            kept_pr_number=numbers[-1],
            closed_pr_numbers=tuple(numbers[:-1]),
        ))
        covered.update(numbers)

    return tuple(groups)


def _already_submitted(ledger, pr_number: int, head_oid: str, reason: str, kept_pr_number: int | None) -> bool:
    key = ledger_key(reason, kept_pr_number)
    return ledger.count(LEDGER_KIND_SUBMIT, pr_number, head_oid, key) > 0


def plan_close_actions(
    prs: Sequence[CandidatePr],
    facts_by_pr: Mapping[int, GitFacts],
    patch_ids: Mapping[int, str | None],
    ledger,
) -> tuple[CloseAction, ...]:
    actions: list[CloseAction] = []
    eligible = [pr for pr in prs if pr.state == "OPEN" and not pr.is_draft]

    landed_numbers: set[int] = set()
    for pr in eligible:
        action = classify_landed(pr, facts_by_pr.get(pr.number))
        if action is None:
            continue
        landed_numbers.add(pr.number)
        if _already_submitted(ledger, pr.number, pr.head_ref_oid, action.reason, None):
            continue
        actions.append(action)

    remaining = [pr for pr in eligible if pr.number not in landed_numbers]
    by_number = {pr.number: pr for pr in remaining}
    for group in group_duplicates(remaining, patch_ids):
        for closed_number in group.closed_pr_numbers:
            pr = by_number.get(closed_number)
            if pr is None:
                continue
            evidence = f"duplicate of open PR #{group.kept_pr_number} ({group.reason}; head {pr.head_ref_oid})"
            if _already_submitted(ledger, pr.number, pr.head_ref_oid, group.reason, group.kept_pr_number):
                continue
            actions.append(CloseAction(
                kind=CLOSE_DUPLICATE,
                pr_number=pr.number,
                expected_head_oid=pr.head_ref_oid,
                reason=group.reason,
                evidence=evidence,
                kept_pr_number=group.kept_pr_number,
            ))

    return tuple(actions)
