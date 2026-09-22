"""Re-derive a recorded pair from scratch, with no model call.

verify-recorded rebuilds both snapshots from the recorded commit, re-checks every
provenance hash and the configuration equality claim, then reapplies and regrades
each recorded patch in a fresh evaluator copy. A report file existing on disk
proves nothing here; only a regrade that reproduces the recorded check results does.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

from . import records
from .checks import Results
from .context import RunContext
from .util import sha256_file


def verify_provenance(results: Results, record: Mapping[str, Any], context: RunContext, label: str) -> None:
    recorded = record.get("provenance") or {}
    actual = context.provenance()
    for key in (
        "source_commit",
        "archive_sha256",
        "manifest_sha256",
        "grader_sha256",
        "structural_delta_sha256",
        "prompt_sha256",
        "runners_sha256",
    ):
        results.add(
            f"verify:{label}:provenance:{key}",
            recorded.get(key) == actual.get(key),
            f"recorded={_short(recorded.get(key))} rebuilt={_short(actual.get(key))}",
        )
    recorded_snapshots = recorded.get("snapshots") or {}
    for variant, values in sorted(actual["snapshots"].items()):
        recorded_variant = recorded_snapshots.get(variant) or {}
        results.add(
            f"verify:{label}:snapshot:{variant}",
            recorded_variant.get("source_tree_sha256") == values["source_tree_sha256"]
            and recorded_variant.get("target_file_sha256") == values["target_file_sha256"],
            f"recorded={_short(recorded_variant.get('source_tree_sha256'))} "
            f"rebuilt={_short(values['source_tree_sha256'])}",
        )
    results.add(
        f"verify:{label}:provenance:variants-differ",
        actual["snapshots"]["baseline"]["target_file_sha256"]
        != actual["snapshots"]["treatment"]["target_file_sha256"],
        "baseline and treatment differ at the structural-delta target file",
    )


def verify_completeness(results: Results, record: Mapping[str, Any], label: str) -> bool:
    problems = records.validate_structure(record)
    results.add(
        f"verify:{label}:record-complete",
        not problems,
        "; ".join(problems) if problems else "both arms present with required fields",
    )
    config_problems = records.validate_config_equality(record)
    results.add(
        f"verify:{label}:configuration-equal",
        not config_problems,
        "; ".join(config_problems) if config_problems else "arm configurations match",
    )
    return not problems and not config_problems


def verify_regrade(
    results: Results,
    record: Mapping[str, Any],
    context: RunContext,
    patches_dir: Path,
    label: str,
) -> None:
    for arm, payload in sorted((record.get("arms") or {}).items()):
        patch_name = payload.get("patch_file")
        recorded_grade = payload.get("grade") or {}
        if not patch_name:
            results.add(f"verify:{label}:regrade:{arm}", False, "no patch_file recorded")
            continue
        patch_path = patches_dir / patch_name
        if not patch_path.exists():
            results.add(f"verify:{label}:regrade:{arm}", False, f"missing replay patch {patch_name}")
            continue
        results.add(
            f"verify:{label}:patch-hash:{arm}",
            sha256_file(patch_path) == payload.get("diff_sha256"),
            f"recorded={_short(payload.get('diff_sha256'))} onDisk={_short(sha256_file(patch_path))}",
        )
        variant = payload.get("variant", arm)
        copy = context.evaluator_copies[variant]
        regraded = context.grader.grade(
            copy, patch_path if payload.get("diff_bytes") else None, label=f"{label}:{arm}"
        )
        recorded_checks = {
            check["check_id"]: check["passed"] for check in recorded_grade.get("checks", [])
        }
        actual_checks = {check.check_id: check.passed for check in regraded.checks}
        mismatches = [
            f"{check_id}: recorded={recorded_checks.get(check_id)} regraded={passed}"
            for check_id, passed in sorted(actual_checks.items())
            if recorded_checks.get(check_id) != passed
        ]
        results.add(
            f"verify:{label}:regrade:{arm}",
            not mismatches and regraded.passed == recorded_grade.get("passed"),
            "; ".join(mismatches)
            or f"regrade reproduced recorded result (passed={regraded.passed})",
        )


def verify_ledger(results: Results, record: Mapping[str, Any], ledger_entries: Mapping[str, Any], label: str) -> None:
    pair_id = record.get("pair_id")
    expected = {f"{record.get('experiment_id')}|{pair_id}|{arm}" for arm in records.REQUIRED_ARMS}
    present = expected & set(ledger_entries)
    terminal = [
        key for key in sorted(present) if ledger_entries[key].get("state") in {"finished", "aborted"}
    ]
    results.add(
        f"verify:{label}:ledger",
        present == expected and len(terminal) == len(expected),
        f"{len(terminal)}/{len(expected)} attempts recorded terminal in the ledger",
    )


def verify_cost_claim(results: Results, record: Mapping[str, Any], label: str) -> None:
    conclusion = records.cost_conclusion(record)
    recorded = (record.get("conclusions") or {}).get("dollar_conclusion_permitted")
    results.add(
        f"verify:{label}:cost-claim",
        recorded == conclusion["dollar_conclusion_permitted"],
        conclusion["reason"],
    )


def _short(value: Any) -> str:
    text = str(value)
    return text[:12] if len(text) > 12 else text
