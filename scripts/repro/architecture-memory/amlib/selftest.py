"""Controls that must pass before any real trial is permitted.

Wrong controls must fail and correct controls must pass, in BOTH variants,
before the pilot is allowed to spend a model call. Isolation, process timeouts,
record rejection, and replay are all exercised here rather than assumed.
"""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

from . import config as config_mod
from . import isolation as isolation_mod
from . import manifest, records, snapshots, verify
from .checks import Results
from .context import RunContext
from .grading import GradeResult
from .ledger import Attempt, AttemptAlreadyRecorded, AttemptLedger, new_attempt
from .util import run_command, tree_file_hashes

CONTROL_EXPECTATIONS = {
    "unedited": {"expect_pass": False, "must_fail": set(manifest.GRADER_CHECK_IDS)},
    "control-noop": {"expect_pass": False, "must_fail": set(manifest.GRADER_CHECK_IDS)},
    "control-stub-only": {
        "expect_pass": False,
        "must_fail": {
            "check:routes-through-command-service",
            "check:closes-review-before-mutation",
            "check:runs-scoped-dispatch-and-topup",
            "check:propagates-command-service-failure",
        },
    },
    "control-missing-invariant": {
        "expect_pass": False,
        "must_fail": {"check:closes-review-before-mutation"},
        "must_pass": {
            "check:typecheck",
            "check:existing-facade-suite",
            "check:exposes-close-idle-task",
            "check:routes-through-command-service",
            "check:runs-scoped-dispatch-and-topup",
        },
    },
    "control-wrong-envelope": {
        "expect_pass": False,
        "must_fail": {"check:routes-through-command-service"},
        "must_pass": {
            "check:typecheck",
            "check:existing-facade-suite",
            "check:exposes-close-idle-task",
            "check:closes-review-before-mutation",
        },
    },
    "gold": {
        "expect_pass": True,
        "must_pass": set(manifest.COMMAND_CHECK_IDS) | set(manifest.GRADER_CHECK_IDS),
    },
}

CONTROL_ORDER = [
    "unedited",
    "control-noop",
    "control-stub-only",
    "control-missing-invariant",
    "control-wrong-envelope",
    "gold",
]


def run(context: RunContext) -> Results:
    results = Results("self-test")
    _isolation_controls(results, context)
    _harness_control(results, context)
    _timeout_control(results, context)
    _snapshot_controls(results, context)
    grades = _grader_controls(results, context)
    _trial_workspace_controls(results, context)
    _record_controls(results, context)
    _ledger_controls(results, context)
    _replay_control(results, context, grades)
    _grader_immutability_control(results, context)
    return results


def _isolation_controls(results: Results, context: RunContext) -> None:
    active = context.isolation
    results.add(
        "selftest:isolation-mechanism-present",
        active is not None,
        active.mechanism if active else context.isolation_error,
    )
    if active is None:
        return

    grader_file = context.root / "grader" / "checks" / "close-idle-task.checks.test.ts"
    gold_patch = context.root / "grader" / "patches" / "baseline" / "gold.patch"
    for name, target in (
        ("protected-grader-checks-read-denied", grader_file),
        ("protected-gold-patch-read-denied", gold_patch),
        ("protected-run-root-read-denied", context.sources.archive),
    ):
        outcome = isolation_mod.probe_read_denied(active, target)
        results.add(
            f"selftest:{name}",
            not outcome.ok,
            f"exit={outcome.exit_code} {outcome.tail(120) or 'denied'}",
        )

    listing = isolation_mod.probe_list_denied(active, context.root / "grader" / "patches")
    results.add(
        "selftest:protected-gold-directory-list-denied",
        not listing.ok,
        f"exit={listing.exit_code} {listing.tail(120) or 'denied'}",
    )

    memory_denied: list[str] = []
    memory_leaked: list[str] = []
    for target in active.user_memory_paths:
        probe = (
            isolation_mod.probe_list_denied(active, Path(target))
            if Path(target).is_dir()
            else isolation_mod.probe_read_denied(active, Path(target))
        )
        (memory_denied if not probe.ok else memory_leaked).append(Path(target).name)
    results.add(
        "selftest:user-memory-read-denied",
        bool(memory_denied) and not memory_leaked,
        f"denied={len(memory_denied)} leaked={memory_leaked or 'none'}",
    )

    write_probe = isolation_mod.probe_write_denied(active, grader_file)
    results.add(
        "selftest:protected-grader-write-denied",
        not write_probe.ok,
        f"exit={write_probe.exit_code} {write_probe.tail(120) or 'denied'}",
    )

    scratch = context.workspaces_root / "isolation-probe-workspace"
    scratch.mkdir(parents=True, exist_ok=True)
    allowed = isolation_mod.probe_workspace_allowed(active, scratch)
    results.add(
        "selftest:trial-workspace-writable",
        allowed.ok and allowed.stdout.strip() == "ok",
        f"exit={allowed.exit_code}",
    )
    shutil.rmtree(scratch, ignore_errors=True)


