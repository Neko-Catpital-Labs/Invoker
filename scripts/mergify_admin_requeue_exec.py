from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import Mapping, Sequence
try:
    from .mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, MergifyQueueEvent, PrSnapshot, StackGroup, load_mergify_rules
    from .mergify_admin_requeue_plan import plan_stack_actions
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, group_stack_prs, parse_stack_metadata, snapshot_from_detail
except ImportError:
    from mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, MergifyQueueEvent, PrSnapshot, StackGroup, load_mergify_rules
    from mergify_admin_requeue_plan import plan_stack_actions
    from mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, group_stack_prs, parse_stack_metadata, snapshot_from_detail

REPO_ROOT = Path(__file__).resolve().parents[1]
ADMIN_BYPASS_NUDGE_LEDGER_KIND = "comment-admin-bypass-nudge"


def admin_bypass_nudge_body() -> str:
    return (
        "Invoker Mergify babysitting is paused: this is the current bottom PR in the stack, "
        "but it is missing the `admin-bypass` label. Please tag this PR with `admin-bypass` "
        "before babysitting can continue."
    )


def github_job_log(repo: str, details_url: str, pr_number: int, check_name: str) -> str:
    match = GH_ACTIONS_JOB_RE.search(details_url)
    if not match:
        return ""
    tmp = Path(tempfile.mkdtemp(prefix=f"mergify-admin-requeue-{pr_number}-"))
    path = tmp / (re.sub(r"[^A-Za-z0-9_.-]+", "-", check_name).strip("-") + ".log")
    out = subprocess.run(["gh", "run", "view", "--repo", repo, "--job", match.group(1), "--log"], check=True, text=True, capture_output=True).stdout
    path.write_text(out, encoding="utf-8")
    return str(path)


def mergify_check_urls(event: MergifyQueueEvent | None, check_name: str) -> tuple[str, ...]:
    if not event:
        return ()
    for name, urls in event.failing_check_urls:
        if name == check_name:
            return urls
    return ()


def run_claude_repair(work_root: Path, prompt: str) -> None:
    subprocess.run(
        ["claude", "-p", prompt, "--dangerously-skip-permissions"],
        cwd=str(work_root),
        check=True,
        text=True,
    )


def repair_check(repo: str, pr: PrSnapshot, check_name: str) -> None:
    ctx = pr.checks.get(check_name)
    mergify_urls = mergify_check_urls(pr.latest_mergify, check_name)
    details_url = (ctx.details_url if ctx and ctx.details_url else "") or (mergify_urls[0] if mergify_urls else "")
    log_path = github_job_log(repo, details_url, pr.number, check_name) if details_url else ""
    work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    checkout_pr_head(repo, pr, work_root)
    latest = pr.latest_mergify
    prompt = (
        f"Fix only the failing check. Add or update a repro if the failure is reproducible. "
        f"Commit and push to the PR head branch. If local proof shows the check is already green on the current head, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nFailed check: {check_name}\nDetails URL: {details_url}\nJob log path: {log_path}\n"
        f"Latest Mergify event: {json.dumps(latest.__dict__ if latest else None, sort_keys=True)}\n"
    )
    run_claude_repair(work_root, prompt)


def repair_conflict(repo: str, pr: PrSnapshot, reason: str) -> None:
    work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    checkout_pr_head(repo, pr, work_root)
    prompt = (
        f"Resolve only the merge conflict that keeps this PR from merging. "
        f"Rebase the PR head branch onto its base branch, preserve the PR's intended changes, "
        f"run the narrow proof for the conflict resolution, then commit and push to the PR head branch. "
        f"If the PR is already closed or merged, or the head branch no longer exists, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nBase branch: {pr.base_ref_name}\nHead branch: {pr.head_ref_name}\n"
        f"Head SHA: {pr.head_ref_oid}\nReason: {reason}\n"
    )
    run_claude_repair(work_root, prompt)


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
    elif action.kind == "remove_merge_hold":
        print(f"{prefix}remove-merge-hold PR #{action.pr_number}")
    elif action.kind == "resolve_bot_threads":
        print(f"{prefix}resolve-bot-threads PR #{action.pr_number} thread={action.key}")
    elif action.kind == "repair_conflict":
        print(f"{prefix}repair-conflict PR #{action.pr_number} {action.detail}")


