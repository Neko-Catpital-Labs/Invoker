from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path
from typing import Sequence

try:
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Ledger
    from .mergify_admin_requeue_snapshot import GhClient
    from .pr_duplicate_close_executor import PrDuplicateCloseExecutor
    from .pr_duplicate_close_git_facts import GitFactsClient
    from .pr_duplicate_close_model import FLAG_DUPLICATE, CandidatePr, GitFacts
    from .pr_duplicate_close_plan import plan_close_actions, plan_flag_probable_duplicates
except ImportError:
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger
    from mergify_admin_requeue_snapshot import GhClient
    from pr_duplicate_close_executor import PrDuplicateCloseExecutor
    from pr_duplicate_close_git_facts import GitFactsClient
    from pr_duplicate_close_model import FLAG_DUPLICATE, CandidatePr, GitFacts
    from pr_duplicate_close_plan import plan_close_actions, plan_flag_probable_duplicates

REPO_ROOT = Path(__file__).resolve().parents[1]


def _candidate_from_raw(item: dict) -> CandidatePr:
    return CandidatePr(
        number=int(item.get("number") or 0),
        title=str(item.get("title") or ""),
        url=str(item.get("url") or ""),
        state=str(item.get("state") or ""),
        is_draft=bool(item.get("isDraft")),
        head_ref_name=str(item.get("headRefName") or ""),
        base_ref_name=str(item.get("baseRefName") or ""),
        head_ref_oid=str(item.get("headRefOid") or ""),
    )


def _compute_landed_facts(git_facts: GitFactsClient, head_sha: str) -> GitFacts:
    merge_base_sha = git_facts.merge_base("origin/master", head_sha)
    if merge_base_sha is None:
        return GitFacts(
            merge_base_sha=None, is_ancestor=False, is_empty_diff=False,
            all_commits_equivalent=False, is_rebase_equivalent=False, has_conflict=False,
        )
    return GitFacts(
        merge_base_sha=merge_base_sha,
        is_ancestor=git_facts.is_ancestor(head_sha),
        is_empty_diff=git_facts.is_empty_diff(head_sha),
        all_commits_equivalent=git_facts.all_commits_equivalent(head_sha),
        is_rebase_equivalent=git_facts.is_rebase_equivalent(head_sha),
        has_conflict=git_facts.has_conflict(head_sha),
    )


def _merged_pr_number_by_title(gh: GhClient, repo: str) -> dict[str, int]:
    merged_by_title: dict[str, int] = {}
    for item in gh.list_merged_prs(repo):
        title = str(item.get("title") or "")
        number = int(item.get("number") or 0)
        if not title or not number:
            continue
        # `gh pr list --state merged` is newest-first; keep the first (most
        # recent) match on a title collision among merged PRs themselves.
        merged_by_title.setdefault(title, number)
    return merged_by_title


def _compute_patch_id(git_facts: GitFactsClient, pr: CandidatePr) -> str | None:
    # Diff against the PR's own base, not always master: two duplicate PRs
    # can be based on different branches (one stacked on another open PR),
    # and diffing both against master would pull in whichever branch's own
    # unrelated changes, making a real duplicate's patch-id fail to match.
    upstream = f"origin/{pr.base_ref_name}" if pr.base_ref_name else "origin/master"
    merge_base_sha = git_facts.merge_base(upstream, pr.head_ref_oid)
    if merge_base_sha is None:
        return None
    return git_facts.patch_id(merge_base_sha, pr.head_ref_oid)


def print_action(action, dry_run: bool) -> None:
    prefix = "DRY-RUN " if dry_run else ""
    kept = f" kept=#{action.kept_pr_number}" if action.kept_pr_number is not None else ""
    verb = "flag" if action.kind == FLAG_DUPLICATE else "close"
    print(f"{prefix}{verb} PR #{action.pr_number} reason={action.reason}{kept} evidence={action.evidence}")


def run_cycle(args: argparse.Namespace) -> bool:
    logger = AdminBypassLogger()
    gh = GhClient()
    git_facts = GitFactsClient(cwd=args.git_cwd)
    ledger = Ledger(Path(args.state_file).expanduser())
    executor = PrDuplicateCloseExecutor(gh, ledger, logger, args.repo)

    logger.trace(
        "pr-duplicate-close-scan-start", repo=args.repo, author=args.author, dry_run=args.dry_run,
    )

    raw_prs = gh.list_open_prs(args.repo, args.author)
    prs = tuple(_candidate_from_raw(item) for item in raw_prs)
    if not prs:
        logger.trace("pr-duplicate-close-scan-empty")
        return False

    git_facts.fetch()

    eligible = [pr for pr in prs if pr.state == "OPEN" and not pr.is_draft and pr.head_ref_oid]
    eligible_bases = sorted({pr.base_ref_name for pr in eligible if pr.base_ref_name and pr.base_ref_name != "master"})
    for base in eligible_bases:
        try:
            git_facts.fetch(ref=base)
        except subprocess.CalledProcessError as exc:
            logger.trace(
                "pr-duplicate-close-base-fetch-failed", repo=args.repo, base_ref_name=base, error=str(exc),
            )

    facts_by_pr: dict[int, GitFacts] = {}
    patch_ids: dict[int, str | None] = {}
    for pr in eligible:
        facts_by_pr[pr.number] = _compute_landed_facts(git_facts, pr.head_ref_oid)
        patch_ids[pr.number] = _compute_patch_id(git_facts, pr)

    actions = plan_close_actions(prs, facts_by_pr, patch_ids, ledger)
    merged_by_title = _merged_pr_number_by_title(gh, args.repo)
    actions += plan_flag_probable_duplicates(prs, facts_by_pr, merged_by_title, ledger)
    logger.trace("pr-duplicate-close-scan-planned", repo=args.repo, action_count=len(actions))

    submitted = 0
    for action in actions:
        print_action(action, args.dry_run)
        if args.dry_run:
            continue
        if executor.execute(action):
            submitted += 1

    logger.trace("pr-duplicate-close-scan-complete", repo=args.repo, submitted=submitted, planned=len(actions))
    return False


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
    parser = argparse.ArgumentParser(description="Close PR_AUTHOR's open PRs that are already landed on master or duplicate an open PR.")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="Run one scan/action cycle and exit. Cron uses this.")
    mode.add_argument("--loop", action="store_true", help="Poll on an interval.")
    parser.add_argument("--poll-seconds", type=float, default=300, help="Seconds to wait between loop scans. Default: 300.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned closes; submit nothing.")
    parser.add_argument("--repo", default="Neko-Catpital-Labs/Invoker", help="Default: Neko-Catpital-Labs/Invoker.")
    parser.add_argument("--author", help="Limit scan to one author. Default: all authors.")
    parser.add_argument("--state-file", default=str(Path.home() / ".invoker" / "pr-duplicate-close-state.jsonl"), help="Ledger JSONL path.")
    parser.add_argument("--git-cwd", default=str(REPO_ROOT), help="Working directory for local git fact-checks. Default: this repo.")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    return run_loop(args) if args.loop else run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
