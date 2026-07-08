#!/usr/bin/env python3
from __future__ import annotations

import argparse
from dataclasses import dataclass, replace
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import Collection, Mapping, Sequence


SELF_CHECK_NAMES = {"Mergify Merge Queue", "Summary"}
REPO_ROOT = Path(__file__).resolve().parents[1]

BOT_OR_SELF_AUTHORS = {"coderabbitai", "coderabbitai[bot]", "EdbertChan"}
STACK_MARKER_RE = re.compile(r"<!--\s*mergify-stack-data:\s*(\{.*?\})\s*-->", re.DOTALL)
SHA_RE = re.compile(r"`([0-9a-fA-F]{40})`")
GH_ACTIONS_JOB_RE = re.compile(r"/actions/runs/\d+/job/(\d+)")


@dataclass(frozen=True)
class CheckContext:
    name: str
    state: str              # success | failure | pending | skipped | neutral | unknown
    details_url: str
    head_sha: str
    completed_at: str


@dataclass(frozen=True)
class ReviewThread:
    id: str
    is_resolved: bool
    author_logins: tuple[str, ...]


@dataclass(frozen=True)
class MergifyQueueEvent:
    comment_id: str
    state: str              # queued | dequeued | unknown
    queue_rule_name: str
    queued_at: str
    head_sha: str
    waiting_for: tuple[str, ...]
    failing_checks: tuple[str, ...]
    comment_url: str
    queue_pr_number: int = 0
    failing_check_urls: tuple[tuple[str, tuple[str, ...]], ...] = ()
    condition_states: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class PrSnapshot:
    number: int
    title: str
    url: str
    state: str
    is_draft: bool
    base_ref_name: str
    head_ref_name: str
    head_ref_oid: str
    merge_state_status: str
    mergeable: str
    labels: frozenset[str]
    checks: Mapping[str, CheckContext]
    review_threads: tuple[ReviewThread, ...]
    latest_mergify: MergifyQueueEvent | None


@dataclass(frozen=True)
class StackGroup:
    stack_id: str
    prs: tuple[PrSnapshot, ...]  # bottom-to-top


@dataclass(frozen=True)
class Blocker:
    key: str
    kind: str        # draft | human_review_thread | bot_review_thread | merge_hold | conflict | failed_check | pending_check | missing_check | capped
    pr_number: int
    detail: str


@dataclass(frozen=True)
class Action:
    kind: str        # add_admin_bypass_label | rebase_recreate | repair_check | resolve_bot_threads | remove_merge_hold | requeue | comment_blocked
    pr_number: int
    key: str
    detail: str


class Ledger:
    def __init__(self, path: Path):
        self.path = path
        self.rows: list[dict[str, object]] = []
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    self.rows.append(row)

    def count(self, kind: str, pr: int, head_sha: str, key: str) -> int:
        return sum(
            1 for row in self.rows
            if row.get("kind") == kind
            and int(row.get("pr", -1)) == pr
            and row.get("headSha") == head_sha
            and row.get("key") == key
        )

    def has_different_head(self, kind: str, pr: int, current_head: str, key: str) -> bool:
        for row in self.rows:
            if row.get("kind") != kind:
                continue
            if int(row.get("pr", -1)) != pr:
                continue
            if row.get("key") != key:
                continue
            if row.get("headSha") and row.get("headSha") != current_head:
                return True
        return False

    def record(self, kind: str, pr: int, head_sha: str, key: str, epoch: int | None = None) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        row = {"kind": kind, "pr": pr, "headSha": head_sha, "key": key, "epoch": epoch if epoch is not None else int(time.time())}
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")
        self.rows.append(row)