def _harness_control(results: Results, context: RunContext) -> None:
    """The registered harness must resolve, pin, and start under the same wrapper."""
    registry = config_mod.load_registry(context.root / "runners.json")
    try:
        spec = config_mod.resolve_runner(
            registry, None, budget_usd=1.0, timeout_seconds=60
        )
    except SystemExit as error:
        results.add("selftest:runner-registry-resolves", False, str(error))
        return
    results.add(
        "selftest:runner-registry-resolves",
        True,
        f"{spec.name} {spec.version} model={spec.model} effort={spec.effort}",
    )
    argv = [spec.binary_path, *spec.version_argv]
    if context.isolation is not None:
        argv = context.isolation.wrap(argv)
    outcome = run_command(argv, cwd=context.workspaces_root, timeout_seconds=120)
    results.add(
        "selftest:harness-runs-under-isolation",
        outcome.ok,
        f"exit={outcome.exit_code} {outcome.stdout.strip()[:80] or outcome.tail(120)}",
    )


def _timeout_control(results: Results, context: RunContext) -> None:
    argv = ["/bin/sleep", "30"]
    if context.isolation is not None:
        argv = context.isolation.wrap(argv)
    outcome = run_command(argv, cwd=context.workspaces_root, timeout_seconds=3)
    results.add(
        "selftest:process-timeout-enforced",
        outcome.timed_out and outcome.exit_code == 124,
        f"timed_out={outcome.timed_out} exit={outcome.exit_code} "
        f"after {outcome.duration_seconds:.1f}s",
    )


def _snapshot_controls(results: Results, context: RunContext) -> None:
    baseline = context.evaluator_copies["baseline"]
    treatment = context.evaluator_copies["treatment"]
    left = tree_file_hashes(baseline.path)
    right = tree_file_hashes(treatment.path)
    differing = sorted(
        path for path in set(left) | set(right) if left.get(path) != right.get(path)
    )
    results.add(
        "selftest:variants-differ-only-by-structural-delta",
        differing == [manifest.TARGET_FILE],
        f"differing files: {differing or 'none'}",
    )


