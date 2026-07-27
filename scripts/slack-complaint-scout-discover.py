#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

DEFAULT_AUTHOR = "U0ALGQ64HMF"
ATTEMPT_CAP = 3
MAX_LOG_BYTES = 512 * 1024
MAX_SOURCE_BYTES = 320 * 1024

COMPLAINT_RE = re.compile(
    r"\b(broken|breaks|bug|crash(?:es|ed|ing)?|error|fail(?:s|ed|ing)?|hang(?:s|ing)?|"
    r"missing|never|not working|doesn'?t work|stuck|silent|wrong|regression|timeout|"
    r"timed out|cannot|can'?t|unable)\b",
    re.IGNORECASE,
)
TECHNICAL_RE = re.compile(
    r"\b(slack|invoker|workflow|task|thread|receiver|manager|approve|approval|cancel|"
    r"draft|plan|button|socket|do1|digitalocean|channel|event|log|cli|api)\b|"
    r"(?:packages|scripts|docs)/[\w./-]+|\b[A-Z][A-Z0-9_]{3,}\b|`[^`]+`",
    re.IGNORECASE,
)

SOURCE_HINTS = {
    "slack": [
        "packages/surfaces/src/slack/slack-surface.ts",
        "packages/slack-manager/src/index.ts",
    ],
    "approve": ["packages/surfaces/src/slack/slack-surface.ts"],
    "approval": ["packages/surfaces/src/slack/slack-surface.ts"],
    "cancel": ["packages/surfaces/src/slack/slack-surface.ts"],
    "draft": [
        "packages/surfaces/src/slack/slack-surface.ts",
        "packages/data-store/src/slack-plan-draft-repository.ts",
    ],
    "plan": [
        "packages/surfaces/src/slack/slack-surface.ts",
        "packages/planning-core/src/planning-review.ts",
    ],
    "receiver": ["packages/slack-manager/src/index.ts"],
    "manager": ["packages/slack-manager/src/index.ts"],
    "workflow": [
        "packages/surfaces/src/surface.ts",
        "packages/slack-manager/src/workflow-ops.ts",
    ],
    "task": ["packages/surfaces/src/surface.ts"],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bounded Slack complaint scout discovery/action pass.")
    parser.add_argument("--self-test", action="store_true", help="run the deterministic scout proxy")
    parser.add_argument("--act", action="store_true", help="post the draft/blocker and update the ledger")
    parser.add_argument("--json", action="store_true", help="emit machine-readable decision JSON")
    parser.add_argument("--bridge", default="packages/slack-manager/dist/index.js", help="built slack-manager bridge entrypoint")
    parser.add_argument("--repo", default=os.getcwd(), help="local repo path or repo URL for generated child plans")
    parser.add_argument("--state-file", default=str(Path.home() / ".invoker" / "slack-complaint-scout-ledger.jsonl"))
    parser.add_argument("--author", default=DEFAULT_AUTHOR)
    parser.add_argument("--channel", action="append", default=[])
    parser.add_argument("--target", action="append", default=[])
    parser.add_argument("--window-hours", type=int, default=24)
    parser.add_argument("--history-limit", type=int, default=100)
    parser.add_argument("--max-pages", type=int, default=2)
    return parser.parse_args()


def normalize_text(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"https?://\S+", " ", text)
    return re.sub(r"\s+", " ", text).strip().lower()


def issue_fingerprint(text: str) -> str:
    normalized = normalize_text(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def target_key(channel_id: str, thread_ts: str, fingerprint: str) -> str:
    return f"{channel_id}|{thread_ts}|{fingerprint}"


def is_dm_channel(channel_id: str) -> bool:
    return channel_id.startswith("D")


def read_env_file() -> str:
    explicit = os.environ.get("INVOKER_SLACK_OWNER_ENV")
    legacy = Path.home() / ".invoker" / ".slack-owner.env"
    canonical = Path.home() / ".invoker" / ".env"
    env_path = Path(explicit) if explicit else legacy if legacy.exists() else canonical
    if env_path.exists():
        for raw_line in env_path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            if key and key not in os.environ:
                os.environ[key] = value.strip().strip("'\"")
    return str(env_path)


def resolve_channels(cli_channels: list[str]) -> list[str]:
    channels = cli_channels or [
        value for value in [
            os.environ.get("SLACK_LOBBY_CHANNEL_ID"),
            os.environ.get("SLACK_CHANNEL_ID"),
        ] if value
    ]
    seen: set[str] = set()
    allowlist: list[str] = []
    for channel_id in channels:
        channel_id = channel_id.strip()
        if not channel_id:
            continue
        if is_dm_channel(channel_id):
            raise SystemExit(f"Refusing to read DM channel {channel_id}; pass only allowlisted public/private channels.")
        if channel_id not in seen:
            seen.add(channel_id)
            allowlist.append(channel_id)
    if not allowlist:
        raise SystemExit("No Slack channel allowlist provided. Pass --channel or set SLACK_LOBBY_CHANNEL_ID/SLACK_CHANNEL_ID.")
    return allowlist


class SlackClient:
    def __init__(self, token: str):
        self.token = token

    def api(self, method: str, payload: dict) -> dict:
        data = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"https://slack.com/api/{method}",
            data=data,
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        for attempt in range(2):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    body = json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt == 0:
                    time.sleep(int(error.headers.get("Retry-After", "1")))
                    continue
                raise RuntimeError(f"Slack API {method} failed with HTTP {error.code}") from error
            if not body.get("ok"):
                raise RuntimeError(f"Slack API {method} failed: {body.get('error', 'unknown_error')}")
            return body
        raise RuntimeError(f"Slack API {method} failed after retry")


def candidate_from_message(channel_id: str, message: dict, author: str) -> dict | None:
    if message.get("user") != author:
        return None
    text = str(message.get("text") or "").strip()
    ts = str(message.get("ts") or "").strip()
    if not text or not ts:
        return None
    thread_ts = str(message.get("thread_ts") or ts)
    fingerprint = issue_fingerprint(text)
    return {
        "channelId": channel_id,
        "threadTs": thread_ts,
        "messageTs": ts,
        "issueFingerprint": fingerprint,
        "targetKey": target_key(channel_id, thread_ts, fingerprint),
        "text": text,
    }


def discover_history(client: SlackClient, channels: list[str], author: str, args: argparse.Namespace) -> list[dict]:
    candidates: list[dict] = []
    oldest = str(time.time() - max(args.window_hours, 1) * 3600)
    for channel_id in channels:
        cursor = None
        for _page in range(max(args.max_pages, 1)):
            payload = {
                "channel": channel_id,
                "limit": max(1, min(args.history_limit, 200)),
                "oldest": oldest,
            }
            if cursor:
                payload["cursor"] = cursor
            body = client.api("conversations.history", payload)
            for message in body.get("messages", []):
                candidate = candidate_from_message(channel_id, message, author)
                if candidate:
                    candidates.append(candidate)
            cursor = body.get("response_metadata", {}).get("next_cursor")
            if not cursor:
                break
    return dedupe_candidates(candidates)


def discover_targets(client: SlackClient, targets: list[str], channels: list[str], author: str) -> list[dict]:
    channel_set = set(channels)
    candidates: list[dict] = []
    for target in targets:
        try:
            channel_id, thread_ts, fingerprint = target.split("|", 2)
        except ValueError:
            raise SystemExit(f"Invalid --target {target!r}; expected channelId|threadTs|issueFingerprint.")
        if channel_id not in channel_set:
            raise SystemExit(f"Refusing target outside --channel allowlist: {target}")
        if is_dm_channel(channel_id):
            raise SystemExit(f"Refusing DM target: {target}")
        replies = fetch_author_replies(client, channel_id, thread_ts, author)
        for message in replies:
            candidate = candidate_from_message(channel_id, message, author)
            if candidate and candidate["issueFingerprint"] == fingerprint:
                candidates.append(candidate)
                break
        if not any(c["targetKey"] == target for c in candidates):
            candidates.append({
                "channelId": channel_id,
                "threadTs": thread_ts,
                "messageTs": thread_ts,
                "issueFingerprint": fingerprint,
                "targetKey": target,
                "text": "",
            })
    return dedupe_candidates(candidates)


def fetch_author_replies(client: SlackClient, channel_id: str, thread_ts: str, author: str) -> list[dict]:
    cursor = None
    messages: list[dict] = []
    for _page in range(2):
        payload = {"channel": channel_id, "ts": thread_ts, "limit": 100}
        if cursor:
            payload["cursor"] = cursor
        body = client.api("conversations.replies", payload)
        for message in body.get("messages", []):
            if message.get("user") == author:
                messages.append(message)
        cursor = body.get("response_metadata", {}).get("next_cursor")
        if not cursor:
            break
    return messages


def dedupe_candidates(candidates: list[dict]) -> list[dict]:
    deduped: dict[str, dict] = {}
    for candidate in candidates:
        deduped.setdefault(candidate["targetKey"], candidate)
    return list(deduped.values())


def read_ledger(path: str) -> list[dict]:
    ledger_path = Path(path)
    if not ledger_path.exists():
        return []
    rows: list[dict] = []
    for line in ledger_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            rows.append({"status": "invalid", "raw": line})
    return rows


def ledger_state(records: list[dict], key: str) -> dict:
    matching = [row for row in records if row.get("targetKey") == key]
    terminal = next((row for row in reversed(matching) if row.get("status") in {"terminal", "drafted"}), None)
    attempts = max([0] + [int(row.get("attempt") or 0) for row in matching])
    return {
        "attempts": attempts,
        "terminal": terminal,
        "capped": attempts >= ATTEMPT_CAP and terminal is None,
    }


def append_ledger(path: str, entry: dict) -> None:
    ledger_path = Path(path)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    with ledger_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def complaint_blocker(text: str) -> str | None:
    normalized = normalize_text(text)
    if not normalized:
        return "insufficient evidence: the allowlisted message text was empty or unavailable"
    if not COMPLAINT_RE.search(normalized):
        return "insufficient evidence: the allowlisted message has no concrete failure signal"
    if not TECHNICAL_RE.search(text):
        return "insufficient evidence: the message describes frustration but no failing surface, command, log, or source clue"
    return None


def evidence_terms(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{3,}", normalize_text(text))
    priority = ["slack", "invoker", "workflow", "task", "approve", "cancel", "draft", "thread", "receiver", "manager"]
    terms: list[str] = []
    for term in priority + words:
        if term not in terms:
            terms.append(term)
        if len(terms) >= 12:
            break
    return terms


def inspect_thread(client: SlackClient, candidate: dict, author: str) -> dict:
    messages = fetch_author_replies(client, candidate["channelId"], candidate["threadTs"], author)
    if not messages and candidate["text"]:
        messages = [{"text": candidate["text"], "ts": candidate["messageTs"], "user": author}]
    return {
        "authorMessageCount": len(messages),
        "authorTexts": [str(message.get("text") or "").strip() for message in messages if message.get("text")],
    }


def cutoff_iso(window_hours: int) -> str:
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(hours=max(window_hours, 1))
    return cutoff.isoformat(timespec="seconds").replace("+00:00", "Z")


def inspect_manager_context(candidate: dict, window_hours: int) -> dict:
    home = Path.home()
    db_paths = [
        home / ".invoker" / "slack-manager" / "slack-manager.db",
        home / ".invoker" / "invoker.db",
    ]
    context: dict[str, list[dict] | list[str]] = {
        "launchContexts": [],
        "workflowChannels": [],
        "activityLog": [],
        "notes": [],
    }
    for db_path in db_paths:
        if not db_path.exists():
            continue
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
            conn.row_factory = sqlite3.Row
        except sqlite3.Error as error:
            context["notes"].append(f"{db_path}: unavailable: {error}")
            continue
        try:
            tables = set(
                row["name"] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            )
            if "slack_launch_contexts" in tables:
                for row in conn.execute(
                    "SELECT thread_ts, repo_url, harness_preset, working_dir, requested_by, lobby_channel_id "
                    "FROM slack_launch_contexts WHERE thread_ts = ? LIMIT 3",
                    (candidate["threadTs"],),
                ).fetchall():
                    context["launchContexts"].append(dict(row))
            if "workflow_channels" in tables:
                for row in conn.execute(
                    "SELECT workflow_id, channel_id, requested_by, lobby_channel_id, lobby_thread_ts, harness_preset, repo_url "
                    "FROM workflow_channels WHERE channel_id = ? OR lobby_thread_ts = ? LIMIT 5",
                    (candidate["channelId"], candidate["threadTs"]),
                ).fetchall():
                    context["workflowChannels"].append(dict(row))
            if "activity_log" in tables:
                like_channel = f"%{candidate['channelId']}%"
                like_thread = f"%{candidate['threadTs']}%"
                for row in conn.execute(
                    "SELECT timestamp, source, level, message FROM activity_log "
                    "WHERE timestamp >= ? AND (message LIKE ? OR message LIKE ?) "
                    "ORDER BY timestamp DESC LIMIT 8",
                    (cutoff_iso(window_hours), like_channel, like_thread),
                ).fetchall():
                    context["activityLog"].append(dict(row))
        except sqlite3.Error as error:
            context["notes"].append(f"{db_path}: query failed: {error}")
        finally:
            conn.close()
    return context


def parse_line_timestamp(line: str) -> dt.datetime | None:
    match = re.search(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?", line)
    if not match:
        return None
    raw = match.group(0).replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed


def inspect_log_files(candidate: dict, terms: list[str], window_hours: int) -> dict:
    home = Path.home()
    paths = [
        home / ".invoker" / "gui.log",
        home / ".invoker" / "slack-manager.log",
    ] + list((home / ".invoker" / "slack-manager").glob("*.log"))
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(hours=max(window_hours, 1))
    needles = [candidate["channelId"], candidate["threadTs"], candidate["issueFingerprint"]] + terms
    hits: list[dict] = []
    inspected: list[str] = []
    for path in paths:
        if not path.exists() or not path.is_file():
            continue
        inspected.append(str(path))
        data = path.read_bytes()[-MAX_LOG_BYTES:].decode("utf-8", errors="replace")
        for line in data.splitlines():
            parsed_ts = parse_line_timestamp(line)
            if parsed_ts and parsed_ts < cutoff:
                continue
            lower = line.lower()
            if any(needle and needle.lower() in lower for needle in needles):
                hits.append({"path": str(path), "line": line[-500:]})
                if len(hits) >= 8:
                    return {"inspected": inspected, "hits": hits}
    return {"inspected": inspected, "hits": hits}


def repo_root(repo: str) -> Path:
    path = Path(repo)
    if path.exists() and path.is_dir():
        return path.resolve()
    return Path.cwd().resolve()


def detect_repo_url(repo: str) -> str:
    path = Path(repo)
    if re.match(r"^(https?|ssh)://|^git@", repo):
        return repo
    if path.exists() and path.is_dir():
        try:
            return subprocess.check_output(
                ["git", "remote", "get-url", "origin"],
                cwd=path,
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=5,
            ).strip()
        except Exception:
            return "."
    return repo


def explicit_source_paths(text: str) -> list[str]:
    return re.findall(r"\b(?:packages|scripts|docs|plans)/[A-Za-z0-9_./-]+\b", text)


def inspect_source(repo: str, text: str, terms: list[str]) -> dict:
    root = repo_root(repo)
    selected: list[str] = []
    lowered = normalize_text(text)
    for key, paths in SOURCE_HINTS.items():
        if key in lowered:
            selected.extend(paths)
    selected.extend(explicit_source_paths(text))
    selected = list(dict.fromkeys(selected))[:8]
    inspected: list[dict] = []
    for rel_path in selected:
        path = root / rel_path
        if not path.exists() or not path.is_file():
            inspected.append({"path": rel_path, "exists": False, "matches": []})
            continue
        data = path.read_bytes()[:MAX_SOURCE_BYTES].decode("utf-8", errors="replace")
        matches: list[str] = []
        for line_no, line in enumerate(data.splitlines(), 1):
            lower = line.lower()
            if any(term.lower() in lower for term in terms):
                matches.append(f"{line_no}: {line.strip()[:220]}")
            if len(matches) >= 4:
                break
        inspected.append({"path": rel_path, "exists": True, "matches": matches})
    return {"root": str(root), "files": inspected}


def summarize_list(values: list[str], limit: int = 3, item_limit: int = 240) -> str:
    cleaned = [re.sub(r"\s+", " ", value).strip()[:item_limit] for value in values if value.strip()]
    if not cleaned:
        return "none"
    suffix = "" if len(cleaned) <= limit else f" (+{len(cleaned) - limit} more)"
    return " | ".join(cleaned[:limit]) + suffix


def yaml_quote(value: str) -> str:
    return json.dumps(value)


def yaml_block(value: str, indent: int) -> str:
    prefix = " " * indent
    lines = value.rstrip().splitlines() or [""]
    return "\n".join(prefix + line for line in lines)


def build_child_plan(candidate: dict, evidence: dict, repo: str) -> str:
    repo_url = detect_repo_url(repo)
    source_files = [
        item["path"] for item in evidence["source"].get("files", [])
        if item.get("exists")
    ]
    evidence_text = evidence["thread"]["authorTexts"][0] if evidence["thread"]["authorTexts"] else candidate["text"]
    log_summary = summarize_list([hit["line"] for hit in evidence["logs"].get("hits", [])], 2)
    context_summary = summarize_list(
        [json.dumps(row, sort_keys=True) for row in evidence["context"].get("launchContexts", [])]
        + [json.dumps(row, sort_keys=True) for row in evidence["context"].get("workflowChannels", [])],
        2,
    )
    source_summary = summarize_list(
        [f"{item['path']} -> {summarize_list(item.get('matches', []), 2, 180)}" for item in evidence["source"].get("files", [])],
        4,
    )
    description = f"""Goal: Fix the narrow Invoker issue evidenced by Edbert's allowlisted Slack complaint in {candidate['channelId']} thread {candidate['threadTs']}.
Review claim: The implementation addresses the concrete failing behavior described in that source thread without broad Slack refactors.
Safety invariant: Use only the evidence included here and the named source files; do not scan unrelated Slack channels, DMs, or authors, and do not auto-submit child workflows.
Evidence: targetKey={candidate['targetKey']}; complaint="{evidence_text[:500]}"; authorMessages={evidence['thread']['authorMessageCount']}; timeWindowLogHits={log_summary}; mappedContext={context_summary}; sourceInspection={source_summary}.
Files: {', '.join(source_files) if source_files else 'packages/surfaces/src/slack/slack-surface.ts, packages/slack-manager/src/index.ts'}.
Change types: Narrow bug fix and focused regression tests only.
Acceptance criteria: Reproduce or explain the failing Slack behavior from the evidence, implement the smallest fix, prove no silent child workflow submission is introduced, and run focused package tests."""
    prompt = f"""Assume no prior context. Start from this evidence-backed Slack complaint target:
- targetKey: {candidate['targetKey']}
- channelId: {candidate['channelId']}
- threadTs: {candidate['threadTs']}
- issueFingerprint: {candidate['issueFingerprint']}
- Edbert allowlisted message: {evidence_text[:900]}

Inspect the named source files and local tests first. Fix only the narrow failing behavior supported by the evidence. Preserve packages/slack-manager/src/index.ts as the persistent Slack event receiver and packages/surfaces/src/slack/slack-surface.ts as the Slack approval-flow owner. Do not add a daemon, do not edit ~/.invoker/config.json, do not implement custom Slack buttons, and do not start or submit any workflow except through the existing human Approve action on a Slack draft."""
    return "\n".join([
        f"name: {yaml_quote('Slack complaint scout ' + candidate['issueFingerprint'])}",
        f"repoUrl: {yaml_quote(repo_url)}",
        "onFinish: none",
        "mergeMode: manual",
        "tasks:",
        "  - id: handle-slack-complaint",
        "    description: |",
        yaml_block(description, 6),
        "    prompt: |",
        yaml_block(prompt, 6),
        "    dependencies: []",
        "",
    ])


def decide(candidate: dict, evidence: dict, repo: str) -> dict:
    blocker = complaint_blocker(candidate["text"] or summarize_list(evidence["thread"]["authorTexts"], 1))
    if blocker:
        return {
            "kind": "blocker",
            "reason": blocker,
            "message": f"Slack complaint scout terminal blocker for `{candidate['targetKey']}`: {blocker}.",
        }
    source_files = evidence["source"].get("files", [])
    if not any(item.get("exists") for item in source_files):
        reason = "human-only blocker: the complaint is concrete, but no relevant source path could be mapped from the evidence"
        return {
            "kind": "blocker",
            "reason": reason,
            "message": f"Slack complaint scout terminal blocker for `{candidate['targetKey']}`: {reason}.",
        }
    return {
        "kind": "actionable",
        "planText": build_child_plan(candidate, evidence, repo),
        "message": f"Prepared Slack plan draft for `{candidate['targetKey']}`.",
    }


def build_evidence(client: SlackClient, candidate: dict, author: str, args: argparse.Namespace) -> dict:
    text_for_terms = candidate["text"]
    thread = inspect_thread(client, candidate, author)
    if thread["authorTexts"] and not text_for_terms:
        text_for_terms = thread["authorTexts"][0]
    terms = evidence_terms(text_for_terms)
    return {
        "thread": thread,
        "logs": inspect_log_files(candidate, terms, args.window_hours),
        "context": inspect_manager_context(candidate, args.window_hours),
        "source": inspect_source(args.repo, text_for_terms, terms),
    }


def select_candidate(candidates: list[dict], records: list[dict]) -> tuple[dict | None, dict | None]:
    for candidate in candidates:
        state = ledger_state(records, candidate["targetKey"])
        if state["terminal"]:
            continue
        if state["capped"]:
            return candidate, {
                "kind": "blocker",
                "reason": "human-only blocker: scout retry cap reached after three attempts for this stable target key",
                "message": f"Slack complaint scout terminal blocker for `{candidate['targetKey']}`: human-only blocker: scout retry cap reached after three attempts for this stable target key.",
            }
        return candidate, None
    return None, None


def post_terminal_blocker(client: SlackClient, candidate: dict, decision: dict) -> str | None:
    body = client.api("chat.postMessage", {
        "channel": candidate["channelId"],
        "thread_ts": candidate["threadTs"],
        "text": decision["message"],
    })
    return body.get("ts")


def stage_plan_draft(bridge: str, payload: dict) -> dict:
    bridge_path = Path(bridge)
    if not bridge_path.exists():
        raise RuntimeError(f"Slack draft bridge is not built at {bridge}. Run the driver without --skip-local-check first.")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".json", delete=False) as handle:
        json.dump(payload, handle)
        payload_path = handle.name
    try:
        proc = subprocess.run(
            ["node", str(bridge_path), "--stage-plan-draft", payload_path],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=False,
        )
    finally:
        Path(payload_path).unlink(missing_ok=True)
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip()[-1000:]
        raise RuntimeError(f"Slack draft bridge failed: {detail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("Slack draft bridge returned non-JSON output") from error


def act_on_decision(client: SlackClient, candidate: dict, decision: dict, args: argparse.Namespace, records: list[dict]) -> dict:
    state = ledger_state(records, candidate["targetKey"])
    attempt = state["attempts"] + 1
    base_entry = {
        "targetKey": candidate["targetKey"],
        "channelId": candidate["channelId"],
        "threadTs": candidate["threadTs"],
        "issueFingerprint": candidate["issueFingerprint"],
        "attempt": attempt,
        "createdAt": dt.datetime.now(dt.UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
    }
    if decision["kind"] == "blocker":
        message_ts = post_terminal_blocker(client, candidate, decision)
        entry = {**base_entry, "status": "terminal", "reason": decision["reason"], "messageTs": message_ts}
        append_ledger(args.state_file, entry)
        return {**decision, "ledger": entry}
    payload = {
        "channelId": candidate["channelId"],
        "threadTs": candidate["threadTs"],
        "planText": decision["planText"],
        "repoUrl": detect_repo_url(args.repo),
        "workingDir": str(repo_root(args.repo)),
        "harnessPreset": os.environ.get("INVOKER_SLACK_DEFAULT_PRESET", "codex"),
        "requestedBy": args.author,
    }
    try:
        bridge_result = stage_plan_draft(args.bridge, payload)
    except Exception as error:
        entry = {**base_entry, "status": "draft_failed", "reason": str(error)[-500:]}
        append_ledger(args.state_file, entry)
        raise
    entry = {**base_entry, "status": "drafted", "draft": bridge_result}
    append_ledger(args.state_file, entry)
    return {**decision, "draft": bridge_result, "ledger": entry}


def live_pass(args: argparse.Namespace) -> int:
    env_path = read_env_file()
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise SystemExit(f"Missing SLACK_BOT_TOKEN (looked in {env_path})")
    channels = resolve_channels(args.channel)
    client = SlackClient(token)
    records = read_ledger(args.state_file)
    candidates = discover_targets(client, args.target, channels, args.author) if args.target else discover_history(client, channels, args.author, args)
    candidates = [candidate for candidate in candidates if COMPLAINT_RE.search(candidate.get("text", ""))]
    candidate, forced_decision = select_candidate(candidates, records)
    if not candidate:
        result = {
            "ok": True,
            "status": "idle",
            "channels": channels,
            "author": args.author,
            "candidateCount": len(candidates),
        }
        print(json.dumps(result, indent=2) if args.json else "slack complaint scout: no eligible target")
        return 0
    evidence = build_evidence(client, candidate, args.author, args)
    decision = forced_decision or decide(candidate, evidence, args.repo)
    result = {
        "ok": True,
        "status": decision["kind"],
        "target": candidate,
        "decision": {key: value for key, value in decision.items() if key != "planText"},
        "evidence": evidence,
    }
    if args.act:
        action = act_on_decision(client, candidate, decision, args, records)
        result["action"] = {key: value for key, value in action.items() if key != "planText"}
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"slack complaint scout: {result['status']} {candidate['targetKey']}")
    return 0


def self_test() -> int:
    messages = [
        {"user": DEFAULT_AUTHOR, "text": "Slack approve button is broken in the plan draft thread", "ts": "1.0001"},
        {"user": "U_OTHER", "text": "Slack approve button is broken in the plan draft thread", "ts": "1.0002"},
        {"user": DEFAULT_AUTHOR, "text": "Slack approve button is broken in the plan draft thread", "ts": "1.0001"},
    ]
    candidates = dedupe_candidates([
        candidate for candidate in [
            candidate_from_message("C_ALLOWED", message, DEFAULT_AUTHOR) for message in messages
        ] if candidate
    ])
    assert len(candidates) == 1
    assert candidates[0]["targetKey"].startswith("C_ALLOWED|1.0001|")
    try:
        resolve_channels(["D_NOT_ALLOWED"])
    except SystemExit:
        pass
    else:
        raise AssertionError("DM channel was not rejected")
    blocker = complaint_blocker("this is frustrating")
    assert blocker and "no concrete failure signal" in blocker
    actionable_blocker = complaint_blocker(candidates[0]["text"])
    assert actionable_blocker is None
    with tempfile.TemporaryDirectory() as tempdir:
        ledger = Path(tempdir) / "ledger.jsonl"
        key = candidates[0]["targetKey"]
        for attempt in range(1, ATTEMPT_CAP + 1):
            append_ledger(str(ledger), {"targetKey": key, "attempt": attempt, "status": "draft_failed"})
        state = ledger_state(read_ledger(str(ledger)), key)
        assert state["capped"] is True
        append_ledger(str(ledger), {"targetKey": key, "attempt": 4, "status": "terminal", "reason": "exact blocker"})
        state = ledger_state(read_ledger(str(ledger)), key)
        assert state["terminal"]["reason"] == "exact blocker"
    root = Path.cwd()
    evidence = {
        "thread": {"authorMessageCount": 1, "authorTexts": [candidates[0]["text"]]},
        "logs": {"hits": [], "inspected": []},
        "context": {"launchContexts": [], "workflowChannels": [], "activityLog": [], "notes": []},
        "source": inspect_source(str(root), candidates[0]["text"], evidence_terms(candidates[0]["text"])),
    }
    decision = decide(candidates[0], evidence, str(root))
    assert decision["kind"] == "actionable"
    assert "planText" in decision
    assert "plan_draft_approve" not in decision["planText"]
    print("slack complaint scout deterministic proxy: ok")
    return 0


def main() -> int:
    args = parse_args()
    if args.self_test:
        return self_test()
    return live_pass(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
