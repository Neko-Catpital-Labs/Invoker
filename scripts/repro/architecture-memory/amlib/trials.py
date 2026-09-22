"""One bounded coding trial: isolated harness call, captured diff, native telemetry.

A trial is allowed to edit and test inside its own workspace and nothing else.
There are no automatic retries: a timeout, a crash, or a refusal is recorded as
that trial's outcome. Setup failures are reported separately from coding
failures so a broken apparatus is never scored as a bad agent result.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import RunnerSpec
from .isolation import Isolation
from .util import CommandOutcome, run_command, sha256_bytes, strip_ansi

SETUP_FAILURE = "setup_failure"
TIMEOUT = "timeout"
HARNESS_ERROR = "harness_error"
COMPLETED = "completed"


@dataclass
class TrialRun:
    arm: str
    variant: str
    status: str
    exit_code: int
    timed_out: bool
    wall_seconds: float
    diff_path: Path | None
    diff_sha256: str | None
    diff_bytes: int
    telemetry: dict[str, Any] = field(default_factory=dict)
    error_tail: str = ""
    raw_output_sha256: str = ""
    raw_output_path: str = ""
    human_intervention: str = "none"


def _write_ephemeral_config(directory: Path) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def capture_diff(workspace: Path, destination: Path) -> tuple[Path | None, str | None, int]:
    probe = workspace / ".isolation-probe"
    if probe.exists():
        probe.unlink()
    staged = run_command(["git", "add", "-A"], cwd=workspace, timeout_seconds=600)
    if not staged.ok:
        return None, None, 0
    diff = run_command(
        ["git", "--no-pager", "diff", "--binary", "HEAD"],
        cwd=workspace,
        timeout_seconds=600,
    )
    if not diff.ok:
        return None, None, 0
    payload = diff.stdout.encode("utf-8", "surrogateescape")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    return destination, sha256_bytes(payload), len(payload)


def parse_claude_telemetry(outcome: CommandOutcome) -> dict[str, Any]:
    try:
        payload = json.loads(outcome.stdout)
    except json.JSONDecodeError:
        return {"cost_usd": None, "cost_telemetry": "unparsable", "tokens": None}
    usage = payload.get("usage") or {}
    return {
        "cost_usd": payload.get("total_cost_usd"),
        "cost_telemetry": "native" if payload.get("total_cost_usd") is not None else "missing",
        "tokens": {
            "input": usage.get("input_tokens"),
            "output": usage.get("output_tokens"),
            "cache_read": usage.get("cache_read_input_tokens"),
            "cache_creation": usage.get("cache_creation_input_tokens"),
        },
        "num_turns": payload.get("num_turns"),
        "harness_duration_ms": payload.get("duration_ms"),
        "harness_is_error": payload.get("is_error"),
        "harness_subtype": payload.get("subtype"),
    }


def parse_generic_telemetry(outcome: CommandOutcome) -> dict[str, Any]:
    return {
        "cost_usd": None,
        "cost_telemetry": "unavailable",
        "tokens": None,
        "note": "this harness exposes no reliable per-run cost telemetry",
    }


def run_trial(
    *,
    arm: str,
    variant: str,
    workspace: Path,
    prompt: str,
    spec: RunnerSpec,
    isolation: Isolation,
    artifacts_dir: Path,
) -> TrialRun:
    ephemeral = _write_ephemeral_config(artifacts_dir / "harness-config")
    substitutions = {
        "model": spec.model,
        "effort": spec.effort,
        "budget_usd": f"{spec.budget_usd:.2f}",
        "ephemeral_config_dir": str(ephemeral),
        "workspace": str(workspace),
    }
    argv = isolation.wrap(spec.render_argv(substitutions))
    env = spec.render_env(substitutions)

    outcome = run_command(
        argv,
        cwd=workspace,
        timeout_seconds=spec.timeout_seconds,
        env=env,
        stdin_text=prompt if spec.prompt_mode == "stdin" else None,
    )

    raw_path = artifacts_dir / "harness-stdout.json"
    raw_path.write_text(outcome.stdout)
    (artifacts_dir / "harness-stderr.log").write_text(outcome.stderr)

    telemetry = (
        parse_claude_telemetry(outcome)
        if spec.cost_telemetry == "native"
        else parse_generic_telemetry(outcome)
    )

    diff_path, diff_sha, diff_bytes = capture_diff(
        workspace, artifacts_dir / f"{arm}-final.patch"
    )

    if outcome.timed_out:
        status = TIMEOUT
    elif outcome.exit_code != 0:
        status = HARNESS_ERROR
    else:
        status = COMPLETED

    return TrialRun(
        arm=arm,
        variant=variant,
        status=status,
        exit_code=outcome.exit_code,
        timed_out=outcome.timed_out,
        wall_seconds=round(outcome.duration_seconds, 3),
        diff_path=diff_path,
        diff_sha256=diff_sha,
        diff_bytes=diff_bytes,
        telemetry=telemetry,
        error_tail="" if status == COMPLETED else strip_ansi(outcome.stderr)[-600:],
        raw_output_sha256=sha256_bytes(outcome.stdout.encode()),
        raw_output_path=str(raw_path),
    )
