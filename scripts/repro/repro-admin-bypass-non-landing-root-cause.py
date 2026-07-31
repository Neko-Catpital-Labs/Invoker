#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

DB_PATH = Path.home() / ".invoker" / "invoker.db"
LEDGER_PATH = Path.home() / ".invoker" / "mergify-admin-requeue-state.jsonl"
REPO = "Neko-Catpital-Labs/Invoker"
TARGET_PRS = (6118, 6158, 6435)
WORKER_SOURCE = "pr-maintenance-worker"
REPAIR_STOP_PREFIX = "Mergify repair stopped: "


@dataclass(frozen=True)
class LogEvidence:
    timestamp: str
    level: str
    message: str


def run_gh_json(args: list[str]) -> dict:
    completed = subprocess.run(["gh", *args], text=True, capture_output=True, check=True)
    return json.loads(completed.stdout)


def connect_db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise SystemExit(f"missing invoker db: {DB_PATH}")
    uri = f"file:{DB_PATH}?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_worker_logs(conn: sqlite3.Connection, pr_number: int) -> list[LogEvidence]:
    cur = conn.cursor()
    cur.execute(
        """
        select timestamp, level, message
        from activity_log
        where source = ? and message like ?
        order by datetime(timestamp) asc, id asc
        """,
        (WORKER_SOURCE, f"%{pr_number}%"),
    )
    return [LogEvidence(str(row["timestamp"]), str(row["level"]), str(row["message"])) for row in cur.fetchall()]


def require_line(logs: list[LogEvidence], needle: str, label: str) -> LogEvidence:
    for row in logs:
        if needle in row.message:
            return row
    raise AssertionError(f"missing {label}: {needle}")


def load_ledger_rows(pr_number: int) -> list[dict]:
    if not LEDGER_PATH.exists():
        raise SystemExit(f"missing ledger: {LEDGER_PATH}")
    rows: list[dict] = []
    for raw in LEDGER_PATH.read_text(encoding="utf-8").splitlines():
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if row.get("pr") == pr_number:
            rows.append(row)
    return rows


def latest_row(rows: list[dict], kind: str, head: str, key: str | None = None) -> dict | None:
    matches = [
        row
        for row in rows
        if row.get("kind") == kind
        and row.get("headSha") == head
        and (key is None or row.get("key") == key)
    ]
    if not matches:
        return None
    return max(matches, key=lambda row: int(row.get("epoch", 0) or 0))


def latest_row_any_head(rows: list[dict], kind: str, key: str | None = None) -> dict | None:
    matches = [
        row
        for row in rows
        if row.get("kind") == kind
        and (key is None or row.get("key") == key)
    ]
    if not matches:
        return None
    return max(matches, key=lambda row: int(row.get("epoch", 0) or 0))


def row_errors(row: Mapping[str, object]) -> list[str]:
    meta = row.get("meta") if isinstance(row.get("meta"), Mapping) else {}
    errors = meta.get("errors") if isinstance(meta, Mapping) else []
    return [str(error) for error in errors] if isinstance(errors, list) else []


def gh_pr_snapshot(pr_number: int) -> dict:
    return run_gh_json([
        "pr", "view", str(pr_number), "--repo", REPO, "--comments",
        "--json", "number,title,state,labels,headRefOid,mergeStateStatus,comments,statusCheckRollup",
    ])


def check_names(snapshot: dict) -> list[str]:
    return [node.get("name") or node.get("context") or "" for node in snapshot.get("statusCheckRollup") or []]


def stop_comments(snapshot: Mapping[str, object]) -> list[str]:
    comments = snapshot.get("comments")
    if not isinstance(comments, list):
        return []
    bodies = [str(comment.get("body") or "") for comment in comments if isinstance(comment, Mapping)]
    return [body for body in bodies if body.startswith(REPAIR_STOP_PREFIX)]


def require_stop_comment(snapshot: Mapping[str, object], fragment: str, label: str) -> str:
    for body in stop_comments(snapshot):
        if fragment in body:
            return body
    raise AssertionError(f"missing {label} stop comment fragment: {fragment}")


