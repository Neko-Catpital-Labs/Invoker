#!/usr/bin/env python3
"""Export usage report artifacts to Mixpanel."""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time as dt_time, timedelta, timezone
from pathlib import Path
from typing import Any


def to_int(value: Any, default: int = 0) -> int:
    try:
        if value in ("", None):
            return default
        return int(float(value))
    except (TypeError, ValueError):
        return default


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value in ("", None):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def normalize_preview(text: str, limit: int = 160) -> str:
    text = " ".join(text.split())
    return text[:limit]


def digest_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def default_report_date() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def report_epoch(report_date: str) -> int:
    parsed = datetime.strptime(report_date, "%Y-%m-%d").date()
    return int(datetime.combine(parsed, dt_time(0, 0), tzinfo=timezone.utc).timestamp())


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Invalid JSON at {path}: {exc}") from exc


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def insert_id(report_date: str, family: str, key: str) -> str:
    return f"usage-{report_date}-{family}-{digest_text(f'{report_date}|{family}|{key}')[:24]}"


def session_identity(file_path: str) -> str:
    """Return a stable session identifier across different machine paths."""
    if not file_path:
        return "unknown-session"
    name = Path(file_path).name
    # Most session files are <id>.jsonl; stem gives stable ID.
    stem = Path(name).stem
    if stem:
        return stem
    return digest_text(file_path)[:24]


@dataclass
class ExportEvent:
    family: str
    event: str
    insert_id: str
    properties: dict[str, Any]


class StateStore:
    def __init__(self, path: Path, max_ids: int) -> None:
        self.path = path
        self.max_ids = max_ids
        self.sent: dict[str, int] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text())
        except json.JSONDecodeError:
            return
        raw = payload.get("sent_insert_ids", {})
        if not isinstance(raw, dict):
            return
        for key, value in raw.items():
            if isinstance(key, str):
                self.sent[key] = to_int(value, int(time.time()))

    def has(self, row_id: str) -> bool:
        return row_id in self.sent

    def add_many(self, row_ids: Iterable[str]) -> None:
        now = int(time.time())
        for row_id in row_ids:
            self.sent[row_id] = now
        if len(self.sent) <= self.max_ids:
            return
        ordered = sorted(self.sent.items(), key=lambda item: item[1], reverse=True)
        self.sent = dict(ordered[: self.max_ids])

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"sent_insert_ids": self.sent}, indent=2, sort_keys=True))


def with_common(
    token: str,
    distinct_id: str,
    epoch: int,
    row_id: str,
    report_date: str,
    extra: dict[str, Any],
) -> dict[str, Any]:
    base = {
        "token": token,
        "distinct_id": distinct_id,
        "time": epoch,
        "$insert_id": row_id,
        "report_date": report_date,
    }
    base.update(extra)
    return base


