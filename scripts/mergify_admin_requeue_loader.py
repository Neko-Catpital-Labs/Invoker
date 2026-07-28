from __future__ import annotations

from typing import Mapping, Sequence

try:
    from .mergify_admin_requeue_model import LoadedStacks, StackGroup
    from .mergify_admin_requeue_snapshot import GhClient, group_stack_prs, parse_stack_metadata, snapshot_from_detail
except ImportError:
    from mergify_admin_requeue_model import LoadedStacks, StackGroup
    from mergify_admin_requeue_snapshot import GhClient, group_stack_prs, parse_stack_metadata, snapshot_from_detail


class AdminBypassStackLoader:
    def __init__(self, gh: GhClient):
        self.gh = gh

    def load(
        self,
        repo: str,
        author: str | None,
        pr_numbers: Sequence[int],
        required_checks: Sequence[str],
        trunk: str,
    ) -> LoadedStacks:
        candidates = self.gh.list_candidate_prs(repo, author, pr_numbers)
        candidate_numbers = {int(pr.get("number") or 0) for pr in candidates}
        if not candidate_numbers:
            return LoadedStacks(stacks=(), open_pr_numbers_by_head={})

        raw_by_number = {
            int(pr.get("number") or 0): pr
            for pr in self.gh.list_open_prs(repo)
        }
        raw_by_number.update({int(pr.get("number") or 0): pr for pr in candidates})
        open_pr_numbers_by_head: dict[str, list[int]] = {}
        for raw in raw_by_number.values():
            if str(raw.get("state") or "").upper() != "OPEN":
                continue
            head_ref_name = str(raw.get("headRefName") or "")
            number = int(raw.get("number") or 0)
            if head_ref_name and number:
                open_pr_numbers_by_head.setdefault(head_ref_name, []).append(number)


        comments_cache: dict[int, list[dict]] = {}

        def comments_for(number: int) -> list[dict]:
            if number not in comments_cache:
                comments_cache[number] = self.gh.issue_comments(repo, number)
            return comments_cache[number]

        lite_snapshots = [snapshot_from_detail(raw, [], required_checks) for raw in raw_by_number.values()]
        lite_metadata: dict[int, tuple[str, tuple[int, ...]]] = {}
        for number in candidate_numbers:
            meta = parse_stack_metadata(comments_for(number))
            if not meta:
                continue
            for pr_number in meta[1]:
                lite_metadata[pr_number] = meta
            lite_metadata[number] = meta

        relevant_numbers: set[int] = set()
        for stack in group_stack_prs(lite_snapshots, lite_metadata, trunk):
            if any(pr.number in candidate_numbers for pr in stack.prs):
                relevant_numbers.update(pr.number for pr in stack.prs)

        details: list[tuple[Mapping[str, object], list[dict]]] = []
        for number in sorted(relevant_numbers):
            raw = raw_by_number.get(number)
            detail = raw if raw is not None and "reviewThreads" in raw else self.gh.pr_detail(repo, number)
            details.append((detail, comments_for(number)))

        snapshots = [snapshot_from_detail(detail, comments, required_checks) for detail, comments in details]
        metadata: dict[int, tuple[str, tuple[int, ...]]] = {}
        for detail, comments in details:
            number = int(detail.get("number") or 0)
            meta = parse_stack_metadata(comments)
            if not meta:
                continue
            for pr_number in meta[1]:
                metadata[pr_number] = meta
            metadata[number] = meta

        return LoadedStacks(
            stacks=tuple(
                stack
                for stack in group_stack_prs(snapshots, metadata, trunk)
                if any(pr.number in candidate_numbers for pr in stack.prs)
            ),
            open_pr_numbers_by_head={
                head_ref_name: tuple(sorted(numbers))
                for head_ref_name, numbers in open_pr_numbers_by_head.items()
            },
        )
