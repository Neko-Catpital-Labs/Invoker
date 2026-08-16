#!/usr/bin/env python3
"""Multi-conversation, time-windowed corpus scan across Claude Code and Codex
sessions - local machine plus (optionally) every SSH remote target in
~/.invoker/config.json.

`token_audit.py` and `top_sessions.py` both operate on ONE transcript, or
rank ALL transcripts by raw token count - neither answers "show me every
conversation, on every machine, that touched topic X in the last N hours."
That question is exactly what a recurring-failure investigation needs (e.g.
"why do these e2e PRs keep thrashing") and reflect's step 1 ("take the most
recently modified file") cannot see it: the signal here is the SHAPE of the
whole corpus (a burst of near-simultaneous sessions across 6 machines) not
any single transcript's content.

Usage:
    corpus_scan.py <keyword-regex> [--hours N] [--include-remote HOST,...|all]
                    [--pull-dir DIR] [--out FILE]

    corpus_scan.py "e2e|playwright|ci-regression" --hours 24
        Local-only: lists matching files, no SSH, nothing pulled.

    corpus_scan.py "e2e|playwright|ci-regression" --hours 24 --include-remote all
        Prints the EXACT read-only find+grep command for every remote target
        in ~/.invoker/config.json and STOPS without running it. Re-run with
        --confirm-remote-scan once a human has actually seen that command -
        this script will not SSH anywhere on its own recognizance. This
        mirrors token_audit.py's `remotes` mode, which lists target names but
        never scans, and reflect's own documented rule: "a confirmation to
        scan remote hosts, given before the exact command exists, authorizes
        the scope, not the payload."

    corpus_scan.py "e2e|playwright|ci-regression" --hours 24 --include-remote all --confirm-remote-scan
        Actually runs the scan+pull shown above, then audits everything.

Two hard-won lessons baked in here (both cost real wall-clock time building
this the first time, manually, before it was a script):

1. NEVER run a Python regex with unbounded quantifiers (`.{0,80}...` etc.)
   against a whole multi-MB file read into one string. A single JSONL line
   can legitimately be hundreds of KB (a big tool result), and re.findall
   across that is not "slow", it can peg one core for 15+ minutes with ZERO
   observable progress on a 144-file batch. Use `grep -c` (a subprocess,
   real C implementation) for keyword/signal counting instead - see
   `_grep_count` below. Reserve Python parsing for the JSONL structure
   itself (token_audit.py's line-by-line json.loads, which is bounded per
   message, not per file).

2. Don't pipe a long-running driver through `| tail -N` (no `-f`) if you
   want to see it's still alive - plain `tail` buffers until EOF, so a slow
   script LOOKS identical to a hung one until it finishes or crashes. This
   script prints one progress line per file to stderr, unbuffered - run it
   with `python3 -u` or redirect straight to a file you tail with `-f`.

This script never SSHes without --confirm-remote-scan, and it never edits
any skill file - it only produces `<out>.json` (structured, one row per
matched session, for the Judgment/Tooling/Cost/History/Divergent lenses in
step 3 of SKILL.md to consume) and a stdout summary table bucketed by host
and 15-minute window, which is where a dispatch-burst pattern actually shows
up visually.
"""
import argparse, io, json, os, re, shlex, subprocess, sys, time
from collections import defaultdict
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import token_audit

INVOKER_CONFIG = os.path.expanduser("~/.invoker/config.json")
SSH_KEY_DEFAULT = os.path.expanduser("~/.ssh/id_ed25519")


def _grep_count(pattern, path):
    """Fast, bounded-memory keyword count via the real grep binary. Never
    read the whole file into a Python string for pattern matching - see
    module docstring, lesson 1."""
    try:
        r = subprocess.run(["grep", "-c", "-i", "-E", pattern, path],
                            capture_output=True, text=True, timeout=20)
        return int(r.stdout.strip() or 0)
    except Exception:
        return None


def _mtime_minutes(hours):
    """find(1)'s -mtime only accepts whole days on both BSD and GNU find -
    a fractional value (e.g. for a 24h/1.0 window that still isn't exactly
    a day, or any sub-day window) silently matches nothing on macOS's bfs.
    -mmin (minutes) accepts a plain integer on every find implementation
    this script targets, so always convert here instead."""
    return max(1, round(hours * 60))


def _grep_match_files(root_glob_cmd, pattern, hours):
    """Local discovery: files under a find(1) expression, modified within
    `hours`, whose content matches `pattern` (grep -l, not read-into-Python)."""
    find_cmd = root_glob_cmd + ["-mmin", f"-{_mtime_minutes(hours)}"]
    try:
        found = subprocess.run(find_cmd, capture_output=True, text=True, timeout=30).stdout.splitlines()
    except Exception:
        return []
    matched = []
    for p in found:
        p = p.strip()
        if not p:
            continue
        r = subprocess.run(["grep", "-l", "-i", "-E", pattern, p], capture_output=True, text=True, timeout=15)
        if r.returncode == 0:
            matched.append(p)
    return matched


