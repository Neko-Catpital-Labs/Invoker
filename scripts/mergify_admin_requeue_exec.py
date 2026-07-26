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
from typing import Collection, Mapping, Sequence
try:
    from .mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, MergifyQueueEvent, PrSnapshot, StackGroup, load_mergify_rules
    from .mergify_admin_requeue_plan import TRUNK, effective_blockers, plan_stack_actions
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, group_stack_prs, parse_stack_metadata, run_logged, snapshot_from_detail
except ImportError:
    from mergify_admin_requeue_model import Action, GH_ACTIONS_JOB_RE, Ledger, MergifyQueueEvent, PrSnapshot, StackGroup, load_mergify_rules
    from mergify_admin_requeue_plan import TRUNK, effective_blockers, plan_stack_actions
    from mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, group_stack_prs, parse_stack_metadata, run_logged, snapshot_from_detail

REPO_ROOT = Path(__file__).resolve().parents[1]
ADMIN_BYPASS_NUDGE_LEDGER_KIND = "comment-admin-bypass-nudge"
PROOF_POLICY_LANE_ERROR = (
    "Review lane proof cannot ship with policy files in the same PR. "
    "Keep benchmarks, repros, and regression proof separate from behavior or policy changes."
)
PROOF_TOOLING_POLICY_UNIT_ERROR = (
    'PR body Review Unit "proof" cannot ship with tooling-policy files in the same PR. '
    "Split this into one Review Unit per PR."
)
NON_TRUNK_PREREQ_ERROR = "automatic tooling-policy split is only supported for base master"


def admin_bypass_nudge_body() -> str:
    return (
        "Invoker Mergify babysitting is paused: this is the current bottom PR in the stack, "
        "but it is missing the `admin-bypass` label. Please tag this PR with `admin-bypass` "
        "before babysitting can continue."
    )
def log_trace(event: str, **fields: object) -> None:
    payload = {"event": event, **fields}
    print(f"TRACE {json.dumps(payload, sort_keys=True)}", file=sys.stderr)


def summarize_stack(stack: StackGroup, required_checks: Collection[str], trunk: str) -> dict[str, object]:
    blockers_by_pr = {
        pr.number: [
            {"kind": blocker.kind, "key": blocker.key, "detail": blocker.detail}
            for blocker in effective_blockers(pr, required_checks, trunk)
        ]
        for pr in stack.prs
    }
    current_bottoms = [pr for pr in stack.prs if pr.state == "OPEN" and pr.base_ref_name == trunk]
    bottom = current_bottoms[0] if current_bottoms else None
    upper_stack_needs_acceptance = bool(bottom) and any(
        pr.state == "OPEN" and pr.number != bottom.number and "admin-bypass" not in pr.labels
        for pr in stack.prs
    )
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


def wait_reason_for_stack(summary: Mapping[str, object]) -> str:
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


def action_payload(action: Action) -> dict[str, object]:
    return {
        "kind": action.kind,
        "pr_number": action.pr_number,
        "key": action.key,
        "detail": action.detail,
    }


def stack_action_payload(actions: Sequence[Action]) -> list[dict[str, object]]:
    return [action_payload(action) for action in actions]


def log_stack_summary(event: str, stack: StackGroup, required_checks: Collection[str], trunk: str, **fields: object) -> None:
    log_trace(event, **fields, summary=summarize_stack(stack, required_checks, trunk))


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

def git_output(work_root: Path, *args: str) -> str:
    return run_logged(["git", *args], cwd=work_root)


def git_lines(work_root: Path, *args: str) -> tuple[str, ...]:
    return tuple(line.strip() for line in git_output(work_root, *args).splitlines() if line.strip())


def hard_reset_work_root(work_root: Path, target: str) -> None:
    git_output(work_root, "reset", "--hard", target)
    git_output(work_root, "clean", "-fd")


def validate_local_pr_body(work_root: Path, body: str, base_branch: str) -> dict[str, object]:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
        handle.write(body)
        body_path = Path(handle.name)
    try:
        completed = subprocess.run(
            [
                "node",
                str(REPO_ROOT / "scripts" / "validate-pr-body-local.mjs"),
                "--body-file",
                str(body_path),
                "--base",
                base_branch,
                "--json",
            ],
            cwd=str(work_root),
            check=False,
            text=True,
            capture_output=True,
        )
        stdout = completed.stdout.strip()
        if completed.returncode not in {0, 1}:
            raise RuntimeError(completed.stderr.strip() or stdout or "validate-pr-body-local failed")
        if not stdout:
            raise RuntimeError(completed.stderr.strip() or "validate-pr-body-local produced no JSON output")
        value = json.loads(stdout)
        if not isinstance(value, dict):
            raise RuntimeError("validate-pr-body-local returned non-object JSON")
        return value
    finally:
        body_path.unlink(missing_ok=True)


