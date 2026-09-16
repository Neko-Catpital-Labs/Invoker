#!/usr/bin/env python3
"""Mine Codex CLI sessions for insight: workflow, model, token spend, and prompt type."""
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from datetime import datetime, timezone

CWD_WORKTREE = re.compile(r"experiment-(wf-\d+-\d+)-(.+)-g\d+\.t\d+\.a-")
CWD_SCRATCH = re.compile(r"/tmp/invoker-scratch-[^/]+$")
CWD_MERGE = re.compile(r"merge-clones/(?:gate-|approve-|consolidate-)?(?:__merge__)?(wf-\d+-\d+)")
FILENAME_TS = re.compile(r"rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-")


def default_session_dir():
    return os.path.expanduser("~/.codex/sessions")


def parse_filename_timestamp(fname):
    m = FILENAME_TS.match(fname)
    if not m:
        return None
    return f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}"


def parse_filename_date(fname):
    m = FILENAME_TS.match(fname)
    if not m:
        return None
    return m.group(1)


def classify(cwd):
    m = CWD_SCRATCH.search(cwd)
    if m:
        return None, "scratch"
    m = CWD_MERGE.search(cwd)
    if m:
        return m.group(1), "merge-clone"
    m = CWD_WORKTREE.search(cwd)
    if m:
        return m.group(1), m.group(2)
    return None, "unknown"


def user_text(payload):
    content = payload.get("content", "")
    text = ""
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict):
                text += (item.get("text") or "") + " "
    elif isinstance(content, str):
        text = content
    if not text:
        text = payload.get("message", "")
    return text.strip()


def classify_prompt(text):
    if "worker-lifecycle finding" in text:
        return "worker-start"
    if "repair-filings finding" in text:
        return "repair-filing-delete"
    if "e2e-regression-watch finding" in text:
        return "e2e-regression-needs-human"
    return "unknown"


def summarize(path):
    session_file = os.path.basename(path)
    date = parse_filename_date(session_file)
    timestamp = parse_filename_timestamp(session_file)
    workflow_id = None
    task_type = None
    model = None
    total_tokens = None
    plan_type = None
    prompt = ""
    prompt_type = "unknown"
    note = None
    user_messages = []

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
                p = e.get("payload") or {}
                if t == "session_meta" and workflow_id is None:
                    cwd = p.get("cwd", "")
                    workflow_id, task_type = classify(cwd)
                if t == "turn_context":
                    model = p.get("model") or model
                if t == "event_msg" and p.get("type") == "token_count":
                    info = p.get("info") or {}
                    tu = info.get("total_token_usage") or {}
                    total_tokens = tu.get("total_tokens")
                    rl = info.get("rate_limits") or {}
                    primary = rl.get("primary") or {}
                    plan_type = rl.get("plan_type") or plan_type
                if t == "response_item" and p.get("role") == "user":
                    text = user_text(p)
                    if text:
                        user_messages.append(text)

        if not user_messages:
            prompt = ""
        else:
            prompt = next(
                (text for text in user_messages if "Assume zero prior context" in text or "Investigate a production" in text),
                user_messages[0],
            )
    except OSError as ex:
        note = f"read-error:{ex}"

    if prompt:
        prompt_type = classify_prompt(prompt)

    return {
        "session_file": session_file,
        "date": date,
        "timestamp": timestamp,
        "workflow_id": workflow_id,
        "task_type": task_type,
        "model": model,
        "total_tokens": total_tokens,
        "plan_type": plan_type,
        "prompt_type": prompt_type,
        "prompt_snippet": prompt[:300],
        "note": note,
    }


def audit(session_dir, cutoff=None):
    results = []
    if not os.path.isdir(session_dir):
        return results
    for root, _dirs, files in os.walk(session_dir):
        for f in files:
            if not (f.startswith("rollout-") and f.endswith(".jsonl")):
                continue
            path = os.path.join(root, f)
            row = summarize(path)
            if cutoff and row["timestamp"] and row["timestamp"] < cutoff:
                continue
            results.append(row)
    return sorted(results, key=lambda r: r["session_file"])


def aggregate(rows, key):
    out = defaultdict(lambda: {"sessions": 0, "tokens": 0})
    for r in rows:
        k = r.get(key) or "unknown"
        v = r.get("total_tokens") or 0
        out[k]["sessions"] += 1
        out[k]["tokens"] += v
    return dict(out)