def summarize_6118(conn: sqlite3.Connection) -> tuple[dict, list[str]]:
    snapshot = gh_pr_snapshot(6118)
    head = str(snapshot["headRefOid"])
    rows = load_ledger_rows(6118)
    if snapshot["state"] != "OPEN":
        attempts = sum(1 for row in rows if row.get("kind") == "conflict-repair")
        return {
            "pr": 6118,
            "state": snapshot["state"],
            "merge_state": snapshot["mergeStateStatus"],
            "labels": [label["name"] for label in snapshot["labels"]],
            "head": head,
            "attempts": attempts,
            "resolved_at": "live state",
            "root_cause": "no longer a stuck open target during this pass.",
        }, check_names(snapshot)
    assert snapshot["mergeStateStatus"] in {"DIRTY", "BLOCKED"}, "6118 is no longer blocked or dirty"

    invalid = latest_row(rows, "repair-invalid", head, "conflict")
    assert invalid is not None, "6118 missing conflict repair-invalid evidence"
    errors = row_errors(invalid)
    assert any("duplicate bottom PR" in error for error in errors), "6118 repair-invalid missing duplicate-stack proof"
    assert any("requires a human to decide" in error for error in errors), "6118 repair-invalid missing human-decision proof"
    exact_stop = require_stop_comment(snapshot, "requires a human to decide", "6118 exact")
    generic_stop = require_stop_comment(snapshot, "The retry cap was reached", "6118 generic cap")

    logs = fetch_worker_logs(conn, 6118)
    cap_log = require_line(logs, "The retry cap was reached for current head " + head, "6118 generic cap retry")
    attempts = sum(1 for row in rows if row.get("kind") == "conflict-repair" and row.get("headSha") == head and row.get("key") == "conflict:6118")

    return {
        "pr": 6118,
        "state": snapshot["state"],
        "merge_state": snapshot["mergeStateStatus"],
        "labels": [label["name"] for label in snapshot["labels"]],
        "head": head,
        "attempts": attempts,
        "exact_stop_at": str(invalid.get("epoch") or ""),
        "generic_cap_at": cap_log.timestamp,
        "exact_comment": exact_stop[len(REPAIR_STOP_PREFIX):],
        "generic_comment": generic_stop[len(REPAIR_STOP_PREFIX):],
        "root_cause": "conflict repair-invalid evidence was recorded, but the planner did not promote conflict blockers to human_decision and later emitted a generic retry-cap blocker.",
    }, check_names(snapshot)


def summarize_6158(conn: sqlite3.Connection) -> tuple[dict, list[str]]:
    snapshot = gh_pr_snapshot(6158)
    head = str(snapshot["headRefOid"])
    assert snapshot["state"] == "OPEN", "6158 is no longer open"
    assert snapshot["mergeStateStatus"] == "DIRTY", "6158 is no longer dirty"

    rows = load_ledger_rows(6158)
    invalid = latest_row(rows, "repair-invalid", head, "PRRT_kwDOSFkSDM6T97v9")
    assert invalid is not None, "6158 missing bot-thread repair-invalid evidence"
    errors = row_errors(invalid)
    assert any("activation-surface files" in error for error in errors), "6158 repair-invalid missing review-unit split proof"
    exact_stop = require_stop_comment(snapshot, "activation-surface files in the same PR", "6158 exact")
    generic_stop = require_stop_comment(snapshot, "The retry cap was reached", "6158 generic cap")

    logs = fetch_worker_logs(conn, 6158)
    cap_log = require_line(logs, "The retry cap was reached for current head " + head, "6158 generic cap retry")
    attempts = sum(1 for row in rows if row.get("kind") == "conflict-repair" and row.get("headSha") == head and row.get("key") == "conflict:6158")

    return {
        "pr": 6158,
        "state": snapshot["state"],
        "merge_state": snapshot["mergeStateStatus"],
        "labels": [label["name"] for label in snapshot["labels"]],
        "head": head,
        "attempts": attempts,
        "exact_stop_at": str(invalid.get("epoch") or ""),
        "generic_cap_at": cap_log.timestamp,
        "exact_comment": exact_stop[len(REPAIR_STOP_PREFIX):],
        "generic_comment": generic_stop[len(REPAIR_STOP_PREFIX):],
        "root_cause": "a bot-thread repair-invalid human split blocker existed on the PR, but later repair passes still retried the conflict path and emitted a generic retry-cap blocker.",
    }, check_names(snapshot)