def is_proof_tooling_policy_validation(value: Mapping[str, object]) -> bool:
    errors = value.get("errors")
    scope_kinds = value.get("scopeKinds")
    review_units = value.get("reviewUnits")
    if value.get("reviewLane") != "proof" or value.get("reviewUnit") != "proof":
        return False
    if review_units != ["tooling-policy"]:
        return False
    if scope_kinds not in ([], ["policy"]):
        return False
    if not isinstance(errors, list):
        return False
    return bool(errors) and set(errors).issubset({PROOF_POLICY_LANE_ERROR, PROOF_TOOLING_POLICY_UNIT_ERROR})


def is_prereq_split_validation(value: Mapping[str, object], pr: PrSnapshot) -> bool:
    return pr.base_ref_name == TRUNK and is_proof_tooling_policy_validation(value)


def prerequisite_branch_name(pr: PrSnapshot, start_head: str) -> str:
    return f"stack/pr-babysit-prereq-{pr.number}-{start_head[:7]}"


def prerequisite_title(pr: PrSnapshot, check_name: str) -> str:
    return f"[PR babysit] Tooling-policy repair prerequisite for #{pr.number}: {check_name}"


def prerequisite_body(pr: PrSnapshot, check_name: str) -> str:
    return (
        "## Summary\n\n"
        "Worker-generated tooling-policy repair.\n\n"
        "## Review Claim\n\n"
        f"This PR carries the worker-generated tooling-policy repair that unblocks {check_name} on #{pr.number}.\n\n"
        "## Review Lane\n\n"
        "- policy\n\n"
        "## Review Unit\n\n"
        "- tooling-policy\n\n"
        "## Safety Invariant\n\n"
        "Contains only the worker-generated repair commit; the original PR branch stays proof-only.\n\n"
        "## Slice Rationale\n\n"
        "The repair changed tooling-policy files that a proof PR body cannot carry, so the repair must land first.\n\n"
        "## Non-goals\n\n"
        "- No product behavior change.\n\n"
        "## Test Plan\n\n"
        "<details>\n"
        "<summary>Test Plan</summary>\n\n"
        f"- [ ] Let CI rerun {check_name}.\n\n"
        "</details>\n\n"
        "## Revert Plan\n\n"
        "<details>\n"
        "<summary>Revert Plan</summary>\n\n"
        "- Safe to revert? Yes.\n"
        "- Revert command: `git revert <sha>`\n"
        "- Post-revert steps: None.\n"
        "- Data migration? No.\n\n"
        "</details>\n"
    )


def latest_repair_prereq_row(ledger: Ledger, pr: PrSnapshot) -> dict[str, object] | None:
    latest_row: dict[str, object] | None = None
    latest_epoch = float("-inf")
    for row in ledger.rows:
        if row.get("kind") != "repair-prereq-created":
            continue
        if int(row.get("pr", -1)) != pr.number:
            continue
        if row.get("headSha") != pr.head_ref_oid:
            continue
        epoch = int(row.get("epoch", 0) or 0)
        if latest_row is None or epoch >= latest_epoch:
            latest_row = row
            latest_epoch = epoch
    return latest_row


def comment_repair_blocked(
    gh: GhClient | None,
    ledger: Ledger | None,
    repo: str,
    pr: PrSnapshot,
    now: int | None,
    key: str,
    lines: Sequence[str],
) -> None:
    if gh is None or ledger is None:
        raise RuntimeError("repair_check requires gh and ledger for blocked repair handling")
    detail = "\n".join(lines)
    gh.comment(repo, pr.number, f"Mergify repair stopped:\n{detail}")
    ledger.record("comment-blocked", pr.number, pr.head_ref_oid, key, now, meta={"lines": list(lines)})


def push_branch(work_root: Path, branch_name: str) -> None:
    git_output(work_root, "push", "origin", f"HEAD:{branch_name}")


