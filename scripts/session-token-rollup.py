#!/usr/bin/env python3
"""Roll up agent token spend on one machine, then rank sessions across machines.

Stdlib only, so it can be piped to a host that has no node_modules:
  ssh droplet python3 - collect --since 2026-08-24 < scripts/session-token-rollup.py

Usage:
  session-token-rollup.py collect --since YYYY-MM-DD [--host NAME] [--now ISO]
      [--claude-root DIR]... [--codex-root DIR] [--omp-root DIR]
      [--sessions N] [--out FILE]
  session-token-rollup.py merge REPORT... [--top N] [--max-age-days D]
      [--now ISO] [--json]

collect streams every Claude JSONL under ~/.claude/projects and
~/.invoker/claude-worker*/projects, every Codex rollout under
~/.codex/sessions, and every OMP session under ~/.omp/agent/sessions, and
prints one JSON report. merge combines machine reports, ranks sessions by
total tokens, and prints the top N plus per-machine totals.

Safety invariant: only counts, timestamps, model names and session ids are
emitted. No message text, file content or tool output reaches a report.
"""
import argparse
import glob
import json
import os
import re
import socket
import statistics
import sys
from datetime import datetime, timedelta, timezone

CLAUDE = "claude"
CODEX = "codex"
OMP = "omp"
WORKER_MARKERS = (".invoker", "--invoker-")
SYNTHETIC_MODEL = "<synthetic>"
UNKNOWN_MODEL = "unknown"
DEFAULT_SESSION_LIMIT = 200
DEFAULT_MERGE_TOP = 10
DEFAULT_MAX_AGE_DAYS = 8
SUBAGENTS_DIR = "subagents"
ROLLOUT_SESSION_RE = re.compile(r"^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$")
NOTIFICATION_RE = re.compile(r"reminder|notification", re.IGNORECASE)
TOKEN_FIELDS = ("input", "cache_read", "cache_write", "output")


def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_day(value):
    try:
        day = datetime.strptime((value or "").strip(), "%Y-%m-%d")
    except ValueError:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD, got {!r}".format(value))
    return "{:04d}-{:02d}-{:02d}".format(day.year, day.month, day.day)