class GhClient:
    def _run_json(self, args: Sequence[str]) -> object:
        out = self._run(args)
        return json.loads(out) if out.strip() else None

    def _run(self, args: Sequence[str]) -> str:
        return _run_logged(args)

    def list_candidate_prs(self, repo: str, author: str, pr_numbers: Sequence[int]) -> list[dict]:
        if pr_numbers:
            return [self.pr_detail(repo, number) for number in pr_numbers]
        args = [
            "gh", "pr", "list", "--repo", repo, "--author", author, "--state", "open",
            "--label", "admin-bypass", "--limit", "200", "--json",
            "number,title,url,headRefName,headRefOid,baseRefName,state,isDraft,labels,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup",
        ]
        value = self._run_json(args)
        return value if isinstance(value, list) else []

    def pr_detail(self, repo: str, number: int) -> dict:
        owner, name = repo.split("/", 1)
        query = (
            "query($owner:String!, $name:String!, $number:Int!) { repository(owner:$owner, name:$name) { "
            "pullRequest(number:$number) { number title url isDraft state baseRefName headRefName headRefOid "
            "mergeStateStatus mergeable labels(first:50) { nodes { name } } "
            "reviewThreads(first:100) { pageInfo { hasNextPage } nodes { id isResolved comments(first:50) { nodes { author { login } body url } } } } "
            "statusCheckRollup { contexts(first:100) { nodes { __typename ... on CheckRun { name conclusion status completedAt startedAt detailsUrl checkSuite { commit { oid } } } "
            "... on StatusContext { context state targetUrl commit { oid } } } } } } } }"
        )
        value = self._run_json([
            "gh", "api", "graphql", "-f", f"owner={owner}", "-f", f"name={name}", "-F", f"number={number}", "-f", f"query={query}",
        ])
        if not isinstance(value, dict):
            raise RuntimeError("empty GraphQL response")
        pr = value.get("data", {}).get("repository", {}).get("pullRequest")
        if not isinstance(pr, dict):
            raise RuntimeError(f"missing PR #{number}")
        return pr

    def issue_comments(self, repo: str, number: int) -> list[dict]:
        value = self._run_json(["gh", "api", f"repos/{repo}/issues/{number}/comments", "--paginate"])
        return value if isinstance(value, list) else []

    def comment(self, repo: str, number: int, body: str) -> None:
        subprocess.run(["gh", "pr", "comment", str(number), "--repo", repo, "--body", body], check=True, text=True, capture_output=True)

    def edit_label(self, repo: str, number: int, add: str | None = None, remove: str | None = None) -> None:
        args = ["gh", "pr", "edit", str(number), "--repo", repo]
        if add:
            args.extend(["--add-label", add])
        if remove:
            args.extend(["--remove-label", remove])
        subprocess.run(args, check=True, text=True, capture_output=True)

    def resolve_review_thread(self, thread_id: str) -> None:
        query = "mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } } }"
        subprocess.run(["gh", "api", "graphql", "-f", f"threadId={thread_id}", "-f", f"query={query}"], check=True, text=True, capture_output=True)
def _run_logged(args: Sequence[str], *, cwd: Path | str | None = None, capture: bool = True) -> str:
    try:
        completed = subprocess.run(
            list(args),
            cwd=str(cwd) if cwd is not None else None,
            check=True,
            text=True,
            capture_output=capture,
        )
    except subprocess.CalledProcessError as exc:
        print(f"ERROR: command failed: {' '.join(str(part) for part in args)}", file=sys.stderr)
        if exc.stdout:
            print(exc.stdout, file=sys.stderr, end="" if exc.stdout.endswith("\n") else "\n")
        if exc.stderr:
            print(exc.stderr, file=sys.stderr, end="" if exc.stderr.endswith("\n") else "\n")
        raise
    return completed.stdout or ""


def _checkout_pr_head(repo: str, pr: PrSnapshot, work_root: Path) -> None:
    if not work_root.exists():
        _run_logged(["gh", "repo", "clone", repo, str(work_root)])
    refspec = f"+refs/heads/{pr.head_ref_name}:refs/remotes/origin/{pr.head_ref_name}"
    remote_ref = f"refs/remotes/origin/{pr.head_ref_name}"
    _run_logged(["git", "fetch", "origin", refspec], cwd=work_root)
    _run_logged(["git", "checkout", "-B", pr.head_ref_name, remote_ref], cwd=work_root)
    _run_logged(["git", "reset", "--hard", remote_ref], cwd=work_root)
    _run_logged(["git", "clean", "-fd"], cwd=work_root)


