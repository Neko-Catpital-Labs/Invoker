#!/usr/bin/env python3
"""Window, filter, and summarize a JSON-lines log file (one JSON object per
line, each with a "time" or "timestamp" field).

Built to replace a real pattern from a live incident: reconstructing an
Invoker owner's timeline from invoker.log took ~15 separate hand-crafted
`grep`+`python3 -c` one-liners over SSH, each re-deriving the same
underlying operations (filter by time window, filter by keyword, group and
count by a field) for a slightly different question. This does all three
in one pass over one read of the file.

Usage:
  analyze-json-log.py <file> [--since ISO8601] [--until ISO8601]
                             [--grep k1,k2,...] [--group-by FIELD]
                             [--field FIELD --top N]
                             [--per-minute]

Options:
  --since/--until   ISO8601 timestamp bounds (inclusive), compared as strings
                     against whatever "time"/"timestamp" field each line has.
  --grep            Comma-separated substrings; a line matches if the raw
                     JSON text contains ANY of them (OR, not AND).
  --group-by        Print a count of lines grouped by this top-level field
                     (dotted paths like "payload.type" are supported).
  --field/--top     Print the N most common values of this field (same
                     dotted-path support), with counts.
  --per-minute      Print a count of matching lines bucketed by minute
                     (uses the same time field as --since/--until).

At least one of --group-by, --field, or --per-minute must be given, or the
script just prints the count of matching lines. All filters compose: lines
must pass --since/--until AND --grep before being counted or grouped.
"""
import argparse
import json
import sys
from collections import Counter


def get_time_field(d):
    return d.get("time") or d.get("timestamp")


def get_path(d, dotted_path):
    cur = d
    for part in dotted_path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def read_matching_lines(path, since, until, grep_terms):
    with open(path) as f:
        for raw_line in f:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            if grep_terms and not any(term in raw_line for term in grep_terms):
                continue
            try:
                d = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            ts = get_time_field(d)
            if since and (not ts or ts < since):
                continue
            if until and (not ts or ts > until):
                continue
            yield d, ts


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path")
    parser.add_argument("--since", default=None)
    parser.add_argument("--until", default=None)
    parser.add_argument("--grep", default=None, help="comma-separated substrings, OR match")
    parser.add_argument("--group-by", default=None, help="dotted field path to group and count by")
    parser.add_argument("--field", default=None, help="dotted field path for --top")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--per-minute", action="store_true", help="count matching lines per minute")
    args = parser.parse_args()

    grep_terms = [t for t in (args.grep or "").split(",") if t] or None

    matched = list(read_matching_lines(args.path, args.since, args.until, grep_terms))
    print(f"matched {len(matched)} line(s)", file=sys.stderr)

    if args.group_by:
        counts = Counter(str(get_path(d, args.group_by)) for d, _ in matched)
        for value, count in counts.most_common():
            print(f"{count}\t{value}")

    if args.field:
        counts = Counter(str(get_path(d, args.field)) for d, _ in matched)
        for value, count in counts.most_common(args.top):
            print(f"{count}\t{value}")

    if args.per_minute:
        buckets = Counter()
        for _, ts in matched:
            if not ts:
                continue
            buckets[ts[:16]] += 1  # YYYY-MM-DDTHH:MM
        for minute in sorted(buckets):
            print(f"{minute}\t{buckets[minute]}")

    if not (args.group_by or args.field or args.per_minute):
        print(len(matched))


if __name__ == "__main__":
    main()
