"""External behavioural grader.

Grading never reads the agent's prose. It applies the trial's final diff to a
clean evaluator copy, typechecks it, re-runs the upstream suite the structural
delta must not have changed, and then runs evaluator-owned checks that assert the
requested behaviour and the ownership invariant. Exit codes and failure lines are
preserved verbatim.
"""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, asdict
from pathlib import Path

from . import manifest
from .snapshots import Snapshot, SnapshotSources, reset_evaluator_copy
from .util import CommandOutcome, run_command, sha256_file, strip_ansi

CHECKS_TARGET = "packages/app/src/__tests__/architecture-memory-close-idle-task.checks.test.ts"
TYPECHECK_TIMEOUT_SECONDS = 900
VITEST_TIMEOUT_SECONDS = 900


@dataclass
class CheckResult:
    check_id: str
    passed: bool
    exit_code: int | None
    detail: str


@dataclass
class GradeResult:
    variant: str
    patch_applied: bool
    apply_error: str
    checks: list[CheckResult]
    grader_sha256: str

    @property
    def passed(self) -> bool:
        return self.patch_applied and all(check.passed for check in self.checks)

    def to_json(self) -> dict:
        return {
            "variant": self.variant,
            "patch_applied": self.patch_applied,
            "apply_error": self.apply_error,
            "grader_sha256": self.grader_sha256,
            "passed": self.passed,
            "checks": [asdict(check) for check in self.checks],
        }


class Grader:
    """Owns the check file and drives grading inside evaluator-only copies."""

    def __init__(self, root: Path, sources: SnapshotSources, structural_delta: Path) -> None:
        self.checks_file = root / "grader" / "checks" / "close-idle-task.checks.test.ts"
        self.sources = sources
        self.structural_delta = structural_delta
        self.grader_sha256 = sha256_file(self.checks_file)

    def assert_unchanged(self) -> None:
        current = sha256_file(self.checks_file)
        if current != self.grader_sha256:
            raise SystemExit(
                "grader check file changed during the run; "
                f"expected {self.grader_sha256}, found {current}"
            )

    def grade(
        self,
        copy: Snapshot,
        candidate_patch: Path | None,
        *,
        label: str,
    ) -> GradeResult:
        self.assert_unchanged()
        reset_evaluator_copy(
            self.sources, copy.variant, copy.path, self.structural_delta, copy
        )

        patch_applied = True
        apply_error = ""
        if candidate_patch is not None:
            outcome = run_command(
                ["git", "init", "-q"], cwd=copy.path, timeout_seconds=120
            )
            if not outcome.ok and not (copy.path / ".git").exists():
                raise SystemExit(f"could not initialise evaluator copy for {label}")
            applied = run_command(
                ["git", "apply", "--whitespace=nowarn", str(candidate_patch)],
                cwd=copy.path,
                timeout_seconds=300,
            )
            patch_applied = applied.ok
            apply_error = "" if applied.ok else applied.tail(2000)

        checks: list[CheckResult] = []
        if not patch_applied:
            for check_id in manifest.COMMAND_CHECK_IDS + manifest.GRADER_CHECK_IDS:
                checks.append(
                    CheckResult(check_id, False, None, "candidate diff did not apply cleanly")
                )
            self.assert_unchanged()
            return GradeResult(copy.variant, False, apply_error, checks, self.grader_sha256)

        checks.append(self._typecheck(copy))
        checks.append(self._existing_suite(copy))
        checks.extend(self._behavioural_checks(copy))
        self.assert_unchanged()
        return GradeResult(copy.variant, True, apply_error, checks, self.grader_sha256)

    def _typecheck(self, copy: Snapshot) -> CheckResult:
        outcome = run_command(
            ["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.typecheck.json"],
            cwd=copy.path,
            timeout_seconds=TYPECHECK_TIMEOUT_SECONDS,
        )
        return CheckResult(
            "check:typecheck",
            outcome.ok,
            outcome.exit_code,
            "clean" if outcome.ok else outcome.tail(2000),
        )

    def _existing_suite(self, copy: Snapshot) -> CheckResult:
        outcome = run_command(
            ["./node_modules/.bin/vitest", "run", *manifest.EQUIVALENCE_TESTS],
            cwd=copy.path / "packages" / "app",
            timeout_seconds=VITEST_TIMEOUT_SECONDS,
            env={"CI": "1"},
        )
        return CheckResult(
            "check:existing-facade-suite",
            outcome.ok,
            outcome.exit_code,
            _summary_line(outcome) if outcome.ok else outcome.tail(3000),
        )

    def _behavioural_checks(self, copy: Snapshot) -> list[CheckResult]:
        destination = copy.path / CHECKS_TARGET
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.checks_file, destination)
        report = copy.path / "architecture-memory-checks.json"
        outcome = run_command(
            [
                "./node_modules/.bin/vitest",
                "run",
                "src/__tests__/architecture-memory-close-idle-task.checks.test.ts",
                "--reporter=json",
                f"--outputFile={report}",
            ],
            cwd=copy.path / "packages" / "app",
            timeout_seconds=VITEST_TIMEOUT_SECONDS,
            env={"CI": "1"},
        )
        statuses = _parse_vitest_json(report)
        results: list[CheckResult] = []
        for check_id in manifest.GRADER_CHECK_IDS:
            entry = statuses.get(check_id)
            if entry is None:
                results.append(
                    CheckResult(
                        check_id,
                        False,
                        outcome.exit_code,
                        "check did not run: " + (outcome.tail(2000) or "no vitest report"),
                    )
                )
                continue
            results.append(
                CheckResult(
                    check_id,
                    entry["passed"],
                    outcome.exit_code,
                    entry["detail"],
                )
            )
        return results


def _summary_line(outcome: CommandOutcome) -> str:
    for line in reversed(strip_ansi(outcome.stdout + outcome.stderr).splitlines()):
        if "Tests" in line and "passed" in line:
            return line.strip()
    return "passed"


def _parse_vitest_json(report: Path) -> dict[str, dict]:
    if not report.exists():
        return {}
    try:
        payload = json.loads(report.read_text())
    except json.JSONDecodeError:
        return {}
    statuses: dict[str, dict] = {}
    for file_result in payload.get("testResults", []):
        for assertion in file_result.get("assertionResults", []):
            title = assertion.get("title", "")
            status = assertion.get("status", "unknown")
            messages = assertion.get("failureMessages") or []
            statuses[title] = {
                "passed": status == "passed",
                "detail": status if status == "passed" else _first_failure(messages),
            }
    return statuses


def _first_failure(messages: list[str]) -> str:
    if not messages:
        return "failed"
    return messages[0].strip().splitlines()[0][:400]
