"""Sanitised, machine-readable pair records.

A record carries everything downstream verification needs and nothing it must
not receive: no transcripts, no credentials, no machine-local absolute paths.
The replayable patches live beside the record under records/patches/.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

SCHEMA = "architecture-memory/pair-record/1"
REQUIRED_ARMS = ("baseline", "treatment")
REQUIRED_ARM_FIELDS = (
    "variant",
    "status",
    "exit_code",
    "wall_seconds",
    "diff_sha256",
    "telemetry",
    "grade",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sanitise_value(value: Any, replacements: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        for needle, token in replacements.items():
            if needle:
                value = value.replace(needle, token)
        return value
    if isinstance(value, dict):
        return {key: sanitise_value(item, replacements) for key, item in value.items()}
    if isinstance(value, list):
        return [sanitise_value(item, replacements) for item in value]
    return value


def write_record(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")


def load_record(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text())


def validate_structure(record: Mapping[str, Any]) -> list[str]:
    """Completeness gate. An incomplete pair is never a verifiable pair."""
    problems: list[str] = []
    if record.get("schema") != SCHEMA:
        problems.append(f"unsupported schema {record.get('schema')!r}")
    for key in ("experiment_id", "pair_id", "created_at", "provenance", "configuration", "arms"):
        if key not in record:
            problems.append(f"missing top-level field {key!r}")
    arms = record.get("arms") or {}
    for arm in REQUIRED_ARMS:
        if arm not in arms:
            problems.append(f"missing arm {arm!r}")
            continue
        for field_name in REQUIRED_ARM_FIELDS:
            if field_name not in arms[arm]:
                problems.append(f"arm {arm!r} missing field {field_name!r}")
    order = record.get("execution_order") or []
    if sorted(order) != sorted(REQUIRED_ARMS):
        problems.append(f"execution_order {order!r} does not cover both arms exactly once")
    provenance = record.get("provenance") or {}
    for key in (
        "source_commit",
        "archive_sha256",
        "manifest_sha256",
        "grader_sha256",
        "structural_delta_sha256",
        "prompt_sha256",
        "runners_sha256",
        "snapshots",
    ):
        if key not in provenance:
            problems.append(f"provenance missing {key!r}")
    return problems


def validate_config_equality(record: Mapping[str, Any]) -> list[str]:
    configuration = record.get("configuration") or {}
    differences = configuration.get("differences")
    if differences is None:
        return ["configuration.differences is absent"]
    if differences:
        return [f"arm configurations differ: {difference}" for difference in differences]
    if configuration.get("equal") is not True:
        return ["configuration.equal is not true"]
    return []


def cost_conclusion(record: Mapping[str, Any]) -> dict[str, Any]:
    """Dollar efficiency is only claimable when both arms reported real costs."""
    costs = {}
    for arm, payload in (record.get("arms") or {}).items():
        telemetry = payload.get("telemetry") or {}
        costs[arm] = {
            "cost_usd": telemetry.get("cost_usd"),
            "cost_telemetry": telemetry.get("cost_telemetry"),
        }
    complete = all(entry["cost_usd"] is not None for entry in costs.values()) and bool(costs)
    return {
        "per_arm": costs,
        "dollar_conclusion_permitted": complete,
        "reason": (
            "both arms reported native cost telemetry"
            if complete
            else "at least one arm reported no dollar cost; token totals are not dollars"
        ),
    }