def html_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def build_html(rows, title, generated_at):
    total_sessions = len(rows)
    with_tokens = [r for r in rows if r.get("total_tokens") is not None]
    total_tokens = sum(r["total_tokens"] for r in with_tokens)
    by_type = aggregate(rows, "task_type")
    by_date = aggregate(rows, "date")
    by_model = aggregate(rows, "model")
    by_prompt = aggregate(rows, "prompt_type")
    top = sorted(rows, key=lambda r: -(r.get("total_tokens") or 0))[:50]

    def cards():
        return (
            f'<div class="card"><div class="label">Sessions</div><div class="value">{total_sessions:,}</div></div>'
            f'<div class="card"><div class="label">Sessions with token data</div><div class="value">{len(with_tokens):,}</div></div>'
            f'<div class="card"><div class="label">Missing token data</div><div class="value">{total_sessions - len(with_tokens):,}</div></div>'
            f'<div class="card"><div class="label">Measured tokens</div><div class="value">{total_tokens:,}</div></div>'
            f'<div class="card"><div class="label">Unique task types</div><div class="value">{len(by_type):,}</div></div>'
            f'<div class="card"><div class="label">Unique models</div><div class="value">{len(by_model):,}</div></div>'
        )

    def table(data, headers):
        head = "".join(f"<th>{h}</th>" for h in headers)
        body = ""
        for k, v in sorted(data.items(), key=lambda x: -x[1]["tokens"]):
            body += f'<tr><td>{html_escape(str(k))}</td><td>{v["sessions"]:,}</td><td>{v["tokens"]:,}</td></tr>'
        return f'<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>'

    top_rows = ""
    for r in top:
        snippet = html_escape(r.get("prompt_snippet", ""))
        top_rows += (
            f'<tr><td>{html_escape(str(r.get("date")))}</td>'
            f'<td>{html_escape(str(r.get("task_type")))}</td>'
            f'<td>{html_escape(str(r.get("model")))}</td>'
            f'<td>{r.get("total_tokens") or 0:,}</td>'
            f'<td>{html_escape(str(r.get("prompt_type")))}</td>'
            f'<td title="{snippet}">{snippet[:120]}</td></tr>'
        )

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html_escape(title)}</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 40px; color: #1a1a1a; background: #fafafa; }}
.container {{ max-width: 1200px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.1); }}
h1 {{ margin-top: 0; }}
h2 {{ border-bottom: 1px solid #e0e0e0; padding-bottom: 8px; margin-top: 40px; }}
.summary {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; margin: 20px 0; }}
.card {{ background: #f4f4f4; padding: 16px; border-radius: 6px; }}
.card .label {{ font-size: 12px; color: #666; text-transform: uppercase; }}
.card .value {{ font-size: 24px; font-weight: 600; margin-top: 4px; }}
table {{ width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }}
th {{ text-align: left; background: #f0f0f0; padding: 8px; border-bottom: 2px solid #ccc; }}
td {{ padding: 8px; border-bottom: 1px solid #eee; }}
tr:nth-child(even) {{ background: #fafafa; }}
</style>
</head>
<body>
<div class="container">
<h1>{html_escape(title)}</h1>
<p>Generated: {html_escape(generated_at)}</p>
<div class="summary">{cards()}</div>
<h2>By task type</h2>
{table(by_type, ["task_type", "sessions", "tokens"])}
<h2>By date</h2>
{table(by_date, ["date", "sessions", "tokens"])}
<h2>By model</h2>
{table(by_model, ["model", "sessions", "tokens"])}
<h2>By prompt type</h2>
{table(by_prompt, ["prompt_type", "sessions", "tokens"])}
<h2>Top 50 sessions by tokens</h2>
<table><thead><tr><th>date</th><th>task_type</th><th>model</th><th>tokens</th><th>prompt_type</th><th>prompt snippet</th></tr></thead><tbody>{top_rows}</tbody></table>
</div>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(
        description="Mine Codex session JSONL files for workflow, token, and prompt insight.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--session-dir", default=None, help="Directory to scan recursively for rollout-*.jsonl files")
    parser.add_argument("--cutoff", default=None, help="ISO8601 date (YYYY-MM-DD); skip earlier sessions")
    parser.add_argument("--scratch-only", action="store_true", help="Only include scratch sessions")
    parser.add_argument("--format", choices=["json", "html"], default="json", help="Output format")
    parser.add_argument("--output", default=None, help="Output file (default: stdout)")
    parser.add_argument("--title", default="Codex session insight", help="HTML report title")
    args = parser.parse_args()

    session_dir = args.session_dir or default_session_dir()
    rows = audit(session_dir, args.cutoff)

    if args.scratch_only:
        rows = [r for r in rows if r.get("task_type") == "scratch"]

    if args.format == "json":
        output = json.dumps(rows, indent=2)
    else:
        generated_at = datetime.now(timezone.utc).isoformat() + " UTC"
        output = build_html(rows, args.title, generated_at)

    if args.output:
        with open(args.output, "w") as fh:
            fh.write(output)
    else:
        sys.stdout.write(output)


if __name__ == "__main__":
    main()