def build_daily_rollups(report: dict[str, Any], audit: dict[str, Any], token: str, distinct_id: str, epoch: int, report_date: str) -> list[ExportEvent]:
    events: list[ExportEvent] = []
    for section_name in ("combined", "codex", "claude"):
        section = report.get(section_name, {})
        totals = section.get("totals", {})
        row_id = insert_id(report_date, "usage_daily_rollup", f"{section_name}:all")
        props = with_common(token, distinct_id, epoch, row_id, report_date, {
            "section": section_name,
            "bucket": "all",
            "estimated_cost_usd": to_float(totals.get("estimated_cost_usd")),
            "session_count": to_int(totals.get("session_count")),
            "planning_session_count": to_int(totals.get("planning_session_count")),
            "execution_session_count": to_int(totals.get("execution_session_count")),
            "effective_input_10pct": to_float(totals.get("effective_input_10pct")),
            "source": "planning_vs_execution_report",
        })
        events.append(ExportEvent("usage_daily_rollup", "usage_daily_rollup", row_id, props))

        for bucket_name in ("planning", "execution"):
            bucket = section.get(bucket_name, {}).get("totals", {})
            row_id = insert_id(report_date, "usage_daily_rollup", f"{section_name}:{bucket_name}")
            props = with_common(token, distinct_id, epoch, row_id, report_date, {
                "section": section_name,
                "bucket": bucket_name,
                "estimated_cost_usd": to_float(bucket.get("estimated_cost_usd")),
                "input_tokens": to_float(bucket.get("input_tokens")),
                "cached_input_tokens": to_float(bucket.get("cached_input_tokens")),
                "output_tokens": to_float(bucket.get("output_tokens")),
                "total_tokens": to_float(bucket.get("total_tokens")),
                "cache_hit_pct": to_float(bucket.get("cache_hit_pct")),
                "source": "planning_vs_execution_report",
            })
            events.append(ExportEvent("usage_daily_rollup", "usage_daily_rollup", row_id, props))

    for provider in ("codex", "claude"):
        dedup_daily = ((audit.get("dedup", {}) or {}).get(provider, {}) or {}).get("ccusageDaily", {})
        row_id = insert_id(report_date, "usage_daily_rollup", f"audit:{provider}:dedup")
        props = with_common(token, distinct_id, epoch, row_id, report_date, {
            "section": provider,
            "bucket": "dedup_daily",
            "input_tokens": to_float(dedup_daily.get("inputTokens")),
            "cached_input_tokens": to_float(dedup_daily.get("cachedInputTokens") or dedup_daily.get("cacheReadTokens")),
            "output_tokens": to_float(dedup_daily.get("outputTokens")),
            "total_tokens": to_float(dedup_daily.get("totalTokens")),
            "estimated_cost_usd": to_float(dedup_daily.get("costUSD") or dedup_daily.get("totalCost")),
            "cache_hit_pct": to_float(dedup_daily.get("cacheHitPct")),
            "source": "cache_hit_audit_report",
        })
        events.append(ExportEvent("usage_daily_rollup", "usage_daily_rollup", row_id, props))
    return events


def build_session_events(rows: list[dict[str, str]], token: str, distinct_id: str, epoch: int, report_date: str) -> list[ExportEvent]:
    events: list[ExportEvent] = []
    for row in rows:
        session_file = row.get("file", "")
        session_id = session_identity(session_file)
        model = row.get("model", "")
        bucket = row.get("bucket", "")
        canonical_key = f"{model}:{bucket}:{session_id}"
        row_id = insert_id(report_date, "usage_session", canonical_key)
        props = with_common(token, distinct_id, epoch, row_id, report_date, {
            "model": model,
            "bucket": bucket,
            "session_id": session_id,
            "session_file": session_file,
            "canonical_key": canonical_key,
            "user_prompts": to_int(row.get("user_prompts")),
            "agent_messages": to_int(row.get("agent_messages")),
            "tool_calls": to_int(row.get("tool_calls")),
            "function_outputs": to_int(row.get("function_outputs")),
            "input_tokens": to_float(row.get("input_tokens")),
            "cached_input_tokens": to_float(row.get("cached_input_tokens")),
            "output_tokens": to_float(row.get("output_tokens")),
            "reasoning_output_tokens": to_float(row.get("reasoning_output_tokens")),
            "total_tokens": to_float(row.get("total_tokens")),
            "cache_hit_pct": to_float(row.get("cache_hit_pct")),
            "estimated_cost_usd": to_float(row.get("estimated_cost_usd")),
            "first_prompt_preview": normalize_preview(row.get("first_prompt_preview", ""), 120),
        })
        events.append(ExportEvent("usage_session", "usage_session", row_id, props))
    return events