def discover_local(pattern, hours):
    """Returns [(kind, path, 'local')] for Claude Code + Codex sessions on
    this machine modified in the last `hours` hours whose content matches
    `pattern`."""
    home = os.path.expanduser("~")
    claude_root = os.path.join(home, ".claude", "projects")
    codex_root = os.path.join(home, ".codex", "sessions")
    results = []
    if os.path.isdir(claude_root):
        for p in _grep_match_files(["find", claude_root, "-iname", "*.jsonl"], pattern, hours):
            results.append(("claude", p, "local"))
    if os.path.isdir(codex_root):
        for p in _grep_match_files(["find", codex_root, "-iname", "rollout-*.jsonl"], pattern, hours):
            results.append(("codex", p, "local"))
    return results


def load_remote_targets():
    if not os.path.exists(INVOKER_CONFIG):
        return {}
    with open(INVOKER_CONFIG) as f:
        cfg = json.load(f)
    return cfg.get("remoteTargets") or {}


def remote_scan_command(target_cfg, pattern, hours):
    """The EXACT read-only remote command this script would run for one
    target - built once here so "show the command" and "run the command"
    can never drift apart."""
    host = target_cfg["host"]
    user = target_cfg.get("user", "root")
    key = target_cfg.get("sshKeyPath", SSH_KEY_DEFAULT)
    mmin = _mtime_minutes(hours)
    remote_script = (
        f'find ~/.claude/projects -iname "*.jsonl" -mmin -{mmin} 2>/dev/null | '
        f'xargs -I{{}} sh -c \'grep -lqiE "{pattern}" "{{}}" 2>/dev/null && echo CLAUDE {{}} $(stat -f%z "{{}}" 2>/dev/null || stat -c%s "{{}}")\' 2>/dev/null; '
        f'find ~/.codex/sessions -iname "rollout-*.jsonl" -mmin -{mmin} 2>/dev/null | '
        f'xargs -I{{}} sh -c \'grep -lqiE "{pattern}" "{{}}" 2>/dev/null && echo CODEX {{}} $(stat -f%z "{{}}" 2>/dev/null || stat -c%s "{{}}")\' 2>/dev/null'
    )
    ssh_cmd = ["ssh", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", "-i", key, f"{user}@{host}", remote_script]
    return ssh_cmd


def scan_and_pull_remote(name, target_cfg, pattern, hours, pull_dir):
    ssh_cmd = remote_scan_command(target_cfg, pattern, hours)
    try:
        r = subprocess.run(ssh_cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        print(f"  {name}: SSH FAILED: {e}", file=sys.stderr)
        return []
    lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    host = target_cfg["host"]
    user = target_cfg.get("user", "root")
    key = target_cfg.get("sshKeyPath", SSH_KEY_DEFAULT)
    outdir = os.path.join(pull_dir, name)
    os.makedirs(outdir, exist_ok=True)
    pulled = []
    for line in lines:
        parts = line.split()
        if len(parts) < 2:
            continue
        kind_raw, remote_path = parts[0], parts[1]
        kind = "claude" if kind_raw == "CLAUDE" else "codex"
        dest = os.path.join(outdir, f"{kind_raw}__{os.path.basename(remote_path)}")
        rr = subprocess.run(["scp", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", "-i", key,
                              f"{user}@{host}:{remote_path}", dest], capture_output=True, text=True, timeout=30)
        if rr.returncode == 0 and os.path.exists(dest):
            pulled.append((kind, dest, name))
    print(f"  {name}: {len(pulled)} file(s) pulled", file=sys.stderr)
    return pulled


def audit_one(kind, path, extra_signals):
    """Run the matching in-process audit_* from token_audit.py (no subprocess
    spawn per file - this is what made the 144-file batch fast once switched
    over) and layer on fast grep-based extra signal counts."""
    fn = {"claude": token_audit.audit_claude, "codex": token_audit.audit_codex}.get(kind)
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            fn(path)
        out = buf.getvalue()
    except Exception as e:
        out = f"AUDIT_ERROR: {e}"

    entry = {"kind": kind, "path": path}
    m_err = re.search(r"tool errors: (\d+)", out)
    entry["tool_errors"] = int(m_err.group(1)) if m_err else None
    m_tot = re.search(r"total=([\d,]+)", out)
    entry["total_tokens"] = m_tot.group(1) if m_tot else None
    m_redun = re.search(r"redundant re-reads.*?: (\d+)", out)
    entry["redundant_reads"] = int(m_redun.group(1)) if m_redun else None

    for sig_name, pattern in extra_signals.items():
        entry[sig_name] = _grep_count(pattern, path)

    m_ts = re.search(r"(20\d{2}-\d{2}-\d{2}T[\d\-]+)", os.path.basename(path))
    entry["ts"] = m_ts.group(1).replace("-", ":", 2).replace("-", " ", 1) if m_ts else None
    entry["ts_raw"] = m_ts.group(1) if m_ts else None
    return entry


DEFAULT_SIGNALS = {
    "test_failures": r"[0-9]+ failed",
    "test_timeout": r"Test timeout of|Timeout [0-9]+ms exceeded",
    "gh_pr_activity": r"gh pr (close|create|merge)",
    "infra_errors": r"ECONNREFUSED|EADDRINUSE|ENOSPC",
    "flaky_or_retry": r"flaky|still fail|not stable|retry",
}


def bucket_summary(results, bucket_minutes=15):
    """Group by (host, time-bucket) - this is where a dispatch-burst pattern
    (many machines starting sessions within the same few minutes) becomes
    visible at a glance instead of buried in 100+ rows."""
    buckets = defaultdict(list)
    for e in results:
        if not e.get("ts_raw"):
            continue
        # ts_raw like 2026-08-15T07-37-08-...; bucket by hour:floor(min/N)
        m = re.match(r"(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})", e["ts_raw"])
        if not m:
            continue
        day, hh, mm = m.groups()
        bucket = int(mm) // bucket_minutes * bucket_minutes
        key = (day, hh, f"{bucket:02d}", e.get("host") or e.get("kind"))
        buckets[key].append(e)
    return buckets


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pattern", help="grep -E pattern to match session content against, e.g. 'e2e|playwright|ci-regression'")
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--include-remote", default=None, help="comma-separated remoteTargets names, or 'all'")
    ap.add_argument("--confirm-remote-scan", action="store_true",
                     help="actually run the SSH commands (must be shown to the user first)")
    ap.add_argument("--pull-dir", default=os.path.join("/tmp", "reflect-corpus-pull"))
    ap.add_argument("--out", default="corpus_scan_results.json")
    ap.add_argument("--extra-signal", action="append", default=[],
                     help="name=pattern, repeatable, added on top of DEFAULT_SIGNALS")
    args = ap.parse_args()

    signals = dict(DEFAULT_SIGNALS)
    for spec in args.extra_signal:
        if "=" in spec:
            n, p = spec.split("=", 1)
            signals[n] = p

    t0 = time.time()
    files = [(k, p, h) for k, p, h in discover_local(args.pattern, args.hours)]
    print(f"local: {len(files)} matching file(s) in the last {args.hours}h", file=sys.stderr)

    targets = load_remote_targets()
    if args.include_remote:
        names = list(targets.keys()) if args.include_remote == "all" else args.include_remote.split(",")
        names = [n for n in names if n in targets]
        if not args.confirm_remote_scan:
            print(f"\n{len(names)} remote target(s) would be scanned. EXACT command per target "
                  f"(shown, not run - re-run with --confirm-remote-scan once a human has seen this):\n")
            for n in names:
                cmd = remote_scan_command(targets[n], args.pattern, args.hours)
                print(f"--- {n} ---")
                print(shlex.join(cmd))
            sys.exit(0)
        print(f"\nscanning + pulling from {len(names)} remote target(s)...", file=sys.stderr)
        for n in names:
            files.extend(scan_and_pull_remote(n, targets[n], args.pattern, args.hours, args.pull_dir))

    print(f"auditing {len(files)} file(s)...", file=sys.stderr)
    results = []
    for i, (kind, path, host) in enumerate(files):
        entry = audit_one(kind, path, signals)
        entry["host"] = host
        results.append(entry)
        if (i + 1) % 10 == 0:
            print(f"  processed {i+1}/{len(files)}", file=sys.stderr)

    with open(args.out, "w") as f:
        json.dump(results, f, indent=1)
    print(f"done in {time.time()-t0:.0f}s -> {args.out}", file=sys.stderr)

    print(f"\n=== corpus summary: {len(results)} sessions matching /{args.pattern}/ in last {args.hours}h ===")
    by_host = defaultdict(int)
    for e in results:
        by_host[e.get("host")] += 1
    for h, n in sorted(by_host.items(), key=lambda x: -x[1]):
        print(f"  {h}: {n} session(s)")

    print("\n=== dispatch-burst check: sessions bucketed by 15-min window x host ===")
    print("(many hosts/rows lighting up in the SAME bucket = concurrent fan-out, not independent work)")
    buckets = bucket_summary(results)
    for key in sorted(buckets.keys()):
        day, hh, mm, host = key
        n = len(buckets[key])
        marker = "  <-- burst" if n >= 2 else ""
        print(f"  {day} {hh}:{mm}  {host:24s} {n} session(s){marker}")


if __name__ == "__main__":
    main()
