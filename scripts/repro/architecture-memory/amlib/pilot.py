"""Exactly one real A/B pair.

The pilot refuses to start unless the controls passed against this exact
apparatus, refuses to reuse an attempt key the ledger already holds, and never
retries a trial automatically. An unsuccessful agent result is recorded as the
outcome; it is not a reason to adjust the treatment and rerun.
"""

from __future__ import annotations

import json
import random
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import config as config_mod
from . import manifest, records, snapshots, trials
from .checks import Results
from .context import RunContext
from .ledger import AttemptAlreadyRecorded, AttemptLedger, new_attempt
from .util import sha256_file

CONTROLS_STAMP = "controls-passed.json"


def write_controls_stamp(records_dir: Path, context: RunContext, results: Results) -> Path:
    path = records_dir / CONTROLS_STAMP
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema": "architecture-memory/controls-stamp/1",
                "passed_at": records.now(),
                "provenance": context.provenance(),
                "checks": results.to_json(),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    return path


def require_controls(records_dir: Path, context: RunContext) -> dict[str, Any]:
    path = records_dir / CONTROLS_STAMP
    if not path.exists():
        raise SystemExit(
            "BLOCKED: no controls stamp. Run `run.py self-test` and let it pass "
            "before spending a real trial."
        )
    stamp = json.loads(path.read_text())
    recorded = stamp.get("provenance") or {}
    actual = context.provenance()
    drift = [
        key
        for key in (
            "archive_sha256",
            "manifest_sha256",
            "grader_sha256",
            "structural_delta_sha256",
            "prompt_sha256",
            "runners_sha256",
        )
        if recorded.get(key) != actual.get(key)
    ]
    if drift:
        raise SystemExit(
            "BLOCKED: the apparatus changed since the controls passed "
            f"({', '.join(drift)}). Rerun `run.py self-test`."
        )
    if any(not check["passed"] for check in stamp.get("checks", [])):
        raise SystemExit("BLOCKED: the recorded controls stamp contains failing checks.")
    return stamp