def create_repair_prerequisite(
    repo: str,
    pr: PrSnapshot,
    check_name: str,
    start_head: str,
    repair_commits: Sequence[str],
    work_root: Path,
    gh: GhClient | None,
    ledger: Ledger | None,
    now: int | None,
) -> dict[str, object]:
    if gh is None or ledger is None:
        raise RuntimeError("repair_check requires gh and ledger for prerequisite PR creation")
    branch_name = prerequisite_branch_name(pr, start_head)
    title = prerequisite_title(pr, check_name)
    body = prerequisite_body(pr, check_name)
    git_output(work_root, "checkout", "-B", branch_name, f"origin/{TRUNK}")
    git_output(work_root, "reset", "--hard", f"origin/{TRUNK}")
    for commit in repair_commits:
        git_output(work_root, "cherry-pick", commit)
    validation = validate_local_pr_body(work_root, body, TRUNK)
    if not validation.get("valid"):
        errors = [str(error) for error in validation.get("errors", [])]
        raise RuntimeError("prerequisite PR body failed validation: " + "; ".join(errors))
    push_branch(work_root, branch_name)
    created = gh.create_pr(repo, title, body, branch_name, TRUNK)
    prereq_number = int(created.get("number") or 0)
    if prereq_number <= 0:
        raise RuntimeError("GitHub did not return a prerequisite PR number")
    gh.edit_label(repo, prereq_number, add="admin-bypass")
    ledger.record(
        "repair-prereq-created",
        pr.number,
        pr.head_ref_oid,
        check_name,
        now,
        meta={"prNumber": prereq_number, "branch": branch_name},
    )
    log_trace(
        "admin-bypass-repair-prereq-created",
        repo=repo,
        pr_number=pr.number,
        check_name=check_name,
        prereq_pr_number=prereq_number,
        prereq_branch=branch_name,
        repair_commits=list(repair_commits),
    )
    return {"prNumber": prereq_number, "branch": branch_name, "title": title}


def run_claude_repair(work_root: Path, prompt: str) -> None:
    subprocess.run(
        ["claude", "-p", prompt, "--dangerously-skip-permissions"],
        cwd=str(work_root),
        check=True,
        text=True,
    )