def execute_action(action: Action, repo: str, gh: GhClient, ledger: Ledger, pr_by_number: Mapping[int, PrSnapshot], now: int) -> None:
    pr = pr_by_number[action.pr_number]
    if action.kind == "requeue":
        gh.comment(repo, action.pr_number, "@mergifyio queue")
        ledger.record("requeue", action.pr_number, pr.head_ref_oid, action.key, now)
    elif action.kind == "comment_admin_bypass_nudge":
        if ledger.count(ADMIN_BYPASS_NUDGE_LEDGER_KIND, action.pr_number, pr.head_ref_oid, action.key) == 0:
            gh.comment(repo, action.pr_number, admin_bypass_nudge_body())
            ledger.record(ADMIN_BYPASS_NUDGE_LEDGER_KIND, action.pr_number, pr.head_ref_oid, action.key, now)
    elif action.kind == "remove_merge_hold":
        gh.edit_label(repo, action.pr_number, remove="merge-hold")
        ledger.record("remove-merge-hold", action.pr_number, pr.head_ref_oid, "merge-hold", now)
    elif action.kind == "resolve_bot_threads":
        gh.resolve_review_thread(action.key)
    elif action.kind == "repair_check":
        check_name = action.key.split(":", 1)[-1]
        kind = "repair-bot-thread" if action.key.startswith("bot_review_thread:") else "repair-check"
        ledger.record(kind, action.pr_number, pr.head_ref_oid, check_name, now)
        repair_check(repo, pr, check_name)
    elif action.kind == "repair_conflict":
        ledger.record("conflict-repair", action.pr_number, pr.head_ref_oid, action.key, now)
        repair_conflict(repo, pr, action.detail)
    elif action.kind == "comment_blocked" and action.key == "capped":
        key = f"capped:{action.detail}"
        if ledger.count("comment-blocked", action.pr_number, pr.head_ref_oid, key) == 0:
            gh.comment(repo, action.pr_number, f"Mergify repair stopped: {action.detail}")
            ledger.record("comment-blocked", action.pr_number, pr.head_ref_oid, key, now)


def load_candidate_stacks(
    gh: GhClient,
    repo: str,
    author: str | None,
    pr_numbers: Sequence[int],
    required_checks: Sequence[str],
    trunk: str,
) -> tuple[StackGroup, ...]:
    candidates = gh.list_candidate_prs(repo, author, pr_numbers)
    candidate_numbers = {int(pr.get("number") or 0) for pr in candidates}
    if not candidate_numbers:
        return ()

    raw_by_number = {
        int(pr.get("number") or 0): pr
        for pr in gh.list_open_prs(repo)
    }
    raw_by_number.update({int(pr.get("number") or 0): pr for pr in candidates})

    comments_cache: dict[int, list[dict]] = {}

    def comments_for(number: int) -> list[dict]:
        if number not in comments_cache:
            comments_cache[number] = gh.issue_comments(repo, number)
        return comments_cache[number]

    # Lightweight grouping pass: use only the list-level fields (state, head/base
    # refs) plus candidate stack metadata to discover which open PRs actually
    # belong to a candidate's stack. This avoids an O(open-PR-count) fan-out of
    # pr_detail/issue_comments calls every cycle.
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

    # Full detail pass: fetch pr_detail/issue_comments only for PRs linked to a
    # candidate stack.
    details: list[tuple[Mapping[str, object], list[dict]]] = []
    for number in sorted(relevant_numbers):
        raw = raw_by_number.get(number)
        detail = raw if raw is not None and "reviewThreads" in raw else gh.pr_detail(repo, number)
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

    return tuple(
        stack
        for stack in group_stack_prs(snapshots, metadata, trunk)
        if any(pr.number in candidate_numbers for pr in stack.prs)
    )


def run_cycle(args: argparse.Namespace) -> bool:
    rule_path = REPO_ROOT / ".mergify.yml"
    try:
        trunk, _labels, required_checks = load_mergify_rules(rule_path)
    except ValueError as exc:
        print("ERROR: failed to load admin-bypass Mergify rule", file=sys.stderr)
        raise RuntimeError("failed to load admin-bypass Mergify rule") from exc

    gh = GhClient()
    stacks = load_candidate_stacks(gh, args.repo, args.author, args.pr, required_checks, trunk)
    ledger = Ledger(Path(args.state_file).expanduser())
    now = int(time.time())
    pr_by_number = {pr.number: pr for stack in stacks for pr in stack.prs}
    should_poll = False
    for stack in stacks:
        actions = plan_stack_actions(stack, required_checks, ledger, now, args.max_requeue_attempts, args.max_repair_attempts)
        if not actions:
            should_poll = True
            continue
        for action in actions:
            pr = pr_by_number.get(action.pr_number)
            print_action(action, pr, args.dry_run, args.json)
            if args.dry_run:
                continue
            execute_action(action, args.repo, gh, ledger, pr_by_number, now)
            if action.kind not in {"comment_blocked", "comment_admin_bypass_nudge"}:
                return True
    return should_poll


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
