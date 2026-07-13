from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
import time
from typing import Collection, Mapping


SELF_CHECK_NAMES = {"Mergify Merge Queue", "Summary"}
BOT_OR_SELF_AUTHORS = {"coderabbitai", "coderabbitai[bot]", "EdbertChan"}
STACK_MARKER_RE = re.compile(r"<!--\s*mergify-stack-data:\s*(\{.*?\})\s*-->", re.DOTALL)
SHA_RE = re.compile(r"`([0-9a-fA-F]{40})`")
GH_ACTIONS_JOB_RE = re.compile(r"/actions/runs/\d+/job/(\d+)")


@dataclass(frozen=True)
class CheckContext:
    name: str
    state: str
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
    state: str
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
    prs: tuple[PrSnapshot, ...]


@dataclass(frozen=True)
class Blocker:
    key: str
    kind: str
    pr_number: int
    detail: str


@dataclass(frozen=True)
class Action:
    kind: str
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


def latest_contexts_by_required_check(raw_contexts: list[Mapping[str, object]], head_sha: str, required_checks: Collection[str]) -> dict[str, CheckContext]:
    required = set(required_checks)
    latest: dict[str, CheckContext] = {}
    for node in raw_contexts:
        name, state, url, sha, completed = norm_check_state(node)
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


def extract_first_json_object(text: str) -> Mapping[str, object] | None:
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


def payload_state(payload: Mapping[str, object], body: str) -> str:
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


def payload_rule(payload: Mapping[str, object], body: str) -> str:
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


def clean_markdown(text: str) -> str:
    clean = re.sub(r"<[^>]+>", "", text)
    clean = re.sub(r"[*_]", "", clean)
    return clean.strip()


def section_lines(body: str, heading: str) -> tuple[str, ...]:
    lines = body.splitlines()
    out: list[str] = []
    in_section = False
    known_headings = {"waiting for", "failing checks", "all conditions", "reason", "hint", "merge queue status"}
    for line in lines:
        clean = clean_markdown(line)
        heading_text = re.sub(r"^#+\s*", "", clean).strip("` :")
        heading_lower = heading_text.lower()
        if heading_lower == heading.lower():
            in_section = True
            continue
        if in_section and (clean.startswith("#") or (heading_lower in known_headings and heading_lower != heading.lower())):
            break
        if in_section and clean:
            out.append(clean)
    return tuple(out)


def normalize_check_item(item: str) -> str:
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


def section_items(body: str, heading: str) -> tuple[str, ...]:
    out: list[str] = []
    for line in section_lines(body, heading):
        item = normalize_check_item(line)
        if item:
            out.append(item)
    return tuple(out)


def all_condition_states(body: str) -> tuple[tuple[str, str], ...]:
    out: list[tuple[str, str]] = []
    for line in section_lines(body, "All conditions"):
        if "check-success = " not in line:
            continue
        state = "success" if re.search(r"\[[xX]\]", line) else "failure"
        item = normalize_check_item(line)
        if item:
            out.append((item, state))
    return tuple(out)


def failing_check_urls(body: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    pairs: list[tuple[str, tuple[str, ...]]] = []
    for line in section_lines(body, "Failing checks"):
        name = normalize_check_item(line)
        urls = tuple(re.findall(r"https://github\.com/[^)\s]+/actions/runs/\d+/job/\d+", line))
        if name:
            pairs.append((name, urls))
    return tuple(pairs)


def reason_failed_checks(body: str) -> tuple[str, ...]:
    reason = section_lines(body, "Reason")
    if not reason or not any("failing checks" in line.lower() for line in reason):
        return ()
    out: list[str] = []
    for line in reason:
        if not line.startswith("-"):
            continue
        item = normalize_check_item(line)
        if item:
            out.append(item)
    return tuple(out)


def norm_check_state(node: Mapping[str, object]) -> tuple[str, str, str, str, str]:
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