def build_prompt_events(
    rows: list[dict[str, str]],
    token: str,
    distinct_id: str,
    epoch: int,
    report_date: str,
    max_unique_prompt_hashes: int,
) -> tuple[list[ExportEvent], int]:
    events: list[ExportEvent] = []
    hashes: set[str] = set()
    skipped = 0
    for row in rows:
        preview = row.get("prompt_preview", "")
        preview_hash = digest_text(preview)
        if preview_hash not in hashes and len(hashes) >= max_unique_prompt_hashes:
            skipped += 1
            continue
        hashes.add(preview_hash)

        session_id = session_identity(row.get("file", ""))
        prompt_index = to_int(row.get("prompt_index"))
        canonical_key = f"{row.get('model','')}:{row.get('bucket','')}:{session_id}:{prompt_index}"
        row_id = insert_id(
            report_date,
            "usage_prompt",
            canonical_key,
        )
        props = with_common(token, distinct_id, epoch, row_id, report_date, {
            "model": row.get("model", ""),
            "bucket": row.get("bucket", ""),
            "session_id": session_id,
            "session_file": row.get("file", ""),
            "prompt_index": prompt_index,
            "prompt_hash": preview_hash,
            "prompt_preview": normalize_preview(preview),
            "canonical_key": canonical_key,
            "tool_calls": to_int(row.get("tool_calls")),
            "agent_messages": to_int(row.get("agent_messages")),
            "response_messages": to_int(row.get("response_messages")),
            "function_outputs": to_int(row.get("function_outputs")),
            "input_tokens_delta": to_float(row.get("input_tokens_delta")),
            "cached_tokens_delta": to_float(row.get("cached_tokens_delta")),
            "output_tokens_delta": to_float(row.get("output_tokens_delta")),
            "reasoning_tokens_delta": to_float(row.get("reasoning_tokens_delta")),
            "total_tokens_delta": to_float(row.get("total_tokens_delta")),
            "cache_hit_pct": to_float(row.get("cache_hit_pct")),
            "estimated_cost_usd": to_float(row.get("estimated_cost_usd")),
        })
        events.append(ExportEvent("usage_prompt", "usage_prompt", row_id, props))
    return events, skipped


def build_tool_events(rows: list[dict[str, str]], token: str, distinct_id: str, epoch: int, report_date: str) -> list[ExportEvent]:
    events: list[ExportEvent] = []
    for row in rows:
        section = row.get("section", "")
        bucket = row.get("bucket", "")
        dimension = row.get("dimension", "")
        name = row.get("name", "")
        canonical_key = f"{section}:{bucket}:{dimension}:{name}"
        row_id = insert_id(report_date, "usage_tool_breakdown", canonical_key)
        props = with_common(token, distinct_id, epoch, row_id, report_date, {
            "section": section,
            "bucket": bucket,
            "dimension": dimension,
            "name": name,
            "canonical_key": canonical_key,
            "calls": to_int(row.get("calls")),
            "calls_share_pct": to_float(row.get("calls_share_pct")),
            "sessions_with_tool": to_int(row.get("sessions_with_tool")),
            "avg_calls_per_using_session": to_float(row.get("avg_calls_per_using_session")),
            "projected_cost_usd": to_float(row.get("projected_cost_usd")),
            "projected_cost_share_pct": to_float(row.get("projected_cost_share_pct")),
        })
        events.append(ExportEvent("usage_tool_breakdown", "usage_tool_breakdown", row_id, props))
    return events


def build_cache_driver_events(report: dict[str, Any], audit: dict[str, Any], token: str, distinct_id: str, epoch: int, report_date: str) -> list[ExportEvent]:
    events: list[ExportEvent] = []
    drivers = report.get("cache_hit_drivers", {}) or {}
    for section_name, detail in drivers.items():
        for row in detail.get("source_shares", []) or []:
            source = str(row.get("source", ""))
            canonical_key = f"{section_name}:source_share:{source}"
            row_id = insert_id(report_date, "usage_cache_driver", canonical_key)
            props = with_common(token, distinct_id, epoch, row_id, report_date, {
                "section": section_name,
                "driver_kind": "source_share",
                "source": source,
                "canonical_key": canonical_key,
                "estimated_repeated_tokens": to_float(row.get("estimated_repeated_tokens")),
                "share_pct": to_float(row.get("share_pct")),
            })
            events.append(ExportEvent("usage_cache_driver", "usage_cache_driver", row_id, props))

    for provider, key in (("codex", "topCodexRepeatedValues"), ("claude", "topClaudeRepeatedValues")):
        for row in ((audit.get("repeatBreakdown", {}) or {}).get(key, []) or []):
            raw_value = str(row.get("value", ""))
            source = str(row.get("source", ""))
            value_hash = digest_text(raw_value)
            canonical_key = f"{provider}:repeated_value:{source}:{value_hash}"
            row_id = insert_id(report_date, "usage_cache_driver", canonical_key)
            props = with_common(token, distinct_id, epoch, row_id, report_date, {
                "section": provider,
                "driver_kind": "repeated_value",
                "source": source,
                "canonical_key": canonical_key,
                "occurrence_count": to_int(row.get("count")),
                "chars": to_int(row.get("chars")),
                "token_estimate_per_value": to_float(row.get("tokenEstimatePerValue")),
                "token_estimate_total": to_float(row.get("tokenEstimateTotal")),
                "shrinkability_score": to_float(row.get("shrinkabilityScore")),
                "value_hash": value_hash,
                "value_preview": normalize_preview(raw_value, 120),
            })
            events.append(ExportEvent("usage_cache_driver", "usage_cache_driver", row_id, props))
    return events


