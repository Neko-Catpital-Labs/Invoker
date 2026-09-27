#!/usr/bin/env python3
"""Report repeat token cost by joining session recovery to transcripts.

Prefer the skill join mode when available:
  ~/.cursor/skills/principle-trace-token-burn-loop/scripts/scan_session_tokens.py \\
    --recovery-dump recovery.jsonl \\
    --decision-log ~/.invoker/mergify-admin-requeue-state.jsonl \\
    ~/.invoker/claude-worker/projects

This Invoker-local script does the same join without prompt-text labels.
A session joins when its filename matches task_session_recovery.agent_session_id.
Repeat groups use the decision log's workflowId when present, else the recovery
workflow_id.

Usage:
  python3 scripts/report-session-repeat-cost.py \\
    --recovery-dump recovery.jsonl \\
    --decision-log ~/.invoker/mergify-admin-requeue-state.jsonl \\
    --projects-root ~/.invoker/claude-worker/projects \\
    [--since 2026-09-19T21:31:38]

recovery.jsonl rows are one JSON object per line with at least:
  workflow_id, agent_session_id
optional: transcript_path, config_dir, task_id

Dump with:
  sqlite3 -json ~/.invoker/invoker.db \\
    "SELECT * FROM task_session_recovery" | jq -c '.[]' > recovery.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

KEYS = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")


def add_usage(line: str, seen: dict[str, tuple[int, int, int, int]]) -> None:
    if '"usage"' not in line or '"input_tokens"' not in line:
        return
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return
    msg = obj.get("message") if isinstance(obj, dict) else None
    if not isinstance(msg, dict):
        return
    mid = msg.get("id")
    usage = msg.get("usage")
    if not mid or not isinstance(usage, dict):
        return
    fields = tuple(int(usage.get(k) or 0) for k in KEYS)
    prev = seen.get(mid)
    if prev is None or sum(fields) > sum(prev):
        seen[mid] = fields


def scan_file(path: Path) -> tuple[tuple[int, int, int, int], str | None]:
    seen: dict[str, tuple[int, int, int, int]] = {}
    first_ts: str | None = None
    with path.open(errors="replace") as fh:
        for line in fh:
            if first_ts is None:
                m = re.search(r'"timestamp":"([^"]+)"', line)
                if m:
                    first_ts = m.group(1)
            add_usage(line, seen)
    totals = [0, 0, 0, 0]
    for fields in seen.values():
        for i, v in enumerate(fields):
            totals[i] += v
    return (totals[0], totals[1], totals[2], totals[3]), first_ts


def load_recovery(path: Path) -> dict[str, dict]:
    by_session: dict[str, dict] = {}
    with path.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            sid = row.get("agent_session_id") or row.get("agentSessionId")
            if not sid:
                continue
            by_session[str(sid)] = row
    return by_session


def load_decision_workflows(path: Path) -> dict[str, tuple[int | None, str | None, str | None]]:
    """workflowId -> (pr, key/check, headSha prefix)."""
    out: dict[str, tuple[int | None, str | None, str | None]] = {}
    if not path.is_file():
        return out
    with path.open(errors="replace") as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            meta = row.get("meta") or {}
            wf = meta.get("workflowId")
            if not wf:
                continue
            pr = row.get("pr")
            key = row.get("key")
            head = str(row.get("headSha") or "")[:12] or None
            out[str(wf)] = (int(pr) if pr is not None else None, str(key) if key else None, head)
    return out


def find_session_files(projects_roots: list[Path]) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for root in projects_roots:
        if not root.is_dir():
            continue
        for dirpath, _dns, fns in os.walk(root):
            for name in fns:
                if not name.endswith(".jsonl") or name.startswith("agent-"):
                    continue
                sid = name[: -len(".jsonl")]
                found.setdefault(sid, Path(dirpath) / name)
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--recovery-dump", required=True)
    parser.add_argument("--decision-log", default="")
    parser.add_argument("--projects-root", action="append", default=[])
    parser.add_argument("--since", default="")
    args = parser.parse_args()

    recovery = load_recovery(Path(args.recovery_dump))
    decision = load_decision_workflows(Path(args.decision_log)) if args.decision_log else {}
    roots = [Path(p) for p in args.projects_root] or [
        Path.home() / ".invoker" / "claude-worker" / "projects",
        Path.home() / ".claude" / "projects",
    ]
    files = find_session_files(roots)

    for sid, row in recovery.items():
        tp = row.get("transcript_path") or row.get("transcriptPath")
        if tp and Path(tp).is_file():
            files[sid] = Path(tp)

    groups: dict[str, dict] = defaultdict(lambda: {
        "sessions": 0,
        "input": 0,
        "output": 0,
        "cache_read": 0,
        "cache_write": 0,
        "workflow_ids": set(),
        "pr": None,
        "check": None,
        "head": None,
    })
    matched = 0
    unmatched_tokens = [0, 0, 0, 0]
    unmatched_sessions = 0

    for sid, path in files.items():
        totals, first_ts = scan_file(path)
        if args.since and first_ts and first_ts[:19] < args.since[:19]:
            continue
        row = recovery.get(sid)
        if not row:
            unmatched_sessions += 1
            for i, v in enumerate(totals):
                unmatched_tokens[i] += v
            continue
        matched += 1
        wf = str(row.get("workflow_id") or row.get("workflowId") or "unknown")
        pr, check, head = decision.get(wf, (None, None, None))
        if pr is not None and check is not None:
            group_key = f"pr={pr} check={check} head={head or '?'}"
        else:
            group_key = f"workflow={wf}"
        g = groups[group_key]
        g["sessions"] += 1
        g["input"] += totals[0]
        g["output"] += totals[1]
        g["cache_read"] += totals[2]
        g["cache_write"] += totals[3]
        g["workflow_ids"].add(wf)
        if pr is not None:
            g["pr"] = pr
            g["check"] = check
            g["head"] = head

    print(f"matched_sessions={matched} unmatched_sessions={unmatched_sessions}")
    ug = sum(unmatched_tokens)
    print(
        f"unmatched_tokens_M={ug/1e6:.1f} "
        f"(in={unmatched_tokens[0]/1e6:.1f} out={unmatched_tokens[1]/1e6:.1f} "
        f"cache_read={unmatched_tokens[2]/1e6:.1f} cache_write={unmatched_tokens[3]/1e6:.1f})"
    )
    ranked = sorted(groups.items(), key=lambda kv: -(kv[1]["input"] + kv[1]["output"] + kv[1]["cache_read"] + kv[1]["cache_write"]))
    print("top_groups")
    for key, g in ranked[:30]:
        gross = g["input"] + g["output"] + g["cache_read"] + g["cache_write"]
        share = 100 * g["cache_read"] / gross if gross else 0
        print(
            f"  {gross/1e6:8.1f}M sessions={g['sessions']:3} cache_read_share={share:4.0f}% "
            f"wfs={len(g['workflow_ids'])} {key}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