def repair_check(
    repo: str,
    pr: PrSnapshot,
    check_name: str,
    gh: GhClient | None = None,
    ledger: Ledger | None = None,
    now: int | None = None,
) -> dict[str, object]:
    ctx = pr.checks.get(check_name)
    mergify_urls = mergify_check_urls(pr.latest_mergify, check_name)
    details_url = (ctx.details_url if ctx and ctx.details_url else "") or (mergify_urls[0] if mergify_urls else "")
    log_path = github_job_log(repo, details_url, pr.number, check_name) if details_url else ""
    work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    checkout_pr_head(repo, pr, work_root)
    start_head = git_output(work_root, "rev-parse", "HEAD").strip()
    latest = pr.latest_mergify
    prompt = (
        f"Fix only the failing check. Add or update a repro if the failure is reproducible. "
        f"Commit locally if needed, do not push. If local proof shows the check is already green on the current head, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nFailed check: {check_name}\nDetails URL: {details_url}\nJob log path: {log_path}\n"
        f"Latest Mergify event: {json.dumps(latest.__dict__ if latest else None, sort_keys=True)}\n"
    )
    log_trace(
        "admin-bypass-repair-check-start",
        repo=repo,
        pr_number=pr.number,
        check_name=check_name,
        details_url=details_url,
        log_path=log_path,
        work_root=str(work_root),
        head_sha=pr.head_ref_oid,
    )
    run_claude_repair(work_root, prompt)
    end_head = git_output(work_root, "rev-parse", "HEAD").strip()
    status_lines = git_lines(work_root, "status", "--porcelain")
    if end_head == start_head and not status_lines:
        return {"status": "noop", "startHead": start_head, "endHead": end_head}
    if status_lines:
        hard_reset_work_root(work_root, start_head)
        comment_repair_blocked(
            gh,
            ledger,
            repo,
            pr,
            now,
            f"repair-dirty:{check_name}:{start_head}",
            ["repair left uncommitted changes:", *status_lines],
        )
        return {"status": "blocked-dirty", "startHead": start_head, "endHead": end_head, "statusLines": list(status_lines)}
    repair_commits = git_lines(work_root, "rev-list", "--reverse", f"{start_head}..{end_head}")
    validation = validate_local_pr_body(work_root, pr.body, pr.base_ref_name)
    if validation.get("valid"):
        push_branch(work_root, pr.head_ref_name)
        return {"status": "pushed", "startHead": start_head, "endHead": end_head, "repairCommits": list(repair_commits)}
    errors = [str(error) for error in validation.get("errors", [])]
    if is_prereq_split_validation(validation, pr):
        try:
            created = create_repair_prerequisite(repo, pr, check_name, start_head, repair_commits, work_root, gh, ledger, now)
        finally:
            git_output(work_root, "checkout", "-B", pr.head_ref_name, start_head)
            hard_reset_work_root(work_root, start_head)
        return {
            "status": "prereq-created",
            "startHead": start_head,
            "endHead": end_head,
            "repairCommits": list(repair_commits),
            "prereq": created,
        }
    hard_reset_work_root(work_root, start_head)
    if is_proof_tooling_policy_validation(validation) and pr.base_ref_name != TRUNK:
        errors = [*errors, NON_TRUNK_PREREQ_ERROR]
    comment_repair_blocked(
        gh,
        ledger,
        repo,
        pr,
        now,
        f"repair-invalid:{check_name}:{start_head}",
        errors,
    )
    return {
        "status": "blocked-invalid",
        "startHead": start_head,
        "endHead": end_head,
        "repairCommits": list(repair_commits),
        "errors": errors,
    }

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
    log_trace(
        "admin-bypass-repair-conflict-start",
        repo=repo,
        pr_number=pr.number,
        reason=reason,
        work_root=str(work_root),
        base_ref=pr.base_ref_name,
        head_ref=pr.head_ref_name,
        head_sha=pr.head_ref_oid,
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
    log_trace("admin-bypass-action-execute", action=action_payload(action))
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
        repair_check(repo, pr, check_name, gh, ledger, now)
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

    log_trace(
        "admin-bypass-scan-start",
        repo=args.repo,
        author=args.author,
        pr_numbers=list(args.pr),
        dry_run=args.dry_run,
        json_output=args.json,
    )
    gh = GhClient()
    stacks = load_candidate_stacks(gh, args.repo, args.author, args.pr, required_checks, trunk)
    ledger = Ledger(Path(args.state_file).expanduser())
    now = int(time.time())
    pr_by_number = {pr.number: pr for stack in stacks for pr in stack.prs}
    log_trace(
        "admin-bypass-scan-loaded",
        stack_count=len(stacks),
        stack_ids=[stack.stack_id for stack in stacks],
        candidate_pr_numbers=sorted(pr_by_number),
    )
    should_poll = False
    for stack in stacks:
        log_stack_summary("admin-bypass-stack", stack, required_checks, trunk)
        current_bottoms = [pr for pr in stack.prs if pr.state == "OPEN" and pr.base_ref_name == trunk]
        bottom = current_bottoms[0] if current_bottoms else None
        suppressed_failed_checks_by_pr: dict[int, tuple[str, ...]] | None = None
        prereq_requeue_key: str | None = None
        if bottom:
            prereq_row = latest_repair_prereq_row(ledger, bottom)
            if prereq_row:
                meta = prereq_row.get("meta") if isinstance(prereq_row.get("meta"), Mapping) else {}
                prereq_number = int(meta.get("prNumber") or 0) if isinstance(meta, Mapping) else 0
                prereq_key = str(prereq_row.get("key") or "")
                if prereq_number and prereq_number in pr_by_number:
                    should_poll = True
                    summary = summarize_stack(stack, required_checks, trunk)
                    log_trace(
                        "admin-bypass-repair-prereq-wait",
                        repo=args.repo,
                        pr_number=bottom.number,
                        check_name=prereq_key,
                        prereq_pr_number=prereq_number,
                    )
                    log_trace("admin-bypass-stack-wait", reason="repair-prereq-open", summary=summary)
                    continue
                if prereq_key and ledger.latest("repair-prereq-requeue", bottom.number, bottom.head_ref_oid, prereq_key) is None:
                    suppressed_failed_checks_by_pr = {bottom.number: (prereq_key,)}
                    prereq_requeue_key = prereq_key
        actions = plan_stack_actions(
            stack,
            required_checks,
            ledger,
            now,
            args.max_requeue_attempts,
            args.max_repair_attempts,
            suppressed_failed_checks_by_pr,
        )
        if not actions:
            should_poll = True
            summary = summarize_stack(stack, required_checks, trunk)
            log_trace("admin-bypass-stack-wait", reason=wait_reason_for_stack(summary), summary=summary)
            continue
        log_trace("admin-bypass-stack-actions", stack_id=stack.stack_id, actions=stack_action_payload(actions))
        for action in actions:
            pr = pr_by_number.get(action.pr_number)
            print_action(action, pr, args.dry_run, args.json)
            if args.dry_run:
                continue
            execute_action(action, args.repo, gh, ledger, pr_by_number, now)
            if prereq_requeue_key and bottom and action.kind == "requeue" and action.pr_number == bottom.number:
                ledger.record("repair-prereq-requeue", bottom.number, bottom.head_ref_oid, prereq_requeue_key, now)
                log_trace(
                    "admin-bypass-repair-prereq-requeue",
                    repo=args.repo,
                    pr_number=bottom.number,
                    check_name=prereq_requeue_key,
                )
            if action.kind not in {"comment_blocked", "comment_admin_bypass_nudge"}:
                return True
    if not stacks:
        log_trace("admin-bypass-scan-empty")
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