def limit_family(events: list[ExportEvent], cap: int) -> tuple[list[ExportEvent], int]:
    if cap > 0 and len(events) > cap:
        return events[:cap], len(events) - cap
    return events, 0


def auth_header() -> str:
    user = os.getenv("MIXPANEL_SERVICE_ACCOUNT_USER", "")
    password = os.getenv("MIXPANEL_SERVICE_ACCOUNT_PASS", "")
    api_secret = os.getenv("MIXPANEL_API_SECRET", "")
    if user and password:
        raw = f"{user}:{password}".encode("utf-8")
    elif api_secret:
        raw = f"{api_secret}:".encode("utf-8")
    else:
        raise RuntimeError(
            "Missing Mixpanel auth. Set MIXPANEL_API_SECRET or MIXPANEL_SERVICE_ACCOUNT_USER + MIXPANEL_SERVICE_ACCOUNT_PASS"
        )
    return "Basic " + base64.b64encode(raw).decode("ascii")


def send_import_batch(endpoint: str, headers: dict[str, str], batch: list[dict[str, Any]]) -> None:
    body = json.dumps(batch).encode("utf-8")
    request = urllib.request.Request(f"{endpoint}?strict=1", data=body, headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
        payload = response.read().decode("utf-8", errors="replace").strip()
        if response.status >= 400:
            raise RuntimeError(f"Mixpanel import failed status={response.status} body={payload}")


def emit_batches(
    events: list[ExportEvent],
    endpoint: str,
    batch_size: int,
    dry_run: bool,
) -> int:
    if dry_run:
        return len(events)

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": auth_header(),
    }
    sent = 0
    rows = [{"event": event.event, "properties": event.properties} for event in events]
    for idx in range(0, len(rows), batch_size):
        batch = rows[idx : idx + batch_size]
        try:
            send_import_batch(endpoint, headers, batch)
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Network error while sending Mixpanel batch: {exc}") from exc
        sent += len(batch)
    return sent