def parse_iso(value):
    text = (value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def looks_like_worker(text):
    lowered = (text or "").lower()
    return any(marker in lowered for marker in WORKER_MARKERS)


def origin_for(*candidates):
    for candidate in candidates:
        if looks_like_worker(candidate):
            return "worker"
    return "interactive"


def day_of(timestamp):
    return timestamp[:10] if timestamp else "unknown"


def as_int(value):
    return value if isinstance(value, int) else 0


class SessionStats:
    def __init__(self, session_id, tool, origin):
        self.session_id = session_id
        self.tool = tool
        self.origin = origin
        self.input = 0
        self.cache_read = 0
        self.cache_write = 0
        self.output = 0
        self.turns = 0
        self.peak_context = 0
        self.compactions = 0
        self.notification_turns = 0
        self.first_timestamp = None
        self.last_timestamp = None
        self.model_tokens = {}
        self.fork_starts = []
        self.seen_usage_keys = set()
        self.seen_compaction_keys = set()

    @property
    def total(self):
        return self.input + self.cache_read + self.cache_write + self.output

    def note_worker_origin(self, *candidates):
        if self.origin != "worker" and origin_for(*candidates) == "worker":
            self.origin = "worker"

    def note_timestamp(self, timestamp):
        if not timestamp:
            return
        if self.first_timestamp is None or timestamp < self.first_timestamp:
            self.first_timestamp = timestamp
        if self.last_timestamp is None or timestamp > self.last_timestamp:
            self.last_timestamp = timestamp

    def add_usage(self, model, tokens, context, timestamp):
        self.input += tokens["input"]
        self.cache_read += tokens["cache_read"]
        self.cache_write += tokens["cache_write"]
        self.output += tokens["output"]
        self.turns += 1
        self.peak_context = max(self.peak_context, context)
        billed = sum(tokens[field] for field in TOKEN_FIELDS)
        self.model_tokens[model] = self.model_tokens.get(model, 0) + billed
        self.note_timestamp(timestamp)

    def has_window_activity(self):
        return self.turns > 0 or self.compactions > 0 or self.notification_turns > 0

    def model(self):
        if not self.model_tokens:
            return UNKNOWN_MODEL
        return max(sorted(self.model_tokens), key=lambda name: self.model_tokens[name])

    def record(self):
        median_start = None
        if self.fork_starts:
            median_start = int(round(statistics.median(self.fork_starts)))
        return {
            "session_id": self.session_id,
            "tool": self.tool,
            "origin": self.origin,
            "model": self.model(),
            "input": self.input,
            "cache_read": self.cache_read,
            "cache_write": self.cache_write,
            "output": self.output,
            "total": self.total,
            "turns": self.turns,
            "peak_context": self.peak_context,
            "compactions": self.compactions,
            "fork_count": len(self.fork_starts),
            "median_fork_start_context": median_start,
            "notification_turns": self.notification_turns,
            "first_timestamp": self.first_timestamp,
            "last_timestamp": self.last_timestamp,
        }


class Rollup:
    def __init__(self, host, since):
        self.host = host
        self.since = since
        self.sessions = {}
        self.day_totals = {}
        self.files = 0
        self.unreadable_files = 0
        self.bad_json_lines = 0
        self.forks_without_parent = 0
        self.fork_starts = {}

    def session(self, tool, session_id, *origin_candidates):
        key = (tool, session_id)
        stats = self.sessions.get(key)
        if stats is None:
            stats = SessionStats(session_id, tool, origin_for(*origin_candidates))
            self.sessions[key] = stats
        else:
            stats.note_worker_origin(*origin_candidates)
        return stats

    def in_window(self, timestamp):
        if not self.since:
            return True
        if not timestamp:
            return True
        return timestamp[:10] >= self.since

    def add_day_total(self, tool, origin, model, timestamp, tokens):
        key = "{}|{}|{}|{}".format(tool, origin, model, day_of(timestamp))
        bucket = self.day_totals.get(key)
        if bucket is None:
            bucket = {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "total": 0, "turns": 0}
            self.day_totals[key] = bucket
        for field in TOKEN_FIELDS:
            bucket[field] += tokens[field]
            bucket["total"] += tokens[field]
        bucket["turns"] += 1

    def bill(self, stats, model, tokens, context, timestamp):
        stats.add_usage(model, tokens, context, timestamp)
        self.add_day_total(stats.tool, stats.origin, model, timestamp, tokens)

    def open_lines(self, path):
        self.files += 1
        try:
            handle = open(path, errors="replace")
        except OSError as err:
            self.unreadable_files += 1
            print("[rollup] unreadable file ({}): {}".format(type(err).__name__, err.strerror), file=sys.stderr)
            return None
        return handle

    def rows(self, path):
        handle = self.open_lines(path)
        if handle is None:
            return
        with handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    self.bad_json_lines += 1

    def attach_forks(self):
        for parent_id, forks in sorted(self.fork_starts.items()):
            stats = self.sessions.get((CLAUDE, parent_id))
            if stats is None:
                self.forks_without_parent += len(forks)
                continue
            stats.fork_starts = sorted(forks.values())

    def report(self, generated_at, session_limit):
        self.attach_forks()
        records = sorted(
            (stats.record() for stats in self.sessions.values() if stats.has_window_activity()),
            key=lambda row: (-row["total"], row["tool"], row["session_id"]),
        )
        return {
            "host": self.host,
            "generatedAt": generated_at,
            "since": self.since,
            "files": self.files,
            "errors": {
                "unreadable_files": self.unreadable_files,
                "bad_json_lines": self.bad_json_lines,
                "forks_without_parent": self.forks_without_parent,
            },
            "totals_by_tool_origin_model_day": dict(sorted(self.day_totals.items())),
            "session_count": len(records),
            "sessions": records[:session_limit],
        }


def claude_default_roots():
    roots = [os.path.expanduser("~/.claude/projects")]
    roots.extend(sorted(glob.glob(os.path.expanduser("~/.invoker/claude-worker*/projects"))))
    return roots


def jsonl_files(root):
    for directory, _dirs, names in os.walk(root):
        for name in sorted(names):
            if name.endswith(".jsonl"):
                yield os.path.join(directory, name)


def claude_session_of(root, path):
    relative = os.path.relpath(path, root)
    parts = relative.split(os.sep)
    project = parts[0] if parts else ""
    if SUBAGENTS_DIR in parts:
        index = parts.index(SUBAGENTS_DIR)
        parent = parts[index - 1] if index >= 1 else os.path.basename(path)[: -len(".jsonl")]
        return project, parent, True
    return project, os.path.basename(path)[: -len(".jsonl")], False


def claude_usage_tokens(usage):
    return {
        "input": as_int(usage.get("input_tokens")),
        "cache_read": as_int(usage.get("cache_read_input_tokens")),
        "cache_write": as_int(usage.get("cache_creation_input_tokens")),
        "output": as_int(usage.get("output_tokens")),
    }


def claude_usage_fields(row, message):
    usage = row.get("usage")
    if not isinstance(usage, dict):
        usage = message.get("usage")
    if not isinstance(usage, dict):
        return None, None
    model = row.get("model") or message.get("model") or UNKNOWN_MODEL
    return usage, model


def claude_usage_key(row, message, row_index):
    message_id = message.get("id") or row.get("id")
    request_id = row.get("requestId")
    if message_id is None and request_id is None:
        return ("row", row.get("uuid") or row_index)
    return (message_id, request_id)


def collect_claude_file(rollup, root, path):
    project, session_id, is_subagent = claude_session_of(root, path)
    stats = rollup.session(CLAUDE, session_id, project)
    forked_from = None
    fork_start_context = None
    for row_index, row in enumerate(rollup.rows(path)):
        row_session = row.get("sessionId")
        if not is_subagent and row_session and row_session != session_id:
            forked_from = row_session
            continue
        timestamp = row.get("timestamp")
        if not rollup.in_window(timestamp):
            continue
        row_type = row.get("type")
        if row_type == "system" and row.get("subtype") == "compact_boundary":
            stats.compactions += 1
            stats.note_timestamp(timestamp)
            continue
        if row_type == "attachment":
            attachment_type = (row.get("attachment") or {}).get("type") or ""
            if NOTIFICATION_RE.search(attachment_type):
                stats.notification_turns += 1
                stats.note_timestamp(timestamp)
            continue
        if row_type != "assistant":
            continue
        message = row.get("message")
        if not isinstance(message, dict):
            message = {}
        key = claude_usage_key(row, message, row_index)
        if message.get("isCompactSummary") is True or row.get("isCompactSummary") is True:
            if key not in stats.seen_compaction_keys:
                stats.seen_compaction_keys.add(key)
                stats.compactions += 1
        usage, model = claude_usage_fields(row, message)
        if usage is None:
            continue
        if model == SYNTHETIC_MODEL:
            continue
        if key in stats.seen_usage_keys:
            continue
        stats.seen_usage_keys.add(key)
        stats.note_worker_origin(row.get("cwd"))
        tokens = claude_usage_tokens(usage)
        context = tokens["input"] + tokens["cache_read"] + tokens["cache_write"]
        if forked_from and fork_start_context is None:
            fork_start_context = context
        rollup.bill(stats, model, tokens, context, timestamp)
    if forked_from is not None and fork_start_context is not None:
        rollup.fork_starts.setdefault(forked_from, {})[session_id] = fork_start_context


def collect_claude(rollup, roots):
    for root in roots:
        if not os.path.isdir(root):
            continue
        for path in jsonl_files(root):
            collect_claude_file(rollup, root, path)


def codex_session_id(path):
    name = os.path.basename(path)
    match = ROLLOUT_SESSION_RE.match(name)
    if match:
        return match.group(1)
    return name[: -len(".jsonl")]


def codex_usage_split(usage):
    cached = as_int(usage.get("cached_input_tokens"))
    total_input = as_int(usage.get("input_tokens"))
    return {
        "input": max(total_input - cached, 0),
        "cache_read": cached,
        "cache_write": 0,
        "output": as_int(usage.get("output_tokens")),
    }


def collect_codex_file(rollup, path):
    session_id = codex_session_id(path)
    stats = rollup.session(CODEX, session_id)
    model = None
    first_model = None
    previous = None
    pending = []
    for row in rollup.rows(path):
        payload = row.get("payload") or {}
        row_type = row.get("type")
        if row_type == "session_meta":
            stats.note_worker_origin(payload.get("cwd"))
            continue
        if row_type == "turn_context":
            model = payload.get("model") or model
            if first_model is None:
                first_model = model
            stats.note_worker_origin(payload.get("cwd"))
            continue
        if row_type != "event_msg" or payload.get("type") != "token_count":
            continue
        info = payload.get("info")
        if not isinstance(info, dict):
            continue
        totals = info.get("total_token_usage")
        if not isinstance(totals, dict):
            continue
        current = codex_usage_split(totals)
        current_total = as_int(totals.get("total_tokens"))
        restarted = previous is not None and current_total < previous["total_tokens"]
        if previous is None or restarted:
            delta = dict(current)
        else:
            delta = {field: max(current[field] - previous[field], 0) for field in TOKEN_FIELDS}
        previous = dict(current)
        previous["total_tokens"] = current_total
        last = info.get("last_token_usage")
        context = as_int(last.get("input_tokens")) if isinstance(last, dict) else as_int(totals.get("input_tokens"))
        timestamp = row.get("timestamp")
        if not rollup.in_window(timestamp):
            continue
        if restarted:
            stats.compactions += 1
        pending.append((delta, context, timestamp, model))
    for delta, context, timestamp, turn_model in pending:
        rollup.bill(stats, turn_model or first_model or UNKNOWN_MODEL, delta, context, timestamp)


def collect_codex(rollup, root):
    if not os.path.isdir(root):
        return
    for path in jsonl_files(root):
        if os.path.basename(path).startswith("rollout-"):
            collect_codex_file(rollup, path)


def omp_session_id(path):
    stem = os.path.basename(path)[: -len(".jsonl")]
    return stem.rsplit("_", 1)[-1] if "_" in stem else stem


def omp_usage_tokens(usage):
    return {
        "input": as_int(usage.get("input")),
        "cache_read": as_int(usage.get("cacheRead")),
        "cache_write": as_int(usage.get("cacheWrite")),
        "output": as_int(usage.get("output")),
    }


def collect_omp_file(rollup, root, path):
    project = os.path.relpath(path, root).split(os.sep)[0]
    stats = rollup.session(OMP, omp_session_id(path), project)
    for row in rollup.rows(path):
        message = row.get("message") or {}
        timestamp = row.get("timestamp") or message.get("timestamp")
        if not rollup.in_window(timestamp):
            continue
        stats.note_worker_origin(row.get("cwd"))
        usage = message.get("usage")
        if not isinstance(usage, dict):
            continue
        tokens = omp_usage_tokens(usage)
        context = tokens["input"] + tokens["cache_read"] + tokens["cache_write"]
        model = message.get("model") or row.get("model") or UNKNOWN_MODEL
        rollup.bill(stats, model, tokens, context, timestamp)


def collect_omp(rollup, root):
    if not os.path.isdir(root):
        return
    for path in jsonl_files(root):
        collect_omp_file(rollup, root, path)


def run_collect(args):
    rollup = Rollup(args.host or socket.gethostname(), args.since)
    collect_claude(rollup, args.claude_root or claude_default_roots())
    collect_codex(rollup, args.codex_root)
    collect_omp(rollup, args.omp_root)
    report = rollup.report(args.now or utc_now_iso(), args.sessions)
    errors = report["errors"]
    if any(errors.values()):
        print("[rollup] errors: {}".format(json.dumps(errors)), file=sys.stderr)
    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w") as handle:
            handle.write(text + "\n")
    else:
        print(text)
    return 0


def empty_totals():
    return {"input": 0, "cache_read": 0, "cache_write": 0, "output": 0, "total": 0, "turns": 0, "sessions": 0}


def machine_totals(report):
    totals = empty_totals()
    for bucket in (report.get("totals_by_tool_origin_model_day") or {}).values():
        for field in TOKEN_FIELDS:
            totals[field] += as_int(bucket.get(field))
            totals["total"] += as_int(bucket.get(field))
        totals["turns"] += as_int(bucket.get("turns"))
    counted = report.get("session_count")
    totals["sessions"] = counted if isinstance(counted, int) else len(report.get("sessions") or [])
    return totals


def load_reports(paths, now, max_age_days):
    loaded = []
    skipped = []
    unreadable = []
    cutoff = now - timedelta(days=max_age_days)
    for path in paths:
        try:
            with open(path) as handle:
                report = json.load(handle)
        except (OSError, json.JSONDecodeError) as err:
            unreadable.append({"path": path, "error": type(err).__name__})
            continue
        generated_at = report.get("generatedAt")
        parsed = parse_iso(generated_at)
        if parsed is None:
            skipped.append({"path": path, "host": report.get("host"), "generatedAt": generated_at, "reason": "unparseable-generatedAt"})
            continue
        if parsed < cutoff:
            skipped.append({"path": path, "host": report.get("host"), "generatedAt": generated_at, "reason": "too-old"})
            continue
        loaded.append((path, report))
    return loaded, skipped, unreadable


def newest_per_host(loaded):
    newest = {}
    for index, (_path, report) in enumerate(loaded):
        host = report.get("host") or "unknown"
        parsed = parse_iso(report.get("generatedAt"))
        current = newest.get(host)
        if current is None or parsed > current[0]:
            newest[host] = (parsed, index)
    keep = {index for _parsed, index in newest.values()}
    kept = [entry for index, entry in enumerate(loaded) if index in keep]
    superseded = [entry for index, entry in enumerate(loaded) if index not in keep]
    return kept, superseded


def merge_reports(paths, now, max_age_days, top):
    loaded, skipped, unreadable = load_reports(paths, now, max_age_days)
    loaded, superseded = newest_per_host(loaded)
    for path, report in superseded:
        skipped.append({"path": path, "host": report.get("host"), "generatedAt": report.get("generatedAt"), "reason": "superseded"})
    machines = {}
    ranked = []
    for _path, report in loaded:
        host = report.get("host") or "unknown"
        machines[host] = machine_totals(report)
        for row in report.get("sessions") or []:
            entry = dict(row)
            entry["host"] = host
            ranked.append(entry)
    ranked.sort(key=lambda row: (-as_int(row.get("total")), str(row.get("host")), str(row.get("session_id"))))
    return {
        "generatedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "maxAgeDays": max_age_days,
        "reports": [{"path": path, "host": report.get("host"), "generatedAt": report.get("generatedAt")} for path, report in loaded],
        "skipped": skipped,
        "unreadable": unreadable,
        "machines": dict(sorted(machines.items())),
        "top_sessions": ranked[:top],
    }


def print_merge_text(merged):
    print("merged {} report(s), skipped {}, unreadable {}".format(
        len(merged["reports"]), len(merged["skipped"]), len(merged["unreadable"])))
    for entry in merged["skipped"]:
        reason = entry["reason"]
        if reason == "too-old":
            detail = "too old, limit {} days".format(merged["maxAgeDays"])
        elif reason == "superseded":
            detail = "superseded by a newer report from the same host"
        else:
            detail = reason
        print("  skipped {} generatedAt={} ({})".format(
            entry.get("host"), entry.get("generatedAt"), detail))
    for entry in merged["unreadable"]:
        print("  unreadable report {} ({})".format(entry["path"], entry["error"]))
    print("")
    print("per-machine totals")
    print("  {:<16} {:>14} {:>14} {:>14} {:>14} {:>14} {:>8} {:>9}".format(
        "host", "input", "cache_read", "cache_write", "output", "total", "turns", "sessions"))
    for host, totals in merged["machines"].items():
        print("  {:<16} {:>14} {:>14} {:>14} {:>14} {:>14} {:>8} {:>9}".format(
            host, totals["input"], totals["cache_read"], totals["cache_write"],
            totals["output"], totals["total"], totals["turns"], totals["sessions"]))
    print("")
    print("top {} sessions".format(len(merged["top_sessions"])))
    for index, row in enumerate(merged["top_sessions"], 1):
        print("  {:>3}. {:<10} {:<40} {:<7} {:<12} {:<16} total={:<14} peak={:<9} turns={:<6} forks={}".format(
            index, row.get("host"), row.get("session_id"), row.get("tool"), row.get("origin"),
            row.get("model"), row.get("total"), row.get("peak_context"), row.get("turns"), row.get("fork_count")))


def run_merge(args):
    now = parse_iso(args.now) or datetime.now(timezone.utc)
    merged = merge_reports(args.reports, now, args.max_age_days, args.top)
    if args.json:
        print(json.dumps(merged, indent=2))
    else:
        print_merge_text(merged)
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description="Per-machine agent token rollup.")
    sub = parser.add_subparsers(dest="command", required=True)

    collect = sub.add_parser("collect", help="Scan local agent logs and print one JSON report.")
    collect.add_argument("--since", required=True, type=iso_day, help="Only count turns on or after this YYYY-MM-DD.")
    collect.add_argument("--host", default="", help="Host label for the report (default: hostname).")
    collect.add_argument("--now", default="", help="Override generatedAt (ISO8601).")
    collect.add_argument("--claude-root", action="append", default=[], help="Claude projects dir; repeatable.")
    collect.add_argument("--codex-root", default=os.path.expanduser("~/.codex/sessions"))
    collect.add_argument("--omp-root", default=os.path.expanduser("~/.omp/agent/sessions"))
    collect.add_argument("--sessions", type=int, default=DEFAULT_SESSION_LIMIT, help="Session records to emit.")
    collect.add_argument("--out", default="", help="Write the report here instead of stdout.")
    collect.set_defaults(func=run_collect)

    merge = sub.add_parser("merge", help="Combine machine reports and rank sessions.")
    merge.add_argument("reports", nargs="+")
    merge.add_argument("--top", type=int, default=DEFAULT_MERGE_TOP)
    merge.add_argument("--max-age-days", type=int, default=DEFAULT_MAX_AGE_DAYS)
    merge.add_argument("--now", default="", help="Override the age comparison time (ISO8601).")
    merge.add_argument("--json", action="store_true")
    merge.set_defaults(func=run_merge)
    return parser


def main(argv):
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
