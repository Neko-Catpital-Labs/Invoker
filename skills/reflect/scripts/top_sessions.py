#!/usr/bin/env python3
"""Rank ALL local sessions (Claude Code, Codex, OMP) by total tokens and
print the tail. Real spend concentrates in a handful of outlier sessions,
not the average one - this is the "check the tails" companion to
token_audit.py, which only looks at a single session at a time.

Usage: top_sessions.py [N]   (default N=5 per tool, 20 overall)

Fixes the same Claude-Code dedup bug as token_audit.py: one JSONL line is
written per content block (thinking/text/tool_use), but every block sharing
a message.id carries the SAME usage snapshot - summing raw lines double or
triple counts. Dedupe by message.id before summing.

Deliberately does not touch Cursor (no local token data - see token_audit.py)
or remote machines (SSH scanning is a separate, explicitly-confirmed step).
"""
import json, sys, glob, os, time, re


def scan_claude(path):
    seen = set()
    tot = 0
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                if '"type":"assistant"' not in line and '"type": "assistant"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message", {})
                mid = msg.get("id")
                if mid in seen:
                    continue
                seen.add(mid)
                u = msg.get("usage", {})
                tot += u.get("input_tokens", 0) + u.get("output_tokens", 0) + \
                       u.get("cache_read_input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
    except (OSError, UnicodeDecodeError):
        return 0
    return tot


def scan_codex(path):
    last = 0
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                if '"token_count"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") != "event_msg":
                    continue
                p = d.get("payload", {})
                if p.get("type") != "token_count":
                    continue
                tu = (p.get("info") or {}).get("total_token_usage")
                if tu:
                    last = tu.get("total_tokens", last)
    except (OSError, UnicodeDecodeError):
        return 0
    return last


def scan_omp(path):
    tot = 0
    cost = 0.0
    try:
        with open(path, errors="ignore") as f:
            for line in f:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") != "message":
                    continue
                u = d.get("message", {}).get("usage")
                if not u:
                    continue
                tot += u.get("totalTokens", 0)
                cost += (u.get("cost") or {}).get("total", 0)
    except (OSError, UnicodeDecodeError):
        return 0, 0.0
    return tot, cost


_TOP_ROW_RE = re.compile(r'^\s*([\d,]+)\s+\[(\w+)\]\s+(\S+)')


def parse_top_block(text):
    """Parse a '=== TOP N SESSIONS OVERALL ===' block - this script's own
    output format - into a list of (tokens, source, path) tuples. Used to
    merge this script's local output with a copy of it run remotely over
    SSH (`ssh ... python3 - N < top_sessions.py`)."""
    rows = []
    in_block = False
    for line in text.splitlines():
        if "SESSIONS OVERALL" in line:
            in_block = True
            continue
        if in_block:
            if line.startswith("===") or line.strip() == "":
                if rows:
                    break
                continue
            m = _TOP_ROW_RE.match(line)
            if m:
                rows.append((int(m.group(1).replace(",", "")), m.group(2), m.group(3)))
    return rows


def merge_cross_machine(local_text, remote_outputs):
    """remote_outputs: {target_name: raw_stdout_text}, where each text
    contains a 'HOSTNAME=<hostname>' line followed by this script's own
    TOP-SESSIONS-OVERALL block (see parse_top_block).

    Dedupes remote targets that resolve to the SAME hostname, keeping only
    the first one seen - two config entries can point at one physical
    machine (verified: this happened with two of this user's real SSH
    targets). Merges with the local ranking into one list, sorted
    descending by tokens: {tokens, source, target, hostname, path}.
    """
    seen_hosts = {}
    merged = []
    for name, text in remote_outputs.items():
        hn_m = re.search(r"HOSTNAME=(\S+)", text)
        hn = hn_m.group(1) if hn_m else name
        if hn in seen_hosts:
            continue
        seen_hosts[hn] = name
        for tok, src, path in parse_top_block(text):
            merged.append({"tokens": tok, "source": src, "target": name, "hostname": hn, "path": path})

    for tok, src, path in parse_top_block(local_text):
        merged.append({"tokens": tok, "source": src, "target": "local", "hostname": "local", "path": path})

    merged.sort(key=lambda r: -r["tokens"])
    return merged


def run_audits(sessions, out_dir=None):
    """Run token_audit.py's per-tool audit in-process on each session and
    return {path: captured_stdout_text}. sessions: list of (kind, path)
    tuples, kind in ('claude', 'codex', 'omp').

    Replaces the ad hoc bash array loop this was originally done with,
    which broke once on an environment-specific `basename`/PATH shell
    quirk mid-run (the progress-echo line failed; the audits themselves
    were fine, but the failure was easy to misread as "everything broke").
    Running audit_*() in-process and capturing stdout sidesteps that whole
    class of shell-portability issue.

    If out_dir is given, also writes each result to
    out_dir/rank{i}_{kind}.txt (0-indexed by input order).
    """
    import io
    from contextlib import redirect_stdout

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import token_audit

    audit_fn = {
        "claude": token_audit.audit_claude,
        "codex": token_audit.audit_codex,
        "omp": token_audit.audit_omp,
    }

    results = {}
    for i, (kind, path) in enumerate(sessions):
        fn = audit_fn.get(kind)
        buf = io.StringIO()
        try:
            if fn is None:
                raise ValueError(f"unknown kind: {kind}")
            with redirect_stdout(buf):
                fn(path)
            out = buf.getvalue()
        except Exception as e:
            out = f"ERROR auditing {path}: {e}"
        results[path] = out
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)
            with open(os.path.join(out_dir, f"rank{i}_{kind}.txt"), "w") as f:
                f.write(out)
    return results


def main():
    top_n = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    t0 = time.time()
    claude_files = glob.glob(os.path.expanduser("~/.claude/projects/*/*.jsonl"))
    codex_files = glob.glob(os.path.expanduser("~/.codex/sessions/*/*/*/*.jsonl"))
    omp_files = glob.glob(os.path.expanduser("~/.omp/agent/sessions/**/*.jsonl"), recursive=True)

    print(f"scanning {len(claude_files)} claude, {len(codex_files)} codex, {len(omp_files)} omp files", file=sys.stderr)

    results = []
    for p in claude_files:
        tot = scan_claude(p)
        if tot:
            results.append(("claude", p, tot, None))
    for p in codex_files:
        tot = scan_codex(p)
        if tot:
            results.append(("codex", p, tot, None))
    for p in omp_files:
        tot, cost = scan_omp(p)
        if tot:
            results.append(("omp", p, tot, cost))

    results.sort(key=lambda r: -r[2])
    print(f"done in {time.time()-t0:.0f}s, {len(results)} sessions with usage data", file=sys.stderr)

    print(f"\n=== TOP {top_n*4} SESSIONS OVERALL (by total tokens) ===")
    for src, p, tot, cost in results[:top_n * 4]:
        costs = f"  (${cost:.2f} OMP-reported)" if cost else ""
        print(f"  {tot:>14,}  [{src}]  {p}{costs}")

    for source in ("claude", "codex", "omp"):
        sub = [r for r in results if r[0] == source]
        print(f"\n=== TOP {top_n} {source.upper()} SESSIONS ===")
        for src, p, tot, cost in sub[:top_n]:
            costs = f"  (${cost:.2f})" if cost else ""
            print(f"  {tot:>14,}  {p}{costs}")


if __name__ == "__main__":
    main()
