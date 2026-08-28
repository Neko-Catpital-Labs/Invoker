#!/usr/bin/env python3
"""Summarize Codex CLI sessions (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl)
for workflow attribution, token spend, and account quota usage.

Built mid-incident on 2026-08-15 to correlate a Codex account's quota
exhaustion with specific Invoker workflows across a fleet of SSH pool
machines, then promoted here since the same question ("which workflow spent
how much, and how close is the account to its cap") recurs any time Codex
usage needs auditing. Meant to be run locally on a machine with Codex
sessions, or piped to `scripts/fleet-ssh.sh --stdin` to run across the
whole fleet in parallel.

Usage:
  codex-session-audit.py [--cutoff ISO8601] [--session-dir DIR]

Options:
  --cutoff        Only include sessions starting at or after this ISO8601
                   timestamp (e.g. 2026-08-15T07:39:16). Default: no cutoff,
                   include every session file found.
  --session-dir   Directory containing rollout-*.jsonl files.
                   Default: ~/.codex/sessions/YYYY/MM/DD for today (UTC).

Output: one JSON array to stdout, one object per session file, with
session_file, ts, workflow_id, task_type, model, total_tokens,
used_percent, resets_at, plan_type, and note (set on parse failure).

workflow_id/task_type are parsed from the session's cwd, which Invoker sets
to a path shaped like:
  .../experiment-wf-<id>-<n>-<task-type>-g<gen>.t<task>.a-<attempt>
A regex here that doesn't match this exact shape (dashes inside task_type,
not just alphanumerics) silently returns workflow_id=None for otherwise
valid sessions -- this happened once already, mid-session; the fixture
tests below pin the fix so it can't regress silently again.
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone

CWD_PATTERN = re.compile(r"experiment-(wf-\d+-\d+)-(.+)-g\d+\.t\d+\.a-")
FILENAME_PATTERN = re.compile(r"rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-")


def default_session_dir():
    today = datetime.now(timezone.utc)
    return os.path.expanduser(
        f"~/.codex/sessions/{today.year:04d}/{today.month:02d}/{today.day:02d}"
    )


def filename_timestamp(fname):
    m = FILENAME_PATTERN.match(fname)
    if not m:
        return None
    ts_raw = m.group(1)
    return ts_raw[:10] + "T" + ts_raw[11:].replace("-", ":")


def summarize_session(path):
    workflow_id = None
    task_type = None
    model = None
    total_tokens = None
    used_percent = None
    resets_at = None
    plan_type = None
    note = None

    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t = e.get("type")
                if t == "session_meta" and workflow_id is None:
                    cwd = e.get("payload", {}).get("cwd", "")
                    m = CWD_PATTERN.search(cwd)
                    if m:
                        workflow_id = m.group(1)
                        task_type = m.group(2)
                if t == "turn_context":
                    model = e.get("payload", {}).get("model", model)
                if t == "event_msg" and e.get("payload", {}).get("type") == "token_count":
                    info = e["payload"]
                    tu = info.get("info", {}).get("total_token_usage", {})
                    total_tokens = tu.get("total_tokens")
                    rl = info.get("rate_limits", {})
                    primary = rl.get("primary") or {}
                    used_percent = primary.get("used_percent")
                    resets_at = primary.get("resets_at")
                    plan_type = rl.get("plan_type")
    except OSError as ex:
        note = f"read-error:{ex}"

    return {
        "session_file": os.path.basename(path),
        "workflow_id": workflow_id,
        "task_type": task_type,
        "model": model,
        "total_tokens": total_tokens,
        "used_percent": used_percent,
        "resets_at": resets_at,
        "plan_type": plan_type,
        "note": note,
    }


def audit(session_dir, cutoff=None):
    results = []
    for path in sorted(glob.glob(os.path.join(session_dir, "*.jsonl"))):
        fname = os.path.basename(path)
        ts_iso = filename_timestamp(fname)
        if ts_iso is None:
            continue
        if cutoff and ts_iso < cutoff:
            continue
        row = summarize_session(path)
        row["ts"] = ts_iso
        results.append(row)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cutoff", default=None, help="ISO8601 timestamp; only include sessions at or after this")
    parser.add_argument("--session-dir", default=None, help="Directory of rollout-*.jsonl files")
    args = parser.parse_args()

    session_dir = args.session_dir or default_session_dir()
    if not os.path.isdir(session_dir):
        print(f"No such session directory: {session_dir}", file=sys.stderr)
        sys.exit(1)

    print(json.dumps(audit(session_dir, args.cutoff)))


if __name__ == "__main__":
    main()
