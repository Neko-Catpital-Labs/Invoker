from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Mapping, Sequence
from urllib.parse import quote

try:
    from .mergify_admin_requeue_model import (
        MergifyQueueEvent,
        PrSnapshot,
        ReviewThread,
        STACK_MARKER_RE,
        StackGroup,
        all_condition_states,
        extract_first_json_object,
        failing_check_urls,
        latest_contexts_by_required_check,
        payload_rule,
        payload_state,
        reason_failed_checks,
        section_items,
    )
except ImportError:
    from mergify_admin_requeue_model import (
        MergifyQueueEvent,
        PrSnapshot,
        ReviewThread,
        STACK_MARKER_RE,
        StackGroup,
        all_condition_states,
        extract_first_json_object,
        failing_check_urls,
        latest_contexts_by_required_check,
        payload_rule,
        payload_state,
        reason_failed_checks,
        section_items,
    )


class GhClient:
    def _run_json(self, args: Sequence[str]) -> object:
        out = self._run(args)
        return json.loads(out) if out.strip() else None

    def _run(self, args: Sequence[str]) -> str:
        return run_logged(args)

    def list_candidate_prs(self, repo: str, author: str, pr_numbers: Sequence[int]) -> list[dict]:
        if pr_numbers:
            return [self.pr_detail(repo, number) for number in pr_numbers]
        args = [
            "gh", "pr", "list", "--repo", repo, "--author", author, "--state", "open",
            "--label", "admin-bypass", "--limit", "200", "--json",
            "number,title,url,headRefName,headRefOid,baseRefName,state,isDraft,labels,mergeStateStatus,mergeable,reviewDecision,statusCheckRollup",
        ]
        value = self._run_json(args)
        seeds = value if isinstance(value, list) else []
        by_number: dict[int, dict] = {}
        ordered_numbers: list[int] = []

        def remember(number: int, detail: dict) -> None:
            if number not in by_number:
                ordered_numbers.append(number)
            by_number[number] = detail

        for item in seeds:
            if not isinstance(item, dict):
                continue
            number = int(item.get("number") or 0)
            if number:
                remember(number, item)

        queued_stack_numbers: list[int] = []
        queued_stack_number_set: set[int] = set()
        for number in list(ordered_numbers):
            meta = parse_stack_metadata(self.issue_comments(repo, number))
            if not meta:
                continue
            for stack_number in meta[1]:
                if stack_number not in by_number and stack_number not in queued_stack_number_set:
                    queued_stack_number_set.add(stack_number)
                    queued_stack_numbers.append(stack_number)

        for number in queued_stack_numbers:
            remember(number, self.pr_detail(repo, number))

        return [by_number[number] for number in ordered_numbers]

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
        if add:
            subprocess.run(
                ["gh", "api", "--method", "POST", f"repos/{repo}/issues/{number}/labels", "-f", f"labels[]={add}"],
                check=True,
                text=True,
                capture_output=True,
            )
        if remove:
            subprocess.run(
                ["gh", "api", "--method", "DELETE", f"repos/{repo}/issues/{number}/labels/{quote(remove, safe='')}"],
                check=True,
                text=True,
                capture_output=True,
            )

    def resolve_review_thread(self, thread_id: str) -> None:
        query = "mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } } }"
        subprocess.run(["gh", "api", "graphql", "-f", f"threadId={thread_id}", "-f", f"query={query}"], check=True, text=True, capture_output=True)


def run_logged(args: Sequence[str], *, cwd: Path | str | None = None, capture: bool = True) -> str:
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


def checkout_pr_head(repo: str, pr: PrSnapshot, work_root: Path) -> None:
    if not work_root.exists():
        run_logged(["gh", "repo", "clone", repo, str(work_root)])
    refspec = f"+refs/heads/{pr.head_ref_name}:refs/remotes/origin/{pr.head_ref_name}"
    remote_ref = f"refs/remotes/origin/{pr.head_ref_name}"
    run_logged(["git", "fetch", "origin", refspec], cwd=work_root)
    run_logged(["git", "checkout", "-B", pr.head_ref_name, remote_ref], cwd=work_root)
    run_logged(["git", "reset", "--hard", remote_ref], cwd=work_root)
    run_logged(["git", "clean", "-fd"], cwd=work_root)


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
    payload = extract_first_json_object(body[body.find("-*- Mergify Payload -*-"):]) or {}
    sha_match = re.search(r"Left the queue.*?`([0-9a-fA-F]{40})`", body, re.I | re.S)
    head_sha = sha_match.group(1) if sha_match else ""
    queue_pr_match = re.search(r"on draft #(\d+)", body, re.I)
    queue_pr_number = int(queue_pr_match.group(1)) if queue_pr_match else 0
    failing_checks = section_items(body, "Failing checks")
    return MergifyQueueEvent(
        comment_id=str(comment.get("id") or comment.get("databaseId") or ""),
        state=payload_state(payload, body),
        queue_rule_name=payload_rule(payload, body),
        queued_at=str(comment.get("updated_at") or comment.get("created_at") or ""),
        head_sha=head_sha,
        waiting_for=section_items(body, "Waiting for"),
        failing_checks=failing_checks or reason_failed_checks(body),
        comment_url=str(comment.get("html_url") or comment.get("url") or ""),
        queue_pr_number=queue_pr_number,
        failing_check_urls=failing_check_urls(body),
        condition_states=all_condition_states(body),
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


def labels_from_nodes(value: object) -> frozenset[str]:
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


def review_threads(value: object) -> tuple[ReviewThread, ...]:
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


def raw_contexts(pr: Mapping[str, object]) -> list[Mapping[str, object]]:
    rollup = pr.get("statusCheckRollup")
    if not isinstance(rollup, Mapping):
        return []
    contexts = rollup.get("contexts")
    if isinstance(contexts, Mapping):
        nodes = contexts.get("nodes")
    else:
        nodes = contexts
    return [node for node in nodes] if isinstance(nodes, list) else []


def snapshot_from_detail(detail: Mapping[str, object], comments: Sequence[Mapping[str, object]], required_checks: Sequence[str]) -> PrSnapshot:
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
        labels=labels_from_nodes(detail.get("labels")),
        checks=latest_contexts_by_required_check(raw_contexts(detail), head, required_checks),
        review_threads=review_threads(detail.get("reviewThreads")),
        latest_mergify=events[0] if events else None,
    )