def _grader_controls(results: Results, context: RunContext) -> dict[tuple[str, str], GradeResult]:
    grades: dict[tuple[str, str], GradeResult] = {}
    for variant in snapshots.VARIANTS:
        copy = context.evaluator_copies[variant]
        for control in CONTROL_ORDER:
            patch = (
                None
                if control == "unedited"
                else context.root / "grader" / "patches" / variant / f"{control}.patch"
            )
            grade = context.grader.grade(copy, patch, label=f"{variant}/{control}")
            grades[(variant, control)] = grade
            expectation = CONTROL_EXPECTATIONS[control]
            by_id = {check.check_id: check for check in grade.checks}
            problems: list[str] = []
            if grade.passed != expectation["expect_pass"]:
                problems.append(f"overall passed={grade.passed}")
            for check_id in sorted(expectation.get("must_fail", set())):
                if by_id[check_id].passed:
                    problems.append(f"{check_id} unexpectedly passed")
            for check_id in sorted(expectation.get("must_pass", set())):
                if not by_id[check_id].passed:
                    problems.append(f"{check_id} unexpectedly failed: {by_id[check_id].detail[:120]}")
            failing = sorted(check.check_id for check in grade.checks if not check.passed)
            results.add(
                f"selftest:control:{variant}:{control}",
                not problems,
                "; ".join(problems) if problems else f"failing checks: {failing or 'none'}",
            )
        results.add(
            f"selftest:baseline-behaviour-equivalent:{variant}",
            all(
                check.passed
                for check in grades[(variant, "unedited")].checks
                if check.check_id in manifest.COMMAND_CHECK_IDS
            ),
            "unedited snapshot typechecks and the upstream facade suite passes",
        )
    return grades


def _trial_workspace_controls(results: Results, context: RunContext) -> None:
    for variant in snapshots.VARIANTS:
        workspace = context.workspaces_root / f"selftest-trial-{variant}"
        snapshot = snapshots.build_trial_workspace(
            context.sources, variant, workspace, context.structural_delta
        )
        leaked = [
            relative
            for relative in manifest.TRIAL_WORKSPACE_REDACTIONS
            if (workspace / relative).exists()
        ]
        leaked_evaluator = (workspace / "scripts" / "repro" / "architecture-memory").exists()
        history = run_command(
            ["git", "rev-list", "--count", "HEAD"], cwd=workspace, timeout_seconds=120
        )
        results.add(
            f"selftest:trial-workspace-redacted:{variant}",
            not leaked and not leaked_evaluator and history.stdout.strip() == "1",
            f"leaked={leaked or 'none'} evaluatorPresent={leaked_evaluator} "
            f"commits={history.stdout.strip()} target={snapshot.target_file_sha256[:12]}",
        )
        shutil.rmtree(workspace, ignore_errors=True)


def _synthetic_record(context: RunContext, grades: dict, *, complete: bool, equal_config: bool) -> dict:
    config = {
        "runner": "claude",
        "model": "claude-opus-5",
        "effort": "high",
        "version": "test",
    }
    other = dict(config)
    if not equal_config:
        other["effort"] = "low"
    differences = [] if equal_config else ["effort: 'high' != 'low'"]
    arms = {
        "baseline": {
            "variant": "baseline",
            "status": "completed",
            "exit_code": 0,
            "wall_seconds": 1.0,
            "diff_sha256": "0" * 64,
            "diff_bytes": 1,
            "telemetry": {"cost_usd": 0.1, "cost_telemetry": "native"},
            "grade": {"passed": True, "checks": []},
            "patch_file": "synthetic-baseline.patch",
        },
        "treatment": {
            "variant": "treatment",
            "status": "completed",
            "exit_code": 0,
            "wall_seconds": 1.0,
            "diff_sha256": "0" * 64,
            "diff_bytes": 1,
            "telemetry": {"cost_usd": 0.1, "cost_telemetry": "native"},
            "grade": {"passed": True, "checks": []},
            "patch_file": "synthetic-treatment.patch",
        },
    }
    if not complete:
        arms.pop("treatment")
    return {
        "schema": records.SCHEMA,
        "experiment_id": manifest.EXPERIMENT_ID,
        "pair_id": "synthetic",
        "created_at": records.now(),
        "provenance": context.provenance(),
        "configuration": {"baseline": config, "treatment": other, "equal": equal_config, "differences": differences},
        "execution_order": ["baseline", "treatment"] if complete else ["baseline"],
        "arms": arms,
    }