def summarize_6435(conn: sqlite3.Connection) -> tuple[dict, list[str]]:
    snapshot = gh_pr_snapshot(6435)
    current_head = str(snapshot["headRefOid"])

    rows = load_ledger_rows(6435)
    delegated = latest_row_any_head(rows, "repair-delegated", "conflict:6435")
    assert delegated is not None, "6435 missing same-head repair-delegated evidence"
    delegated_head = str(delegated.get("headSha") or "")
    attempts = sum(1 for row in rows if row.get("kind") == "conflict-repair" and row.get("headSha") == delegated_head and row.get("key") == "conflict:6435")
    assert attempts >= 3, "6435 missing repeated conflict-repair proof"
    generic_cap = latest_row(rows, "comment-blocked", delegated_head)
    assert generic_cap is not None, "6435 missing generic cap proof after delegated repair"

    logs = fetch_worker_logs(conn, 6435)
    delegated_log = require_line(logs, "admin-bypass-repair-delegated", "6435 delegated repair")
    queue_log = require_line(logs, "PR #6435: repair already submitted for this head-state", "6435 queued repair wait")
    cap_log = require_line(logs, "The retry cap was reached for current head " + delegated_head, "6435 bad generic cap")

    return {
        "pr": 6435,
        "state": snapshot["state"],
        "merge_state": snapshot["mergeStateStatus"],
        "labels": [label["name"] for label in snapshot["labels"]],
        "head": current_head if current_head == delegated_head else f"{delegated_head} -> {current_head}",
        "attempts": attempts,
        "delegated_at": delegated_log.timestamp,
        "generic_cap_at": cap_log.timestamp,
        "queue_wait_at": queue_log.timestamp,
        "root_cause": "same-head conflict repair was delegated, but the landing planner ignored the repair-delegated marker and emitted a generic retry-cap blocker instead of waiting; the repair workflow later changed the head.",
    }, check_names(snapshot)


def print_summary(row: Mapping[str, object], names: list[str]) -> None:
    labels = ",".join(row["labels"]) if isinstance(row.get("labels"), list) else ""
    print(
        f"| {row['pr']} | {labels} | {row['state']} / {row['merge_state']} | {row['head']} | "
        f"{row['attempts']} conflict attempts | {row.get('exact_stop_at', row.get('delegated_at', ''))} | "
        f"{row.get('generic_cap_at', row.get('queue_wait_at', ''))} | {row['root_cause']} |"
    )
    if "exact_comment" in row:
        print(f"  exact: {row['exact_comment']}")
    if "generic_comment" in row:
        print(f"  generic: {row['generic_comment']}")
    if "delegated_at" in row:
        print(f"  delegated: {row['delegated_at']}")
    if "queue_wait_at" in row:
        print(f"  queue wait: {row['queue_wait_at']}")
    if "resolved_at" in row:
        print(f"  resolved: {row['resolved_at']}")
    print("  checks:")
    for name in names:
        print(f"    - {name}")


def main() -> int:
    conn = connect_db()
    try:
        summary_6118, names_6118 = summarize_6118(conn)
        summary_6158, names_6158 = summarize_6158(conn)
        summary_6435, names_6435 = summarize_6435(conn)
    finally:
        conn.close()

    print("Admin-bypass non-landing root cause repro")
    print(f"DB: {DB_PATH}")
    print(f"Ledger: {LEDGER_PATH}")
    print()
    print("| PR | labels | live state | head | conflict attempts | exact proof | later bad retry | root cause |")
    print("|---|---|---|---|---|---|---|---|")
    print_summary(summary_6118, names_6118)
    print_summary(summary_6158, names_6158)
    print_summary(summary_6435, names_6435)
    print()
    print("Shared signature: durable stop/wait evidence exists, but subsequent planner passes treated the PR as repairable and could emit generic retry-cap blockers.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"REPRO FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