def _norm_check_state(node: Mapping[str, object]) -> tuple[str, str, str, str, str]:
    typename = str(node.get("__typename") or "")
    if typename == "StatusContext" or "context" in node:
        name = str(node.get("context") or "")
        raw = str(node.get("state") or "").lower()
        state = {
            "success": "success",
            "failure": "failure",
            "error": "failure",
            "pending": "pending",
            "expected": "pending",
        }.get(raw, "unknown")
        url = str(node.get("targetUrl") or "")
        commit = node.get("commit") if isinstance(node.get("commit"), Mapping) else {}
        sha = str(commit.get("oid") or "")
        return name, state, url, sha, ""

    name = str(node.get("name") or "")
    conclusion = str(node.get("conclusion") or "").upper()
    status = str(node.get("status") or "").upper()
    if conclusion in {"SUCCESS"}:
        state = "success"
    elif conclusion in {"FAILURE", "ACTION_REQUIRED", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"}:
        state = "failure"
    elif conclusion == "SKIPPED":
        state = "skipped"
    elif conclusion == "NEUTRAL":
        state = "neutral"
    elif status and status != "COMPLETED":
        state = "pending"
    elif conclusion:
        state = "unknown"
    else:
        state = "pending" if status else "unknown"
    url = str(node.get("detailsUrl") or "")
    suite = node.get("checkSuite") if isinstance(node.get("checkSuite"), Mapping) else {}
    commit = suite.get("commit") if isinstance(suite.get("commit"), Mapping) else {}
    sha = str(commit.get("oid") or "")
    completed = str(node.get("completedAt") or node.get("startedAt") or "")
    return name, state, url, sha, completed


def load_mergify_rules(path: Path) -> tuple[str, frozenset[str], frozenset[str]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        raise ValueError("failed to load admin-bypass Mergify rule")

    start = -1
    start_indent = 0
    for i, line in enumerate(lines):
        match = re.match(r"^(\s*)-\s+name:\s*admin-bypass\s*$", line)
        if match:
            start = i
            start_indent = len(match.group(1))
            break
    if start < 0:
        raise ValueError("failed to load admin-bypass Mergify rule")

    block: list[str] = []
    for line in lines[start + 1:]:
        match = re.match(r"^(\s*)-\s+name:\s+", line)
        if match and len(match.group(1)) <= start_indent:
            break
        block.append(line)

    trunk = ""
    labels: set[str] = set()
    required: set[str] = set()
    in_merge = False
    for raw in block:
        stripped = raw.strip()
        if re.match(r"^[A-Za-z_].*:$", stripped):
            in_merge = stripped == "merge_conditions:"
        if stripped.startswith("- base="):
            trunk = stripped.split("=", 1)[1].strip()
        elif stripped.startswith("- label="):
            labels.add(stripped.split("=", 1)[1].strip())
        elif in_merge and stripped.startswith("- check-success = "):
            required.add(stripped.split("=", 1)[1].strip())

    if not trunk or not labels or not required:
        raise ValueError("failed to load admin-bypass Mergify rule")
    return trunk, frozenset(labels), frozenset(required)


def latest_contexts_by_required_check(raw_contexts: Sequence[Mapping[str, object]], head_sha: str, required_checks: Collection[str]) -> dict[str, CheckContext]:
    required = set(required_checks)
    latest: dict[str, CheckContext] = {}
    for node in raw_contexts:
        name, state, url, sha, completed = _norm_check_state(node)
        if not name or name in SELF_CHECK_NAMES or name.startswith("Rule: "):
            continue
        if sha and sha != head_sha:
            continue
        if name not in required:
            continue
        ctx = CheckContext(name=name, state=state, details_url=url, head_sha=sha or head_sha, completed_at=completed)
        old = latest.get(name)
        if old is None or (old.completed_at, old.state) <= (ctx.completed_at, ctx.state):
            latest[name] = ctx
    return latest


def _extract_first_json_object(text: str) -> Mapping[str, object] | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                try:
                    value = json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
                return value if isinstance(value, Mapping) else None
    return None


def _payload_state(payload: Mapping[str, object], body: str) -> str:
    for key in ("state", "queue_state", "event", "action"):
        value = str(payload.get(key) or "").lower()
        if "dequeue" in value or value == "left":
            return "dequeued"
        if "queue" in value:
            return "queued"
    low = body.lower()
    if "left the queue" in low or "dequeued" in low:
        return "dequeued"
    if "queued" in low or "entered the queue" in low:
        return "queued"
    return "unknown"


def _payload_rule(payload: Mapping[str, object], body: str) -> str:
    candidates = ["queue_rule_name", "queue_rule", "rule", "queue"]
    for key in candidates:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, Mapping):
            nested = value.get("name")
            if nested:
                return str(nested)
    match = re.search(r"queue rule [`']?([^`'\n]+)[`']?", body, re.I)
    return match.group(1).strip() if match else ""


def _clean_markdown(text: str) -> str:
    clean = re.sub(r"<[^>]+>", "", text)
    clean = re.sub(r"[*_]", "", clean)
    return clean.strip()


def _section_lines(body: str, heading: str) -> tuple[str, ...]:
    lines = body.splitlines()
    out: list[str] = []
    in_section = False
    known_headings = {"waiting for", "failing checks", "all conditions", "reason", "hint", "merge queue status"}
    for line in lines:
        clean = _clean_markdown(line)
        heading_text = re.sub(r"^#+\s*", "", clean).strip("` :")
        heading_lower = heading_text.lower()
        if heading_lower == heading.lower():
            in_section = True
            continue
        if in_section and (
            clean.startswith("#")
            or (heading_lower in known_headings and heading_lower != heading.lower())
        ):
            break
        if in_section and clean:
            out.append(clean)
    return tuple(out)


def _normalize_check_item(item: str) -> str:
    link = re.search(r"\[([^\]]+)\]\([^)]+\)", item)
    if link:
        item = link.group(1)
    item = re.sub(r"^[-*]\s*", "", item)
    item = re.sub(r"^\[[ xX]\]\s*", "", item)
    item = re.sub(r"^[^\w`]+", "", item)
    item = item.strip("` ")
    if item.startswith("check-success = "):
        item = item.split(" = ", 1)[1].strip()
    return item


def _section_items(body: str, heading: str) -> tuple[str, ...]:
    out: list[str] = []
    for line in _section_lines(body, heading):
        item = _normalize_check_item(line)
        if item:
            out.append(item)
    return tuple(out)


def _all_condition_states(body: str) -> tuple[tuple[str, str], ...]:
    out: list[tuple[str, str]] = []
    for line in _section_lines(body, "All conditions"):
        if "check-success = " not in line:
            continue
        state = "success" if re.search(r"\[[xX]\]", line) else "failure"
        item = _normalize_check_item(line)
        if item:
            out.append((item, state))
    return tuple(out)


def _failing_check_urls(body: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    pairs: list[tuple[str, tuple[str, ...]]] = []
    for line in _section_lines(body, "Failing checks"):
        name = _normalize_check_item(line)
        urls = tuple(re.findall(r"https://github\.com/[^)\s]+/actions/runs/\d+/job/\d+", line))
        if name:
            pairs.append((name, urls))

    return tuple(pairs)

def _reason_failed_checks(body: str) -> tuple[str, ...]:
    reason = _section_lines(body, "Reason")
    if not reason or not any("failing checks" in line.lower() for line in reason):
        return ()
    out: list[str] = []
    for line in reason:
        if not line.startswith("-"):
            continue
        item = _normalize_check_item(line)
        if item:
            out.append(item)
    return tuple(out)



def parse_mergify_queue_event(comment: Mapping[str, object]) -> MergifyQueueEvent | None:
    author = comment.get("user") if isinstance(comment.get("user"), Mapping) else comment.get("author")
    login = ""
    if isinstance(author, Mapping):
        login = str(author.get("login") or "")
    elif isinstance(author, str):
        login = author
    if login not in {"mergify[bot]", "mergify"}:
        return None
    body = str(comment.get("body") or "")
    if "-*- Mergify Payload -*-" not in body:
        return None
    payload = _extract_first_json_object(body[body.find("-*- Mergify Payload -*-"):]) or {}
    sha_match = re.search(r"Left the queue.*?`([0-9a-fA-F]{40})`", body, re.I | re.S)
    head_sha = sha_match.group(1) if sha_match else ""
    queue_pr_match = re.search(r"on draft #(\d+)", body, re.I)
    queue_pr_number = int(queue_pr_match.group(1)) if queue_pr_match else 0
    failing_checks = _section_items(body, "Failing checks")
    return MergifyQueueEvent(
        comment_id=str(comment.get("id") or comment.get("databaseId") or ""),
        state=_payload_state(payload, body),
        queue_rule_name=_payload_rule(payload, body),
        queued_at=str(comment.get("updated_at") or comment.get("created_at") or ""),
        head_sha=head_sha,
        waiting_for=_section_items(body, "Waiting for"),
        failing_checks=failing_checks or _reason_failed_checks(body),
        comment_url=str(comment.get("html_url") or comment.get("url") or ""),
        queue_pr_number=queue_pr_number,
        failing_check_urls=_failing_check_urls(body),
        condition_states=_all_condition_states(body),
    )


def parse_stack_metadata(comments: Sequence[Mapping[str, object]]) -> tuple[str, tuple[int, ...]] | None:
    ordered = sorted(comments, key=lambda c: str(c.get("updated_at") or c.get("created_at") or ""), reverse=True)
    for comment in ordered:
        body = str(comment.get("body") or "")
        match = STACK_MARKER_RE.search(body)
        if not match:
            continue
        try:
            payload = json.loads(match.group(1))
        except json.JSONDecodeError:
            continue
        stack_id = str(payload.get("stack_id") or payload.get("stackId") or payload.get("id") or "")
        numbers = payload.get("pull_numbers_bottom_to_top") or payload.get("pullNumbersBottomToTop") or payload.get("prs") or payload.get("pulls")
        if stack_id and isinstance(numbers, Sequence) and not isinstance(numbers, (str, bytes)):
            try:
                return stack_id, tuple(int(n) for n in numbers)
            except (TypeError, ValueError):
                continue
    return None


def group_stack_prs(prs: Sequence[PrSnapshot], stack_metadata: Mapping[int, tuple[str, tuple[int, ...]]], trunk: str) -> tuple[StackGroup, ...]:
    by_number = {pr.number: pr for pr in prs}
    used: set[int] = set()
    groups: list[StackGroup] = []
    seen_meta: set[tuple[str, tuple[int, ...]]] = set()
    for pr in prs:
        meta = stack_metadata.get(pr.number)
        if not meta or meta in seen_meta:
            continue
        seen_meta.add(meta)
        stack_id, numbers = meta
        present = tuple(by_number[n] for n in numbers if n in by_number)
        for item in present:
            used.add(item.number)
        if present:
            groups.append(StackGroup(stack_id=stack_id, prs=present))

    remaining = [pr for pr in prs if pr.number not in used]
    by_head = {pr.head_ref_name: pr for pr in remaining if pr.state == "OPEN" and pr.head_ref_name}
    children_by_base: dict[str, list[PrSnapshot]] = {}
    for pr in remaining:
        children_by_base.setdefault(pr.base_ref_name, []).append(pr)

    roots = [pr for pr in remaining if pr.base_ref_name == trunk or pr.base_ref_name not in by_head]
    for root in sorted(roots, key=lambda p: p.number):
        if root.number in used:
            continue
        stack = [root]
        used.add(root.number)
        top = root
        while True:
            children = [child for child in children_by_base.get(top.head_ref_name, []) if child.number not in used]
            if len(children) != 1:
                break
            child = children[0]
            stack.append(child)
            used.add(child.number)
            top = child
        groups.append(StackGroup(stack_id="branch:" + str(stack[0].number), prs=tuple(stack)))

    for pr in remaining:
        if pr.number not in used:
            groups.append(StackGroup(stack_id="single:" + str(pr.number), prs=(pr,)))
    return tuple(groups)


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


def _public_blocker_kind(kind: str) -> str:
    return kind.replace("_", "-")


def _cap_action(pr: PrSnapshot, blocker: Blocker, detail: str) -> Action:
    return Action("comment_blocked", pr.number, "capped", f"{detail}. The retry cap was reached for current head {pr.head_ref_oid}.")

def _mergify_condition_map(event: MergifyQueueEvent | None) -> dict[str, str]:
    return dict(event.condition_states) if event else {}


def _effective_blockers(pr: PrSnapshot, required_checks: Collection[str], trunk: str) -> tuple[Blocker, ...]:
    blockers = [b for b in classify_pr(pr, required_checks, trunk) if b.kind != "not_current_bottom"]
    latest = pr.latest_mergify
    if not latest or latest.head_sha != pr.head_ref_oid:
        return tuple(blockers)
    conditions = _mergify_condition_map(latest)
    return tuple(
        blocker for blocker in blockers
        if not (blocker.kind == "missing_check" and conditions.get(blocker.key) == "success")
    )


def _mergify_failed_check_actions(pr: PrSnapshot, ledger: "Ledger") -> tuple[Action, ...]:
    latest = pr.latest_mergify
    if not latest or latest.state != "dequeued" or latest.head_sha != pr.head_ref_oid:
        return ()
    for name in latest.failing_checks:
        if ledger.count("repair-check", pr.number, pr.head_ref_oid, name) >= 3:
            return (_cap_action(pr, Blocker(name, "failed_check", pr.number, f"Mergify queue check failed: {name}"), f"Mergify queue check failed: {name}"),)
        return (Action("repair_check", pr.number, name, f"Mergify queue check failed: {name}"),)
    return ()



def plan_stack_actions(stack: StackGroup, required_checks: Collection[str], ledger: "Ledger", now_epoch: int) -> tuple[Action, ...]:
    trunk = "master"
    blockers_by_pr = {pr.number: _effective_blockers(pr, required_checks, trunk) for pr in stack.prs}
    all_blockers = [b for blockers in blockers_by_pr.values() for b in blockers]

    for pr in stack.prs:
        actions = _mergify_failed_check_actions(pr, ledger)
        if actions:
            return actions

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "conflict":
                key = f"conflict:{pr.number}"
                if ledger.count("conflict-repair", pr.number, pr.head_ref_oid, key) >= 3:
                    return (_cap_action(pr, blocker, blocker.detail),)
                return (Action("rebase_recreate", pr.number, key, blocker.detail),)
            if blocker.kind == "failed_check":
                if ledger.count("repair-check", pr.number, pr.head_ref_oid, blocker.key) >= 3:
                    return (_cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_check", pr.number, blocker.key, blocker.detail),)

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "bot_review_thread":
                if ledger.has_different_head("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key):
                    return (Action("resolve_bot_threads", pr.number, blocker.key, blocker.detail),)
                if ledger.count("repair-bot-thread", pr.number, pr.head_ref_oid, blocker.key) >= 3:
                    return (_cap_action(pr, blocker, blocker.detail),)
                return (Action("repair_check", pr.number, "bot_review_thread:" + blocker.key, blocker.detail),)

    for pr in stack.prs:
        for blocker in blockers_by_pr[pr.number]:
            if blocker.kind == "pending_check":
                return ()
            if blocker.kind in {"draft", "human_review_thread", "missing_check", "closed"}:
                return (Action("comment_blocked", pr.number, blocker.key, _public_blocker_kind(blocker.kind)),)

    current_bottoms = [pr for pr in stack.prs if pr.state == "OPEN" and pr.base_ref_name == "master"]
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
            return (_cap_action(pr, blocker, blocker.detail),)
        return (Action("remove_merge_hold", pr.number, "merge-hold", blocker.detail),)
    if hold_blockers:
        return ()

    if "admin-bypass" not in bottom.labels:
        if ledger.count("add_admin_bypass_label", bottom.number, bottom.head_ref_oid, "admin-bypass") >= 1:
            return (_cap_action(bottom, Blocker("admin-bypass", "capped", bottom.number, "admin-bypass label add"), "admin-bypass label add"),)
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
        return (_cap_action(bottom, Blocker(requeue_key, "capped", bottom.number, "requeue"), "requeue"),)
    return (Action("requeue", bottom.number, requeue_key, requeue_reason),)


def _labels_from_nodes(value: object) -> frozenset[str]:
    if isinstance(value, Mapping):
        nodes = value.get("nodes")
    else:
        nodes = value
    labels: set[str] = set()
    if isinstance(nodes, Sequence) and not isinstance(nodes, (str, bytes)):
        for item in nodes:
            if isinstance(item, Mapping):
                name = item.get("name")
            else:
                name = item
            if name:
                labels.add(str(name))
    return frozenset(labels)


def _review_threads(value: object) -> tuple[ReviewThread, ...]:
    if not isinstance(value, Mapping):
        return ()
    page = value.get("pageInfo") if isinstance(value.get("pageInfo"), Mapping) else {}
    if page.get("hasNextPage"):
        return (ReviewThread("review-thread-pagination-not-implemented", False, ("human",)),)
    threads: list[ReviewThread] = []
    nodes = value.get("nodes") if isinstance(value.get("nodes"), Sequence) else []
    for node in nodes:
        if not isinstance(node, Mapping):
            continue
        authors: list[str] = []
        comments = node.get("comments") if isinstance(node.get("comments"), Mapping) else {}
        comment_nodes = comments.get("nodes") if isinstance(comments.get("nodes"), Sequence) else []
        for comment in comment_nodes:
            if not isinstance(comment, Mapping):
                continue
            author = comment.get("author") if isinstance(comment.get("author"), Mapping) else {}
            login = author.get("login") if isinstance(author, Mapping) else None
            if login:
                authors.append(str(login))
        threads.append(ReviewThread(str(node.get("id") or ""), bool(node.get("isResolved")), tuple(authors)))
    return tuple(threads)


def _raw_contexts(pr: Mapping[str, object]) -> list[Mapping[str, object]]:
    rollup = pr.get("statusCheckRollup")
    if not isinstance(rollup, Mapping):
        return []
    contexts = rollup.get("contexts")
    if isinstance(contexts, Mapping):
        nodes = contexts.get("nodes")
    else:
        nodes = contexts
    return [node for node in nodes] if isinstance(nodes, list) else []


def snapshot_from_detail(detail: Mapping[str, object], comments: Sequence[Mapping[str, object]], required_checks: Collection[str]) -> PrSnapshot:
    head = str(detail.get("headRefOid") or detail.get("head_ref_oid") or "")
    events = [event for comment in comments for event in [parse_mergify_queue_event(comment)] if event]
    events.sort(key=lambda event: event.queued_at, reverse=True)
    return PrSnapshot(
        number=int(detail.get("number") or 0),
        title=str(detail.get("title") or ""),
        url=str(detail.get("url") or ""),
        state=str(detail.get("state") or ""),
        is_draft=bool(detail.get("isDraft") or detail.get("is_draft")),
        base_ref_name=str(detail.get("baseRefName") or detail.get("base_ref_name") or ""),
        head_ref_name=str(detail.get("headRefName") or detail.get("head_ref_name") or ""),
        head_ref_oid=head,
        merge_state_status=str(detail.get("mergeStateStatus") or detail.get("merge_state_status") or ""),
        mergeable=str(detail.get("mergeable") or ""),
        labels=_labels_from_nodes(detail.get("labels")),
        checks=latest_contexts_by_required_check(_raw_contexts(detail), head, required_checks),
        review_threads=_review_threads(detail.get("reviewThreads")),
        latest_mergify=events[0] if events else None,
    )


def _resolve_workflow(pr_number: int) -> tuple[str, str]:
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


def _github_job_log(repo: str, details_url: str, pr_number: int, check_name: str) -> str:
    match = GH_ACTIONS_JOB_RE.search(details_url)
    if not match:
        return ""
    tmp = Path(tempfile.mkdtemp(prefix=f"mergify-admin-requeue-{pr_number}-"))
    path = tmp / (re.sub(r"[^A-Za-z0-9_.-]+", "-", check_name).strip("-") + ".log")
    out = subprocess.run(["gh", "run", "view", "--repo", repo, "--job", match.group(1), "--log"], check=True, text=True, capture_output=True).stdout
    path.write_text(out, encoding="utf-8")
    return str(path)


def _mergify_check_urls(event: MergifyQueueEvent | None, check_name: str) -> tuple[str, ...]:
    if not event:
        return ()
    for name, urls in event.failing_check_urls:
        if name == check_name:
            return urls
    return ()


def _repair_check(repo: str, pr: PrSnapshot, check_name: str) -> None:
    ctx = pr.checks.get(check_name)
    mergify_urls = _mergify_check_urls(pr.latest_mergify, check_name)
    details_url = (ctx.details_url if ctx and ctx.details_url else "") or (mergify_urls[0] if mergify_urls else "")
    log_path = _github_job_log(repo, details_url, pr.number, check_name) if details_url else ""
    work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    _checkout_pr_head(repo, pr, work_root)
    latest = pr.latest_mergify
    prompt = (
        f"Fix only the failing check. Add or update a repro if the failure is reproducible. "
        f"Commit and push to the PR head branch. If local proof shows the check is already green on the current head, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nFailed check: {check_name}\nDetails URL: {details_url}\nJob log path: {log_path}\n"
        f"Latest Mergify event: {json.dumps(latest.__dict__ if latest else None, sort_keys=True)}\n"
    )
    subprocess.run(["omp", "--no-title", "--auto-approve", "-p", prompt], cwd=str(work_root), check=True, text=True)

def _repair_conflict(repo: str, pr: PrSnapshot, reason: str) -> None:
    work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
    work_root.parent.mkdir(parents=True, exist_ok=True)
    _checkout_pr_head(repo, pr, work_root)
    prompt = (
        f"Resolve only the merge conflict that keeps this PR from merging. "
        f"Rebase or recreate the PR head branch onto its base branch, keep the PR's intended changes, "
        f"run the narrow proof for the conflict resolution, then commit and push to the PR head branch. "
        f"If the PR is already closed or merged, or the head branch no longer exists, make no commit and exit 0.\n\n"
        f"PR: #{pr.number}\nBase branch: {pr.base_ref_name}\nHead branch: {pr.head_ref_name}\n"
        f"Head SHA: {pr.head_ref_oid}\nReason: {reason}\n"
    )
    subprocess.run(["omp", "--no-title", "--auto-approve", "-p", prompt], cwd=str(work_root), check=True, text=True)




def _print_action(action: Action, pr: PrSnapshot | None, dry_run: bool, as_json: bool) -> None:
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
    elif action.kind == "add_admin_bypass_label":
        print(f"{prefix}add-admin-bypass-label PR #{action.pr_number}")
    elif action.kind == "remove_merge_hold":
        print(f"{prefix}remove-merge-hold PR #{action.pr_number}")
    elif action.kind == "resolve_bot_threads":
        print(f"{prefix}resolve-bot-threads PR #{action.pr_number} thread={action.key}")
    elif action.kind == "rebase_recreate":
        print(f"{prefix}rebase-recreate PR #{action.pr_number} {action.detail}")


def _execute_action(action: Action, repo: str, gh: GhClient, ledger: Ledger, pr_by_number: Mapping[int, PrSnapshot], now: int) -> None:
    pr = pr_by_number[action.pr_number]
    if action.kind == "requeue":
        gh.comment(repo, action.pr_number, "@mergifyio queue")
        ledger.record("requeue", action.pr_number, pr.head_ref_oid, action.key, now)
    elif action.kind == "add_admin_bypass_label":
        gh.edit_label(repo, action.pr_number, add="admin-bypass")
        ledger.record("add_admin_bypass_label", action.pr_number, pr.head_ref_oid, "admin-bypass", now)
    elif action.kind == "remove_merge_hold":
        gh.edit_label(repo, action.pr_number, remove="merge-hold")
        ledger.record("remove-merge-hold", action.pr_number, pr.head_ref_oid, "merge-hold", now)
    elif action.kind == "resolve_bot_threads":
        gh.resolve_review_thread(action.key)
    elif action.kind == "repair_check":
        check_name = action.key.split(":", 1)[-1]
        kind = "repair-bot-thread" if action.key.startswith("bot_review_thread:") else "repair-check"
        ledger.record(kind, action.pr_number, pr.head_ref_oid, check_name, now)
        _repair_check(repo, pr, check_name)
    elif action.kind == "rebase_recreate":
        ledger.record("conflict-repair", action.pr_number, pr.head_ref_oid, action.key, now)
        try:
            workflow, _generation = _resolve_workflow(action.pr_number)
        except RuntimeError as exc:
            _repair_conflict(repo, pr, str(exc))
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
            _print_action(action, pr, args.dry_run, args.json)
            if not args.dry_run:
                _execute_action(action, args.repo, gh, ledger, pr_by_number, now)
                if action.kind not in {"comment_blocked"}:
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


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    return run_once(args)


if __name__ == "__main__":
    raise SystemExit(main())
