#!/usr/bin/env python3
"""Run and replay the first architecture-as-memory coding pilot.

The harness builds experimental copies from one immutable source commit, keeps
the evaluator-owned patches outside trial directories, runs one A/B pair through
a configured coding harness, and records sanitized replay artifacts.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
PROOF_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = PROOF_DIR / "manifests" / "pilot.json"
RUNNERS_PATH = PROOF_DIR / "manifests" / "runners.json"
RECORD_PATH = PROOF_DIR / "records" / "pilot-record.json"
REPORT_PATH = PROOF_DIR / "records" / "pilot-report.html"
RECORDED_PATCH_DIR = PROOF_DIR / "records" / "patches"


class HarnessError(RuntimeError):
    pass


@dataclass
class CmdResult:
    cmd: list[str]
    cwd: str
    exit_code: int
    stdout: str
    stderr: str
    timed_out: bool
    wall_seconds: float


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run_cmd(
    cmd: list[str],
    *,
    cwd: Path,
    timeout: int = 120,
    stdin: str | None = None,
    env: dict[str, str] | None = None,
) -> CmdResult:
    start = time.monotonic()
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd),
            input=stdin,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=env,
        )
        return CmdResult(cmd, str(cwd), proc.returncode, proc.stdout, proc.stderr, False, time.monotonic() - start)
    except subprocess.TimeoutExpired as exc:
        return CmdResult(
            cmd,
            str(cwd),
            124,
            exc.stdout if isinstance(exc.stdout, str) else "",
            exc.stderr if isinstance(exc.stderr, str) else "",
            True,
            time.monotonic() - start,
        )


def require_ok(result: CmdResult, label: str) -> None:
    if result.exit_code != 0:
        raise HarnessError(f"{label} failed with exit {result.exit_code}\n{tail(result.stdout + result.stderr)}")


def tail(text: str, lines: int = 30) -> str:
    text = sanitize_output(text)
    items = text.splitlines()
    return "\n".join(items[-lines:])


def sanitize_output(text: str) -> str:
    text = re.sub(r"/tmp/archmem-[A-Za-z0-9_.-]+", "<archmem-temp>", text)
    text = text.replace(str(ROOT), "<proof-worktree>")
    return text


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_hashes(workdir: Path) -> dict[str, str]:
    paths = [
        "packages/app/src/workflow-mutation-facade.ts",
        "packages/app/src/__tests__/workflow-mutation-facade.test.ts",
        "package.json",
        "pnpm-lock.yaml",
    ]
    return {path: sha256_file(workdir / path) for path in paths}


def patch_hashes() -> dict[str, str]:
    return {
        str(path.relative_to(PROOF_DIR)): sha256_file(path)
        for path in sorted((PROOF_DIR / "patches").glob("*.patch"))
    }


def git_archive_source(destination: Path, source_commit: str) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    archive = subprocess.run(["git", "archive", source_commit], cwd=str(ROOT), capture_output=True, timeout=120)
    if archive.returncode != 0:
        raise HarnessError(f"git archive failed: {archive.stderr.decode(errors='replace')}")
    tar = subprocess.run(["tar", "-x", "-C", str(destination)], input=archive.stdout, capture_output=True)
    if tar.returncode != 0:
        raise HarnessError(f"tar extract failed: {tar.stderr.decode(errors='replace')}")


def install_dependencies(workdir: Path) -> CmdResult:
    return run_cmd(["pnpm", "install", "--offline", "--ignore-scripts", "--frozen-lockfile"], cwd=workdir, timeout=180)


def init_trial_repo(workdir: Path) -> None:
    for cmd in [
        ["git", "init", "-q"],
        ["git", "config", "user.email", "architecture-memory@example.invalid"],
        ["git", "config", "user.name", "Architecture Memory Pilot"],
        ["git", "add", "."],
        ["git", "commit", "-qm", "trial start"],
    ]:
        require_ok(run_cmd(cmd, cwd=workdir, timeout=120), "initialize trial git repo")


def apply_patch_file(workdir: Path, patch_name: str) -> CmdResult:
    patch_path = PROOF_DIR / patch_name
    if not patch_path.read_text(encoding="utf-8").strip():
        return CmdResult(["git", "apply", str(patch_path)], str(workdir), 0, "empty patch skipped\n", "", False, 0.0)
    return run_cmd(["git", "apply", str(patch_path)], cwd=workdir, timeout=60)


def prepare_snapshot(
    parent: Path,
    name: str,
    *,
    arm: str,
    manifest: dict[str, Any],
    install: bool = True,
    git_repo: bool = False,
) -> Path:
    workdir = parent / name
    git_archive_source(workdir, manifest["source_commit"])
    if arm == "treatment":
        require_ok(apply_patch_file(workdir, manifest["treatment_patch"]), "apply treatment patch")
    elif arm != "baseline":
        raise HarnessError(f"unknown arm {arm}")
    if install:
        require_ok(install_dependencies(workdir), "install dependencies")
    if git_repo:
        init_trial_repo(workdir)
    return workdir


def grade_workdir(workdir: Path, manifest: dict[str, Any], *, timeout: int = 180) -> dict[str, Any]:
    hidden = apply_patch_file(workdir, manifest["hidden_check_patch"])
    if hidden.exit_code != 0:
        return {
            "passed": False,
            "stage": "hidden-check-apply",
            "exit_code": hidden.exit_code,
            "stdout_tail": tail(hidden.stdout),
            "stderr_tail": tail(hidden.stderr),
            "wall_seconds": hidden.wall_seconds,
        }
    result = run_cmd(manifest["grader_command"], cwd=workdir, timeout=timeout)
    output = result.stdout + result.stderr
    return {
        "passed": result.exit_code == 0,
        "stage": "grader-command",
        "exit_code": result.exit_code,
        "timed_out": result.timed_out,
        "stdout_tail": tail(result.stdout),
        "stderr_tail": tail(result.stderr),
        "wall_seconds": result.wall_seconds,
        "pass_fail_lines": [
            line for line in output.splitlines()
            if "Test Files" in line or "Tests" in line or "FAIL" in line or "passed" in line or "failed" in line
        ][-12:],
    }


def grade_patch(
    temp_root: Path,
    label: str,
    arm: str,
    patch_name: str | None,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    workdir = prepare_snapshot(temp_root, label, arm=arm, manifest=manifest, install=True, git_repo=False)
    if patch_name:
        applied = apply_patch_file(workdir, patch_name)
        if applied.exit_code != 0:
            return {"passed": False, "stage": "control-apply", "exit_code": applied.exit_code, "stderr_tail": tail(applied.stderr)}
    return grade_workdir(workdir, manifest)


def existing_behavior_check(temp_root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    results: dict[str, Any] = {}
    for arm in ["baseline", "treatment"]:
        workdir = prepare_snapshot(temp_root, f"equivalence-{arm}", arm=arm, manifest=manifest, install=True)
        result = run_cmd(["pnpm", "--filter", "@invoker/app", "test", "--", "workflow-mutation-facade.test.ts"], cwd=workdir, timeout=180)
        results[arm] = {
            "exit_code": result.exit_code,
            "passed": result.exit_code == 0,
            "wall_seconds": result.wall_seconds,
            "pass_fail_lines": [
                line for line in (result.stdout + result.stderr).splitlines()
                if "Test Files" in line or "Tests" in line or "passed" in line or "failed" in line
            ][-8:],
        }
    return results


def protected_access_control() -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="archmem-protected-") as temp:
        protected = Path(temp) / "protected"
        protected.mkdir()
        secret = protected / "hidden-check.txt"
        secret.write_text("grader answer\n", encoding="utf-8")
        protected.chmod(0)
        try:
            result = run_cmd(["python3", "-c", f"from pathlib import Path; Path({str(secret)!r}).read_text()"], cwd=ROOT, timeout=10)
            denied = result.exit_code != 0 and "PermissionError" in (result.stderr + result.stdout)
            return {
                "passed": denied,
                "exit_code": result.exit_code,
                "stderr_tail": tail(result.stderr, lines=5),
            }
        finally:
            protected.chmod(0o700)


def timeout_control() -> dict[str, Any]:
    result = run_cmd(["python3", "-c", "import time; time.sleep(2)"], cwd=ROOT, timeout=1)
    return {"passed": result.timed_out and result.exit_code == 124, "exit_code": result.exit_code, "timed_out": result.timed_out}


def validate_complete_record(record: dict[str, Any], manifest: dict[str, Any], runners: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if record.get("source_commit") != manifest["source_commit"]:
        errors.append("source commit mismatch")
    if record.get("runner") != runners["selected"]:
        errors.append("runner selection mismatch")
    if record.get("runner_config") != runners["runners"][runners["selected"]]:
        errors.append("runner config mismatch")
    attempts = record.get("attempts")
    if not isinstance(attempts, list):
        return ["attempts missing"]
    by_arm: dict[str, list[dict[str, Any]]] = {"baseline": [], "treatment": []}
    for attempt in attempts:
        arm = attempt.get("arm")
        if arm in by_arm:
            by_arm[arm].append(attempt)
    for arm, rows in by_arm.items():
        if len(rows) != 1:
            errors.append(f"{arm} has {len(rows)} attempts")
        elif rows[0].get("status") not in {"graded"}:
            errors.append(f"{arm} attempt is not graded")
    if len(record.get("execution_order", [])) != 2 or sorted(record.get("execution_order", [])) != ["baseline", "treatment"]:
        errors.append("execution order is not one randomized baseline/treatment pair")
    return errors


def self_test() -> int:
    manifest = read_json(MANIFEST_PATH)
    runners = read_json(RUNNERS_PATH)
    checks: list[tuple[str, bool, str]] = []
    with tempfile.TemporaryDirectory(prefix="archmem-selftest-") as temp:
        temp_root = Path(temp)
        base = prepare_snapshot(temp_root, "hash-source", arm="baseline", manifest=manifest, install=False)
        hashes = source_hashes(base)
        checks.append(("source paths and hashes recorded", len(hashes) == 4, json.dumps(hashes, sort_keys=True)))

        equality = existing_behavior_check(temp_root, manifest)
        checks.append((
            "baseline behavioral equivalence checks pass",
            equality["baseline"]["passed"] and equality["treatment"]["passed"],
            json.dumps(equality, sort_keys=True),
        ))

        protected = protected_access_control()
        checks.append(("protected grader access denied", protected["passed"], json.dumps(protected, sort_keys=True)))

        timeout = timeout_control()
        checks.append(("process timeout is enforced", timeout["passed"], json.dumps(timeout, sort_keys=True)))

        controls = {
            "baseline_unedited": grade_patch(temp_root, "baseline-unedited", "baseline", None, manifest),
            "treatment_unedited": grade_patch(temp_root, "treatment-unedited", "treatment", None, manifest),
            "baseline_gold": grade_patch(temp_root, "baseline-gold", "baseline", manifest["control_patches"]["gold_baseline"], manifest),
            "treatment_gold": grade_patch(temp_root, "treatment-gold", "treatment", manifest["control_patches"]["gold_treatment"], manifest),
            "baseline_wrong": grade_patch(temp_root, "baseline-wrong", "baseline", manifest["control_patches"]["wrong_baseline"], manifest),
            "treatment_wrong": grade_patch(temp_root, "treatment-wrong", "treatment", manifest["control_patches"]["wrong_treatment"], manifest),
            "baseline_noop": grade_patch(temp_root, "baseline-noop", "baseline", manifest["control_patches"]["noop"], manifest),
        }
        controls_pass = (
            not controls["baseline_unedited"]["passed"]
            and not controls["treatment_unedited"]["passed"]
            and controls["baseline_gold"]["passed"]
            and controls["treatment_gold"]["passed"]
            and not controls["baseline_wrong"]["passed"]
            and not controls["treatment_wrong"]["passed"]
            and not controls["baseline_noop"]["passed"]
        )
        checks.append(("bad controls fail and good controls pass", controls_pass, json.dumps(control_summary(controls), sort_keys=True)))

        complete_fixture = {
            "source_commit": manifest["source_commit"],
            "runner": runners["selected"],
            "runner_config": runners["runners"][runners["selected"]],
            "execution_order": ["baseline", "treatment"],
            "attempts": [{"arm": "baseline", "status": "graded"}, {"arm": "treatment", "status": "graded"}],
        }
        incomplete_fixture = {
            **complete_fixture,
            "attempts": [{"arm": "baseline", "status": "graded"}],
        }
        mismatch_fixture = {
            **complete_fixture,
            "runner_config": {**runners["runners"][runners["selected"]], "model": "different"},
        }
        checks.append(("complete record validator accepts a pair", not validate_complete_record(complete_fixture, manifest, runners), "complete fixture"))
        checks.append(("incomplete record validator rejects missing arm", bool(validate_complete_record(incomplete_fixture, manifest, runners)), "incomplete fixture"))
        checks.append(("config mismatch validator rejects unequal pair", bool(validate_complete_record(mismatch_fixture, manifest, runners)), "mismatch fixture"))

    failed = False
    for name, passed, detail in checks:
        status = "PASS" if passed else "FAIL"
        print(f"{status} {name}")
        if not passed:
            print(f"  {detail}")
            failed = True
    return 1 if failed else 0


def control_summary(controls: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        name: {
            "passed": row.get("passed"),
            "stage": row.get("stage"),
            "exit_code": row.get("exit_code"),
            "pass_fail_lines": row.get("pass_fail_lines", []),
        }
        for name, row in controls.items()
    }


def parse_codex_jsonl(stdout: str) -> dict[str, Any]:
    final_text = ""
    usage: dict[str, Any] = {}
    event_count = 0
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_count += 1
        item = event.get("item", {})
        if event.get("type") == "item.completed" and item.get("type") == "agent_message":
            final_text = str(item.get("text", final_text))
        if event.get("type") == "turn.completed":
            usage = event.get("usage", usage) or {}
    return {"event_count": event_count, "final_message_chars": len(final_text), "usage": usage, "cost_usd": None}


def run_trial_attempt(
    *,
    arm: str,
    attempt_id: str,
    workdir: Path,
    manifest: dict[str, Any],
    runner_config: dict[str, Any],
) -> dict[str, Any]:
    command = [part.format(workdir=str(workdir)) for part in runner_config["command"]]
    started_at = utc_now()
    result = run_cmd(command, cwd=workdir, timeout=int(manifest["trial_timeout_seconds"]), stdin=manifest["task_prompt"])
    completed_at = utc_now()
    parsed = parse_codex_jsonl(result.stdout) if runner_config.get("response_format") == "codex-jsonl" else {}
    setup_failed = result.exit_code != 0 and int(parsed.get("event_count") or 0) == 0
    diff = run_cmd(["git", "diff", "--binary"], cwd=workdir, timeout=60)
    diff_text = diff.stdout if diff.exit_code == 0 else ""
    patch_path = RECORDED_PATCH_DIR / f"{attempt_id}.patch"
    patch_path.parent.mkdir(parents=True, exist_ok=True)
    patch_path.write_text(diff_text, encoding="utf-8")
    return {
        "attempt_id": attempt_id,
        "arm": arm,
        "status": "setup_failed" if setup_failed else "completed",
        "started_at": started_at,
        "completed_at": completed_at,
        "runner_exit_code": result.exit_code,
        "runner_timed_out": result.timed_out,
        "wall_seconds": result.wall_seconds,
        "patch_path": str(patch_path.relative_to(PROOF_DIR)),
        "patch_sha256": sha256_file(patch_path),
        "patch_bytes": len(diff_text.encode("utf-8")),
        "stdout_event_count": parsed.get("event_count"),
        "final_message_chars": parsed.get("final_message_chars"),
        "usage": parsed.get("usage", {}),
        "cost_usd": parsed.get("cost_usd"),
        "cost_note": "Codex JSONL did not report reliable dollar telemetry; no dollar-efficiency conclusion is made.",
        "stderr_tail": tail(result.stderr),
        "human_intervention": "none",
    }


def grade_recorded_attempt(record: dict[str, Any], attempt: dict[str, Any], manifest: dict[str, Any], temp_root: Path) -> dict[str, Any]:
    arm = attempt["arm"]
    workdir = prepare_snapshot(temp_root, f"grade-{attempt['attempt_id']}", arm=arm, manifest=manifest, install=True)
    patch_path = PROOF_DIR / attempt["patch_path"]
    if patch_path.read_text(encoding="utf-8").strip():
        apply_result = run_cmd(["git", "apply", str(patch_path)], cwd=workdir, timeout=60)
        if apply_result.exit_code != 0:
            return {
                "passed": False,
                "stage": "recorded-patch-apply",
                "exit_code": apply_result.exit_code,
                "stderr_tail": tail(apply_result.stderr),
            }
    return grade_workdir(workdir, manifest)


def pilot() -> int:
    manifest = read_json(MANIFEST_PATH)
    runners = read_json(RUNNERS_PATH)
    selected_runner = runners["selected"]
    runner_config = runners["runners"][selected_runner]
    if RECORD_PATH.exists():
        record = read_json(RECORD_PATH)
        errors = validate_complete_record(record, manifest, runners)
        if not errors:
            print(f"PASS existing complete pair preserved: {RECORD_PATH.relative_to(ROOT)}")
            return 0
        if record.get("attempts"):
            print("FAIL existing pilot record is incomplete or mismatched; refusing to buy more trials")
            for error in errors:
                print(f"  {error}")
            return 1

    seed = int(time.time_ns() % (2**32))
    order = ["baseline", "treatment"]
    random.Random(seed).shuffle(order)
    with tempfile.TemporaryDirectory(prefix="archmem-pilot-") as temp:
        temp_root = Path(temp)
        equality = existing_behavior_check(temp_root, manifest)
        if not (equality["baseline"]["passed"] and equality["treatment"]["passed"]):
            print("FAIL baseline behavioral equivalence checks failed")
            print(json.dumps(equality, indent=2, sort_keys=True))
            return 1

        record: dict[str, Any] = {
            "schema_version": 1,
            "experiment_id": manifest["experiment_id"],
            "task_id": manifest["task_id"],
            "source_commit": manifest["source_commit"],
            "source_hashes": source_hashes(prepare_snapshot(temp_root, "record-source", arm="baseline", manifest=manifest, install=False)),
            "patch_hashes": patch_hashes(),
            "runner": selected_runner,
            "runner_config": runner_config,
            "execution_order": order,
            "random_seed": seed,
            "started_at": utc_now(),
            "behavioral_equivalence": equality,
            "attempts": [],
            "development_costs_excluded": True,
            "raw_sessions_tracked": False,
        }
        write_json(RECORD_PATH, record)

        for arm in order:
            attempt_id = f"{manifest['task_id']}-{arm}-1"
            workdir = prepare_snapshot(temp_root, f"trial-{arm}", arm=arm, manifest=manifest, install=True, git_repo=True)
            attempt = run_trial_attempt(
                arm=arm,
                attempt_id=attempt_id,
                workdir=workdir,
                manifest=manifest,
                runner_config=runner_config,
            )
            grade = grade_recorded_attempt(record, attempt, manifest, temp_root)
            attempt["grade"] = grade
            if attempt["status"] == "completed":
                attempt["status"] = "graded"
            record["attempts"].append(attempt)
            write_json(RECORD_PATH, record)
            print(f"PAIR {arm} exit={attempt['runner_exit_code']} grade_exit={grade.get('exit_code')} passed={grade.get('passed')}")

        record["completed_at"] = utc_now()
        record["validation_errors"] = validate_complete_record(record, manifest, runners)
        write_json(RECORD_PATH, record)
        write_report(record, manifest)

    errors = validate_complete_record(read_json(RECORD_PATH), manifest, runners)
    if errors:
        print("FAIL pilot record rejected")
        for error in errors:
            print(f"  {error}")
        return 1
    print(f"PASS pilot complete: {RECORD_PATH.relative_to(ROOT)}")
    print(f"PASS report written: {REPORT_PATH.relative_to(ROOT)}")
    return 0


def verify_recorded() -> int:
    manifest = read_json(MANIFEST_PATH)
    runners = read_json(RUNNERS_PATH)
    if not RECORD_PATH.exists():
        print(f"FAIL missing record: {RECORD_PATH.relative_to(ROOT)}")
        return 1
    record = read_json(RECORD_PATH)
    errors = validate_complete_record(record, manifest, runners)
    if errors:
        print("FAIL recorded pair rejected before replay")
        for error in errors:
            print(f"  {error}")
        return 1
    replay: dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="archmem-verify-") as temp:
        temp_root = Path(temp)
        for attempt in record["attempts"]:
            expected_hash = attempt["patch_sha256"]
            actual_hash = sha256_file(PROOF_DIR / attempt["patch_path"])
            if actual_hash != expected_hash:
                print(f"FAIL patch hash mismatch for {attempt['attempt_id']}")
                return 1
            grade = grade_recorded_attempt(record, attempt, manifest, temp_root)
            replay[attempt["arm"]] = grade
            print(f"REPLAY {attempt['arm']} exit={grade.get('exit_code')} passed={grade.get('passed')}")
    print("PASS verify-recorded provenance/config equality")
    print("PASS verify-recorded replayed both recorded patches without model calls")
    return 0


def write_report(record: dict[str, Any], manifest: dict[str, Any]) -> None:
    rows = []
    for attempt in record["attempts"]:
        grade = attempt.get("grade", {})
        rows.append(
            "<tr>"
            f"<td>{html.escape(attempt['arm'])}</td>"
            f"<td>{attempt['runner_exit_code']}</td>"
            f"<td>{html.escape(str(grade.get('exit_code')))}</td>"
            f"<td>{html.escape(str(grade.get('passed')))}</td>"
            f"<td>{attempt['patch_bytes']}</td>"
            f"<td>{html.escape(str(attempt.get('usage', {})))}</td>"
            "</tr>"
        )
    invalidators = [
        "Hidden checks or gold patches are readable by trial agents.",
        "Arms differ in runner, model, effort, timeout, dependencies, or task prompt.",
        "A partial or failed attempt is silently retried.",
        "Treatment behavior differs before the new task.",
        "Missing dollar telemetry is treated as a cost claim.",
    ]
    body = f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Architecture-memory pilot report</title>
<style>
body {{ font-family: system-ui, sans-serif; max-width: 900px; margin: 32px auto; line-height: 1.45; }}
table {{ border-collapse: collapse; width: 100%; }}
th, td {{ border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; }}
code {{ background: #f3f3f3; padding: 1px 3px; }}
</style>
<h1>Architecture-memory pilot report</h1>
<p><strong>Claim:</strong> {html.escape(manifest['review_claim'])}</p>
<p><strong>Source:</strong> <code>{html.escape(record['source_commit'])}</code></p>
<p><strong>Runner:</strong> {html.escape(record['runner'])}; model {html.escape(record['runner_config']['model'])}; effort {html.escape(record['runner_config']['effort'])}.</p>
<p>The pilot exercised one real-code task in baseline and treatment copies. It records apparatus behavior only; it does not support a statistical architecture advantage claim.</p>
<table>
<thead><tr><th>Arm</th><th>Runner Exit</th><th>Grade Exit</th><th>Grade Passed</th><th>Patch Bytes</th><th>Usage</th></tr></thead>
<tbody>{''.join(rows)}</tbody>
</table>
<h2>What Was Not Exercised</h2>
<p>No production package was edited, no workflow runtime was changed, no deployment or merge action was taken, and the six-task/five-repeat protocol was not launched.</p>
<h2>Invalidation</h2>
<ul>{''.join(f'<li>{html.escape(item)}</li>' for item in invalidators)}</ul>
<h2>Later Protocol</h2>
<p>{html.escape(manifest['later_protocol'])}</p>
</html>
"""
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(body, encoding="utf-8")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("self-test")
    sub.add_parser("pilot")
    sub.add_parser("verify-recorded")
    args = parser.parse_args(argv)
    try:
        if args.command == "self-test":
            return self_test()
        if args.command == "pilot":
            return pilot()
        if args.command == "verify-recorded":
            return verify_recorded()
    except HarnessError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