def run(
    context: RunContext,
    *,
    records_dir: Path,
    reports_dir: Path,
    pair_id: str,
    runner_name: str | None,
    budget_usd: float,
    timeout_seconds: int,
    model_override: str | None,
    effort_override: str | None,
    order_seed: int | None,
) -> tuple[dict[str, Any], Results]:
    results = Results("pilot")
    stamp = require_controls(records_dir, context)
    results.add("pilot:controls-stamp", True, f"controls passed at {stamp['passed_at']}")

    registry = config_mod.load_registry(context.root / "runners.json")
    spec = config_mod.resolve_runner(
        registry,
        runner_name,
        budget_usd=budget_usd,
        timeout_seconds=timeout_seconds,
        model_override=model_override,
        effort_override=effort_override,
    )
    results.add(
        "pilot:runner-pinned",
        True,
        f"{spec.name} {spec.version} model={spec.model} effort={spec.effort} "
        f"budget=${spec.budget_usd:.2f} timeout={spec.timeout_seconds}s",
    )

    configuration = {
        variant: config_mod.arm_configuration(spec, variant, variant)
        for variant in snapshots.VARIANTS
    }
    differences = config_mod.configuration_equality(
        configuration["baseline"], configuration["treatment"]
    )
    results.add(
        "pilot:configuration-equal",
        not differences,
        "; ".join(differences) if differences else "both arms share one pinned configuration",
    )
    if differences:
        raise SystemExit("BLOCKED: arm configurations are not equal; no trial was started.")

    seed = order_seed if order_seed is not None else random.SystemRandom().randrange(1 << 30)
    order = list(snapshots.VARIANTS)
    random.Random(seed).shuffle(order)
    results.add("pilot:execution-order", True, f"seed={seed} order={' -> '.join(order)}")

    ledger = AttemptLedger(records_dir / "attempt-ledger.json")
    prompt = context.prompt_path.read_text()
    arms: dict[str, Any] = {}

    for variant in order:
        attempt = new_attempt(manifest.EXPERIMENT_ID, pair_id, variant, variant)
        try:
            ledger.claim(attempt)
        except AttemptAlreadyRecorded as error:
            raise SystemExit(
                f"BLOCKED: {error}\n"
                "  The ledger already holds this attempt. A retried task does not buy "
                "more trials; use a new --pair-id only for a deliberately new pair."
            )
        results.add(f"pilot:attempt-claimed:{variant}", True, attempt.key)

        artifacts = context.run_root / "trials" / f"{pair_id}-{variant}"
        artifacts.mkdir(parents=True, exist_ok=True)
        workspace = context.workspaces_root / f"{pair_id}-{variant}"

        try:
            snapshots.build_trial_workspace(
                context.sources, variant, workspace, context.structural_delta
            )
        except SystemExit as error:
            ledger.finish(attempt.key, state="aborted", outcome=trials.SETUP_FAILURE, note=str(error))
            results.add(f"pilot:setup:{variant}", False, f"setup failure: {error}")
            raise

        assert context.isolation is not None
        trial = trials.run_trial(
            arm=variant,
            variant=variant,
            workspace=workspace,
            prompt=prompt,
            spec=spec,
            isolation=context.isolation,
            artifacts_dir=artifacts,
        )
        ledger.finish(attempt.key, state="finished", outcome=trial.status)
        results.add(
            f"pilot:trial:{variant}",
            True,
            f"status={trial.status} exit={trial.exit_code} "
            f"wall={trial.wall_seconds:.1f}s diffBytes={trial.diff_bytes}",
        )

        patch_name = f"{pair_id}-{variant}.patch"
        stored_patch = records_dir / "patches" / patch_name
        stored_patch.parent.mkdir(parents=True, exist_ok=True)
        if trial.diff_path is not None and trial.diff_bytes:
            shutil.copyfile(trial.diff_path, stored_patch)
        else:
            stored_patch.write_text("")

        grade = context.grader.grade(
            context.evaluator_copies[variant],
            stored_patch if trial.diff_bytes else None,
            label=f"pilot/{variant}",
        )
        results.add(
            f"pilot:graded:{variant}",
            True,
            f"passed={grade.passed} failing="
            + str(sorted(check.check_id for check in grade.checks if not check.passed) or "none"),
        )

        arms[variant] = {
            "variant": variant,
            "status": trial.status,
            "exit_code": trial.exit_code,
            "timed_out": trial.timed_out,
            "wall_seconds": trial.wall_seconds,
            "human_intervention": trial.human_intervention,
            "diff_sha256": sha256_file(stored_patch),
            "diff_bytes": stored_patch.stat().st_size,
            "patch_file": patch_name,
            "telemetry": trial.telemetry,
            "error_tail": trial.error_tail,
            "raw_output_sha256": trial.raw_output_sha256,
            "raw_output_location": "run-root only; transcripts are never committed",
            "grade": grade.to_json(),
        }

    record = {
        "schema": records.SCHEMA,
        "experiment_id": manifest.EXPERIMENT_ID,
        "pair_id": pair_id,
        "created_at": records.now(),
        "host": {"platform": _platform(), "recorded_at": records.now()},
        "provenance": context.provenance(),
        "structural_delta_summary": manifest.STRUCTURAL_DELTA["summary"],
        "configuration": {
            **configuration,
            "equal": not differences,
            "differences": differences,
        },
        "execution_order": order,
        "order_seed": seed,
        "arms": arms,
        "attempts": ledger.entries(),
    }
    record["conclusions"] = _conclusions(record)

    sanitised = records.sanitise_value(record, context.sanitisation_map())
    record_path = records_dir / f"pair-{pair_id}.json"
    records.write_record(record_path, sanitised)
    results.add("pilot:record-written", True, str(record_path.relative_to(context.repo_root)))

    problems = records.validate_structure(sanitised) + records.validate_config_equality(sanitised)
    results.add(
        "pilot:record-complete",
        not problems,
        "; ".join(problems) if problems else "record passes the completeness and equality gates",
    )
    return sanitised, results


def _conclusions(record: dict[str, Any]) -> dict[str, Any]:
    cost = records.cost_conclusion(record)
    outcomes = {
        variant: {
            "trial_status": payload["status"],
            "graded_pass": payload["grade"]["passed"],
            "failing_checks": [
                check["check_id"] for check in payload["grade"]["checks"] if not check["passed"]
            ],
        }
        for variant, payload in record["arms"].items()
    }
    return {
        "per_arm": outcomes,
        "trials_counted": len(record["arms"]),
        "dollar_conclusion_permitted": cost["dollar_conclusion_permitted"],
        "dollar_conclusion_reason": cost["reason"],
        "cost_by_arm": cost["per_arm"],
        "statistical_claim": (
            "None. n=1 per arm establishes that the apparatus executes end to end, "
            "not that either architecture is better."
        ),
    }


def _platform() -> str:
    import platform

    return f"{platform.system()} {platform.release()} {platform.machine()}"
