from __future__ import annotations

import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
try:
    from .mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, MergifyQueueEvent, PrSnapshot, load_mergify_rules
    from .mergify_admin_requeue_plan import plan_stack_actions
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, group_stack_prs, parse_stack_metadata, snapshot_from_detail
except ImportError:
    from mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, MergifyQueueEvent, PrSnapshot, load_mergify_rules
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


def resolve_workflow(pr_number: int) -> tuple[str, str]:
    try:
        out = subprocess.run(["./run.sh", "--headless", "query", "review-gate", str(pr_number), "--output", "json"], cwd=str(REPO_ROOT), check=True, text=True, capture_output=True).stdout
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        raise RuntimeError(f"cannot resolve local workflow for PR #{pr_number}: {detail}") from exc
    value = json.loads(out) if out.strip() else {}
    workflow = str(value.get("workflowId") or "")
    generation = str(value.get("workflowGeneration") or "0")
    if not workflow:
        raise RuntimeError(f"no local workflow for PR #{pr_number}")
    return workflow, generation


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
    subprocess.run(["omp", "--no-title", "--auto-approve", "-p", prompt], cwd=str(work_root), check=True, text=True)


def repair_conflict(repo: str, pr: PrSnapshot, reason: str) -> None:
    work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    checkout_pr_head(repo, pr, work_root)
    prompt = (
        f"Resolve only the merge conflict that keeps this PR from merging. "
        f"Rebase or recreate the PR head branch onto its base branch, keep the PR's intended changes, "
        f"run the narrow proof for the conflict resolution, then commit and push to the PR head branch. "
        f"If the PR is already closed or merged, or the head branch no longer exists, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nBase branch: {pr.base_ref_name}\nHead branch: {pr.head_ref_name}\n"
        f"Head SHA: {pr.head_ref_oid}\nReason: {reason}\n"
    )
    subprocess.run(["omp", "--no-title", "--auto-approve", "-p", prompt], cwd=str(work_root), check=True, text=True)


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
    elif action.kind == "rebase_recreate":
        print(f"{prefix}rebase-recreate PR #{action.pr_number} {action.detail}")


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
    elif action.kind == "rebase_recreate":
        ledger.record("conflict-repair", action.pr_number, pr.head_ref_oid, action.key, now)
        try:
            workflow, _generation = resolve_workflow(action.pr_number)
        except RuntimeError as exc:
            repair_conflict(repo, pr, str(exc))
            return
        subprocess.run(["node", "scripts/headless-ipc.js", "exec", "--", "rebase-recreate", workflow], cwd=str(REPO_ROOT), check=True, text=True, capture_output=True)
    elif action.kind == "comment_blocked" and action.key == "capped":
        key = f"capped:{action.detail}"
        if ledger.count("comment-blocked", action.pr_number, pr.head_ref_oid, key) == 0:
            gh.comment(repo, action.pr_number, f"Invoker Mergify repair stopped: {action.detail}")
            ledger.record("comment-blocked", action.pr_number, pr.head_ref_oid, key, now)


def run_once(args: argparse.Namespace) -> int:
    rule_path = REPO_ROOT / ".mergify.yml"
    try:
        trunk, _labels, required_checks = load_mergify_rules(rule_path)
    except ValueError:
        print("ERROR: failed to load admin-bypass Mergify rule", file=sys.stderr)
        return 2

    gh = GhClient()
    raw_prs = gh.list_candidate_prs(args.repo, args.author, args.pr)
    details: list[tuple[Mapping[str, object], list[dict]]] = []
    for raw in raw_prs:
        number = int(raw.get("number") or 0)
        detail = raw if "reviewThreads" in raw else gh.pr_detail(args.repo, number)
        comments = gh.issue_comments(args.repo, number)
        details.append((detail, comments))

    snapshots = [snapshot_from_detail(detail, comments, required_checks) for detail, comments in details]
    if args.pr:
        manual = set(args.pr)
        snapshots = [
            replace(
                item,
                latest_mergify=MergifyQueueEvent(
                    "manual",
                    "dequeued",
                    "manual",
                    "",
                    item.head_ref_oid,
                    (),
                    (),
                    "",
                ),
            ) if (
                item.number in manual
                and not ((item.latest_mergify and item.latest_mergify.state == "dequeued") or "dequeued" in item.labels)
            ) else item
            for item in snapshots
        ]
    metadata: dict[int, tuple[str, tuple[int, ...]]] = {}
    for detail, comments in details:
        number = int(detail.get("number") or 0)
        meta = parse_stack_metadata(comments)
        if meta:
            for pr_num in meta[1]:
                metadata[pr_num] = meta
            if number not in metadata:
                metadata[number] = meta
    stacks = group_stack_prs(snapshots, metadata, trunk)
    ledger = Ledger(Path(args.state_file).expanduser())
    now = int(time.time())
    pr_by_number = {pr.number: pr for pr in snapshots}
    for stack in stacks:
        for action in plan_stack_actions(stack, required_checks, ledger, now):
            pr = pr_by_number.get(action.pr_number)
            print_action(action, pr, args.dry_run, args.json)
            if not args.dry_run:
                execute_action(action, args.repo, gh, ledger, pr_by_number, now)
                if action.kind not in {"comment_blocked", "comment_admin_bypass_nudge"}:
                    return 0
    return 0


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Repair and requeue eligible admin-bypass PRs after Mergify dequeue events.")
    parser.add_argument("--once", action="store_true", help="Run one scan/action cycle and exit. Cron uses this.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned actions; perform no GitHub/Invoker mutations.")
    parser.add_argument("--repo", default="Neko-Catpital-Labs/Invoker", help="Default: Neko-Catpital-Labs/Invoker.")
    parser.add_argument("--author", default="EdbertChan", help="Default: EdbertChan.")
    parser.add_argument("--state-file", default=str(Path.home() / ".invoker" / "mergify-admin-requeue-state.jsonl"), help="Ledger JSONL path.")
    parser.add_argument("--pr", type=int, action="append", default=[], help="Limit to a PR; repeatable.")
    parser.add_argument("--max-requeue-attempts", type=int, default=2, help="Default: 2 per PR/head/dequeue event.")
    parser.add_argument("--max-repair-attempts", type=int, default=3, help="Default: 3 per PR/head/blocker.")
    parser.add_argument("--json", action="store_true", help="Emit one JSON object per decision/action.")
    return parser.parse_args(argv)
