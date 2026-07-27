#!/usr/bin/env python3
"""Discover complaint candidates from Slack history or deterministic fixtures."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

NEGATIVE_MARKERS = (
    "annoying",
    "bad",
    "broken",
    "complain",
    "doesn't",
    "doesnt",
    "failed",
    "frustrat",
    "hate",
    "issue",
    "not working",
    "pain",
    "problem",
    "still",
    "wrong",
    "wtf",
    "why",
)
PRODUCT_MARKERS = (
    "invoker",
    "slack",
    "receiver",
    "workflow",
    "worker",
    "plan",
    "approval",
    "queue",
    "task",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--author", required=True)
    parser.add_argument("--channel", action="append", default=[])
    parser.add_argument("--since", default="0")
    parser.add_argument("--fixture")
    return parser.parse_args()


def slack_api(token: str, method: str, params: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(
        f"https://slack.com/api/{method}?{urllib.parse.urlencode(params)}",
        headers={"Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.load(response)
    if not payload.get("ok"):
        raise RuntimeError(f"Slack {method} failed: {payload.get('error', 'unknown_error')}")
    return payload


def live_messages(token: str, channels: list[str], since: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    for channel in channels:
        history = slack_api(token, "conversations.history", {"channel": channel, "oldest": since, "limit": "200"})
        for message in history.get("messages", []):
            message["channel"] = channel
            messages.append(message)
            thread_ts = message.get("thread_ts")
            if thread_ts and thread_ts == message.get("ts"):
                replies = slack_api(token, "conversations.replies", {"channel": channel, "ts": thread_ts, "limit": "200"})
                for reply in replies.get("messages", [])[1:]:
                    reply["channel"] = channel
                    messages.append(reply)
    return messages


def normalized(text: str) -> str:
    text = text.lower()
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    return " ".join(text.split())


def complaint_area(text: str) -> str:
    lowered = text.lower()
    if "slack" in lowered or "receiver" in lowered:
        return "slack_receiver"
    if "workflow" in lowered or "task" in lowered:
        return "workflow_control"
    if "plan" in lowered or "approval" in lowered:
        return "planning"
    if "queue" in lowered:
        return "queue"
    return "invoker_general"


def candidate(message: dict[str, Any], author: str) -> dict[str, Any] | None:
    if message.get("user") != author or message.get("bot_id") or message.get("subtype"):
        return None
    text = str(message.get("text") or "").strip()
    lowered = text.lower()
    if not text or not any(marker in lowered for marker in NEGATIVE_MARKERS):
        return None
    if not any(marker in lowered for marker in PRODUCT_MARKERS):
        return None
    thread_ts = str(message.get("thread_ts") or message.get("ts") or "")
    channel = str(message.get("channel") or "")
    fingerprint_source = f"{complaint_area(text)}|{normalized(text)}"
    issue_fingerprint = hashlib.sha256(fingerprint_source.encode()).hexdigest()[:20]
    return {
        "channelId": channel,
        "threadTs": thread_ts,
        "messageTs": str(message.get("ts") or ""),
        "issueFingerprint": issue_fingerprint,
        "productArea": complaint_area(text),
        "text": text,
    }


def main() -> int:
    args = parse_args()
    if args.fixture:
        payload = json.loads(Path(args.fixture).read_text())
        messages = payload.get("messages", payload)
        if not isinstance(messages, list):
            raise RuntimeError("fixture must contain a messages array")
    else:
        token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
        if not token:
            raise RuntimeError("SLACK_BOT_TOKEN is required for live discovery")
        if not args.channel:
            raise RuntimeError("at least one --channel is required for live discovery")
        messages = live_messages(token, args.channel, args.since)

    targets: dict[tuple[str, str, str], dict[str, Any]] = {}
    for message in messages:
        if not isinstance(message, dict):
            continue
        result = candidate(message, args.author)
        if result:
            targets[(result["channelId"], result["threadTs"], result["issueFingerprint"])] = result
    print(json.dumps(sorted(targets.values(), key=lambda row: (row["channelId"], row["threadTs"], row["messageTs"]))))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"slack complaint discovery failed: {error}", file=sys.stderr)
        raise SystemExit(1)