def _record_controls(results: Results, context: RunContext) -> None:
    valid = _synthetic_record(context, {}, complete=True, equal_config=True)
    results.add(
        "selftest:valid-record-accepted",
        not records.validate_structure(valid) and not records.validate_config_equality(valid),
        "a complete, config-equal pair record passes both gates",
    )

    incomplete = _synthetic_record(context, {}, complete=False, equal_config=True)
    problems = records.validate_structure(incomplete)
    results.add(
        "selftest:incomplete-record-rejected",
        bool(problems),
        "; ".join(problems)[:200],
    )

    mismatched = _synthetic_record(context, {}, complete=True, equal_config=False)
    config_problems = records.validate_config_equality(mismatched)
    results.add(
        "selftest:pair-mismatch-rejected",
        bool(config_problems),
        "; ".join(config_problems)[:200],
    )

    unmetered = _synthetic_record(context, {}, complete=True, equal_config=True)
    unmetered["arms"]["treatment"]["telemetry"] = {"cost_usd": None, "cost_telemetry": "unavailable"}
    conclusion = records.cost_conclusion(unmetered)
    results.add(
        "selftest:cost-conclusion-blocked-without-telemetry",
        conclusion["dollar_conclusion_permitted"] is False,
        conclusion["reason"],
    )


def _ledger_controls(results: Results, context: RunContext) -> None:
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "ledger.json"
        ledger = AttemptLedger(path)
        attempt = new_attempt(manifest.EXPERIMENT_ID, "selftest-pair", "baseline", "baseline")
        ledger.claim(attempt)
        partial_state = json.loads(path.read_text())["attempts"][attempt.key]["state"]
        results.add(
            "selftest:ledger-records-partial-start",
            partial_state == "started",
            f"attempt persisted before the harness call with state={partial_state}",
        )

        duplicate_rejected = False
        try:
            AttemptLedger(path).claim(
                new_attempt(manifest.EXPERIMENT_ID, "selftest-pair", "baseline", "baseline")
            )
        except AttemptAlreadyRecorded as error:
            duplicate_rejected = str(error)
        results.add(
            "selftest:ledger-rejects-duplicate-attempt",
            bool(duplicate_rejected),
            str(duplicate_rejected)[:200] if duplicate_rejected else "duplicate was accepted",
        )


def _replay_control(results: Results, context: RunContext, grades: dict) -> None:
    """A recorded pair must regrade to the same result with no model call."""
    with tempfile.TemporaryDirectory() as temporary:
        patches_dir = Path(temporary) / "patches"
        patches_dir.mkdir(parents=True)
        record = _synthetic_record(context, grades, complete=True, equal_config=True)
        for variant in snapshots.VARIANTS:
            source = context.root / "grader" / "patches" / variant / "gold.patch"
            destination = patches_dir / f"replay-{variant}.patch"
            shutil.copyfile(source, destination)
            grade = grades[(variant, "gold")]
            record["arms"][variant].update(
                {
                    "patch_file": destination.name,
                    "diff_sha256": _sha(destination),
                    "diff_bytes": destination.stat().st_size,
                    "grade": grade.to_json(),
                }
            )
        replay = Results("replay")
        verify.verify_regrade(replay, record, context, patches_dir, "replay")
        results.add(
            "selftest:replay-regrade-matches",
            not replay.failed,
            "; ".join(outcome.detail for outcome in replay.failed)[:200]
            or "gold patches regrade identically from the recorded artefacts",
        )


def _grader_immutability_control(results: Results, context: RunContext) -> None:
    detected = False
    original = context.grader.grader_sha256
    try:
        context.grader.grader_sha256 = "0" * 64
        context.grader.assert_unchanged()
    except SystemExit as error:
        detected = str(error)
    finally:
        context.grader.grader_sha256 = original
    results.add(
        "selftest:grader-immutability-detected",
        bool(detected),
        str(detected)[:160] if detected else "a changed grader went undetected",
    )


def _sha(path: Path) -> str:
    from .util import sha256_file

    return sha256_file(path)