def build_all_events(
    input_root: Path,
    report_date: str,
    token: str,
    distinct_id: str,
    max_events_per_family: int,
    max_unique_prompt_hashes: int,
) -> tuple[dict[str, list[ExportEvent]], dict[str, int]]:
    audit = read_json(input_root / "cache-hit-audit-report.json")
    report = read_json(input_root / "reports/planning-vs-execution-report.json")
    sessions = read_csv(input_root / "reports/planning-vs-execution-sessions.csv")
    prompts = read_csv(input_root / "reports/planning-vs-execution-prompts.csv")
    tools = read_csv(input_root / "reports/planning-vs-execution-tool-breakdown.csv")

    epoch = report_epoch(report_date)
    families: dict[str, list[ExportEvent]] = {}
    capped: dict[str, int] = {}

    families["usage_daily_rollup"] = build_daily_rollups(report, audit, token, distinct_id, epoch, report_date)
    families["usage_session"] = build_session_events(sessions, token, distinct_id, epoch, report_date)
    prompt_events, prompt_skipped = build_prompt_events(
        prompts, token, distinct_id, epoch, report_date, max_unique_prompt_hashes
    )
    families["usage_prompt"] = prompt_events
    families["usage_tool_breakdown"] = build_tool_events(tools, token, distinct_id, epoch, report_date)
    families["usage_cache_driver"] = build_cache_driver_events(report, audit, token, distinct_id, epoch, report_date)
    if prompt_skipped:
        capped["usage_prompt_prompt_hash_cap"] = prompt_skipped

    for name, rows in list(families.items()):
        limited, dropped = limit_family(rows, max_events_per_family)
        families[name] = limited
        if dropped:
            capped[f"{name}_family_cap"] = dropped
    return families, capped


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export usage artifacts to Mixpanel.")
    parser.add_argument("--input-root", default=".", help="Repository root containing cache-hit report and reports/ outputs.")
    parser.add_argument("--date", default=default_report_date(), help="Report date (YYYY-MM-DD).")
    parser.add_argument("--state-file", default=os.path.expanduser("~/.invoker/usage-metrics/send_state.json"))
    parser.add_argument("--ignore-local-state", action="store_true", help="Do not suppress events using local state file; rely on deterministic $insert_id for Mixpanel dedupe.")
    parser.add_argument("--summary-path", default="")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-events-per-family", type=int, default=to_int(os.getenv("MAX_EVENTS_PER_FAMILY"), 100000))
    parser.add_argument(
        "--max-unique-prompt-hashes",
        type=int,
        default=to_int(os.getenv("MAX_UNIQUE_PROMPT_HASHES_PER_DAY"), 50000),
    )
    parser.add_argument("--max-state-ids", type=int, default=to_int(os.getenv("MAX_STATE_IDS"), 500000))
    parser.add_argument("--batch-size", type=int, default=to_int(os.getenv("MIXPANEL_BATCH_SIZE"), 2000))
    parser.add_argument("--endpoint", default=os.getenv("MIXPANEL_ENDPOINT", "https://api.mixpanel.com/import"))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token = os.getenv("MIXPANEL_TOKEN", "")
    if not token:
        print("Missing required env: MIXPANEL_TOKEN", file=sys.stderr)
        return 1

    distinct_id = os.getenv("MIXPANEL_DISTINCT_ID", "invoker-nightly-local")
    input_root = Path(args.input_root).resolve()
    for required in (
        input_root / "cache-hit-audit-report.json",
        input_root / "reports/planning-vs-execution-report.json",
        input_root / "reports/planning-vs-execution-sessions.csv",
        input_root / "reports/planning-vs-execution-prompts.csv",
        input_root / "reports/planning-vs-execution-tool-breakdown.csv",
    ):
        if not required.exists():
            print(f"Missing required input: {required}", file=sys.stderr)
            return 1

    families, capped = build_all_events(
        input_root=input_root,
        report_date=args.date,
        token=token,
        distinct_id=distinct_id,
        max_events_per_family=args.max_events_per_family,
        max_unique_prompt_hashes=args.max_unique_prompt_hashes,
    )

    state = StateStore(Path(args.state_file).expanduser(), args.max_state_ids)
    to_send: dict[str, list[ExportEvent]] = {}
    duplicate_counts: dict[str, int] = {}
    for family, events in families.items():
        fresh: list[ExportEvent] = []
        dupes = 0
        if args.ignore_local_state:
            fresh = events
        else:
            for event in events:
                if state.has(event.insert_id):
                    dupes += 1
                    continue
                fresh.append(event)
        to_send[family] = fresh
        duplicate_counts[family] = dupes

    ordered = []
    for family in ("usage_daily_rollup", "usage_session", "usage_prompt", "usage_tool_breakdown", "usage_cache_driver"):
        ordered.extend(to_send.get(family, []))

    try:
        sent_count = emit_batches(ordered, args.endpoint, args.batch_size, args.dry_run)
    except RuntimeError as exc:
        print(f"Failed to export Mixpanel events: {exc}", file=sys.stderr)
        return 1

    if not args.dry_run:
        state.add_many(event.insert_id for event in ordered)
        state.save()

    summary = {
        "report_date": args.date,
        "dry_run": args.dry_run,
        "total_events_after_dedupe": sent_count,
        "families": {family: len(rows) for family, rows in to_send.items()},
        "duplicates_suppressed": duplicate_counts,
        "capped": capped,
        "ignore_local_state": args.ignore_local_state,
        "state_file": str(Path(args.state_file).expanduser()),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))
    if args.summary_path:
        Path(args.summary_path).write_text(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
