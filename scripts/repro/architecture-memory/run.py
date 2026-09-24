#!/usr/bin/env python3
"""Paired real-edit coding evaluator for the architecture-as-memory experiment.

Subcommands:
  self-test        deterministic apparatus checks, no model calls
  pilot            run exactly one baseline/treatment pair with a real harness
  verify-recorded  regrade the committed pair in fresh copies, no model calls
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import importlib.util
import json
import os
import random
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
MANIFEST_PATH = HERE / "manifest.json"
RUNNERS_PATH = HERE / "runners.json"
RECORDS_DIR = HERE / "records"
ARMS = ("baseline", "treatment")
GRADER_TARGET = "packages/app/src/__tests__/archmem-hidden-edit-task-pool.test.ts"
APP_DIR = "packages/app"
SNAPSHOT_ENV = {
    "GIT_AUTHOR_NAME": "archmem",
    "GIT_AUTHOR_EMAIL": "archmem@invalid",
    "GIT_COMMITTER_NAME": "archmem",
    "GIT_COMMITTER_EMAIL": "archmem@invalid",
    "GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
    "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z",
}
TRIAL_STATUSES = {"completed", "agent_error", "timed_out", "setup_failed", "abandoned_partial"}
DEFAULT_STATE_DIR = Path(os.environ.get("ARCHMEM_STATE_DIR", "~/.local/state/invoker-archmem")).expanduser()
DEFAULT_WORK_ROOT = Path(os.environ.get("ARCHMEM_WORK_ROOT", "/private/tmp/archmem"))


class EvalError(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(Path(path).read_bytes())


def canonical_hash(value: Any) -> str:
    return sha256_bytes(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def load_json(path: Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def manifest() -> dict[str, Any]:
    return load_json(MANIFEST_PATH)


def sh(cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None,
       timeout: float | None = None, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, env=env, timeout=timeout, input=input_bytes,
                          capture_output=True, check=False)


def must(cp: subprocess.CompletedProcess, what: str) -> subprocess.CompletedProcess:
    if cp.returncode != 0:
        raise EvalError(f"{what} failed ({cp.returncode}): {cp.stderr.decode(errors='replace')[-2000:]}")
    return cp


def tail(data: bytes | str, lines: int = 40) -> str:
    text = data.decode(errors="replace") if isinstance(data, bytes) else data
    return "\n".join(text.rstrip().splitlines()[-lines:])


def sanitize(text: str) -> str:
    home = str(Path.home())
    text = text.replace(home, "~")
    return re.sub(r"(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+", r"\1<redacted>", text)


# ── Provenance: pinned inputs ────────────────────────────────

def verify_pinned_inputs(m: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    m = m or manifest()
    rows = []
    for rel, expected in sorted(m["pinned_files"].items()):
        path = HERE / rel
        actual = sha256_file(path) if path.exists() else None
        rows.append({"file": rel, "expected": expected, "actual": actual, "ok": actual == expected})
    return rows


def assert_pinned_inputs() -> None:
    bad = [row for row in verify_pinned_inputs() if not row["ok"]]
    if bad:
        raise EvalError(f"evaluator-owned inputs drifted from manifest: {[row['file'] for row in bad]}")


# ── Snapshots ────────────────────────────────────────────────

def ensure_source(m: dict[str, Any] | None = None) -> dict[str, str]:
    m = m or manifest()
    sha = m["source"]["commit"]
    if sh(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=REPO_ROOT).returncode != 0:
        must(sh(["git", "fetch", "--no-tags", m["source"]["remote"], sha], cwd=REPO_ROOT, timeout=600),
             f"fetch {sha}")
    tree = must(sh(["git", "rev-parse", f"{sha}^{{tree}}"], cwd=REPO_ROOT), "rev-parse tree").stdout.decode().strip()
    if m["source"].get("tree") and tree != m["source"]["tree"]:
        raise EvalError(f"source tree {tree} != pinned {m['source']['tree']}")
    return {"commit": sha, "tree": tree}


def install_dependencies(repo: Path, timeout: float = 900) -> dict[str, Any]:
    started = time.monotonic()
    cp = sh(["pnpm", "install", "--frozen-lockfile", "--offline", "--ignore-scripts"], cwd=repo, timeout=timeout)
    mode = "offline"
    if cp.returncode != 0:
        cp = sh(["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], cwd=repo, timeout=timeout)
        mode = "prefer-offline"
    return {"exit": cp.returncode, "mode": mode, "seconds": round(time.monotonic() - started, 1),
            "tail": sanitize(tail(cp.stdout + cp.stderr, 5))}


def build_snapshot(dest: Path, arm: str, install: bool = True, m: dict[str, Any] | None = None) -> dict[str, Any]:
    m = m or manifest()
    if arm not in ARMS:
        raise EvalError(f"unknown arm {arm}")
    sha = m["source"]["commit"]
    repo = Path(dest)
    if repo.exists():
        shutil.rmtree(repo)
    repo.mkdir(parents=True)
    archive = must(sh(["git", "archive", "--format=tar", sha], cwd=REPO_ROOT), "git archive").stdout
    must(sh(["tar", "-x", "-C", str(repo)], input_bytes=archive), "untar")
    if arm == "treatment":
        must(sh(["git", "apply", "--whitespace=nowarn", str(HERE / m["fixture"]["patch"])], cwd=repo),
             "apply treatment fixture")
    env = {**os.environ, **SNAPSHOT_ENV}
    must(sh(["git", "init", "-q", "-b", "main"], cwd=repo, env=env), "git init")
    must(sh(["git", "add", "-A"], cwd=repo, env=env), "git add")
    must(sh(["git", "commit", "-q", "--no-gpg-sign", "-m", "snapshot"], cwd=repo, env=env), "git commit")
    commit = must(sh(["git", "rev-parse", "HEAD"], cwd=repo), "rev-parse").stdout.decode().strip()
    tree = must(sh(["git", "rev-parse", "HEAD^{tree}"], cwd=repo), "rev-parse").stdout.decode().strip()
    result: dict[str, Any] = {"arm": arm, "path": str(repo), "commit": commit, "tree": tree,
                              "source_commit": sha}
    if install:
        result["install"] = install_dependencies(repo)
        if result["install"]["exit"] != 0:
            raise EvalError(f"dependency install failed for {arm}: {result['install']['tail']}")
    return result


def capture_diff(repo: Path, base_commit: str) -> bytes:
    must(sh(["git", "add", "-A"], cwd=repo), "git add")
    return must(sh(["git", "diff", "--cached", "--binary", base_commit], cwd=repo), "git diff").stdout


def changed_paths(patch: bytes) -> list[str]:
    paths = set()
    for line in patch.decode(errors="replace").splitlines():
        if line.startswith("diff --git "):
            parts = line.split(" ")
            paths.add(parts[2][2:])
            paths.add(parts[3][2:])
    return sorted(paths)


# ── Grader ───────────────────────────────────────────────────

def run_vitest(repo: Path, files: list[str], timeout: float = 600) -> dict[str, Any]:
    out = Path(tempfile.mkstemp(prefix="archmem-vitest-", suffix=".json")[1])
    try:
        cmd = ["pnpm", "exec", "vitest", "run", *files, "--reporter=default", "--reporter=json",
               f"--outputFile.json={out}"]
        try:
            cp = sh(cmd, cwd=repo / APP_DIR, timeout=timeout,
                    env={**os.environ, "CI": "1", "NO_COLOR": "1", "FORCE_COLOR": "0"})
            exit_code, stdout = cp.returncode, cp.stdout + cp.stderr
        except subprocess.TimeoutExpired as exc:
            exit_code, stdout = 124, (exc.stdout or b"") + (exc.stderr or b"")
        tests = []
        if out.exists() and out.stat().st_size:
            data = json.loads(out.read_text(encoding="utf-8"))
            for suite in data.get("testResults", []):
                file_rel = os.path.relpath(suite.get("name", ""), repo / APP_DIR)
                for assertion in suite.get("assertionResults", []):
                    tests.append({"file": file_rel, "name": assertion.get("fullName") or assertion.get("title"),
                                  "status": assertion.get("status"),
                                  "failure": sanitize(tail("\n".join(assertion.get("failureMessages") or []), 6))})
        lines = [ln for ln in tail(stdout, 400).splitlines()
                 if re.search(r"(✓|✗|×|FAIL|PASS|Tests |Test Files |Error:)", ln)]
        return {"command": " ".join(cmd[:4] + files), "exit": exit_code, "tests": tests,
                "passed": sum(t["status"] == "passed" for t in tests),
                "failed": sum(t["status"] == "failed" for t in tests),
                "summary_lines": [sanitize(ln) for ln in lines[-30:]]}
    finally:
        out.unlink(missing_ok=True)


def reset_copy(repo: Path, commit: str) -> None:
    must(sh(["git", "reset", "-q", "--hard", commit], cwd=repo), "git reset")
    must(sh(["git", "clean", "-qfdx", "-e", "node_modules"], cwd=repo), "git clean")
    for cache in ("node_modules/.vite", "node_modules/.vitest", f"{APP_DIR}/node_modules/.vite",
                  f"{APP_DIR}/node_modules/.vitest"):
        shutil.rmtree(repo / cache, ignore_errors=True)


def grade_in_repo(arm: str, patch: bytes, repo: Path, snap: dict[str, Any], m: dict[str, Any]) -> dict[str, Any]:
    assert_pinned_inputs()
    record: dict[str, Any] = {"arm": arm, "patch_sha256": sha256_bytes(patch), "patch_paths": changed_paths(patch),
                              "snapshot": {k: snap[k] for k in ("commit", "tree")}, "started_at": now_iso()}
    try:
        reset_copy(repo, snap["commit"])
        if patch.strip():
            cp = sh(["git", "apply", "--binary", "--whitespace=nowarn", "-"], cwd=repo, input_bytes=patch)
            record["apply"] = {"exit": cp.returncode, "stderr": sanitize(tail(cp.stderr, 10))}
        else:
            record["apply"] = {"exit": 0, "stderr": "", "empty": True}
        if record["apply"]["exit"] != 0:
            record.update(passed=False, reason="patch_apply_failed")
            return record
        protected = [p for p in m["protected_paths"] if p in record["patch_paths"]]
        record["protected_paths_touched"] = protected
        if protected:
            must(sh(["git", "checkout", snap["commit"], "--", *protected], cwd=repo), "restore protected")
        target = repo / GRADER_TARGET
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(HERE / m["grader"]["file"], target)
        hidden = run_vitest(repo, [os.path.relpath(target, repo / APP_DIR)])
        regression = run_vitest(repo, m["regression_tests"])
        record["hidden"] = hidden
        record["regression"] = regression
        hidden_ok = (hidden["exit"] == 0 and hidden["failed"] == 0
                     and hidden["passed"] == m["grader"]["expected_tests"])
        regression_ok = regression["exit"] == 0 and regression["failed"] == 0 and regression["passed"] > 0
        record["passed"] = hidden_ok and regression_ok
        record["reason"] = ("passed" if record["passed"]
                            else "hidden_checks_failed" if not hidden_ok else "regression_failed")
        return record
    except EvalError as exc:
        record.update(passed=False, reason="grader_setup_failed", error=sanitize(str(exc)))
        return record
    finally:
        record["finished_at"] = now_iso()


def grade_patch(arm: str, patch: bytes, work_dir: Path, m: dict[str, Any] | None = None,
                keep: bool = False) -> dict[str, Any]:
    m = m or manifest()
    copy = work_dir / f"grade-{arm}-{secrets.token_hex(4)}"
    try:
        snap = build_snapshot(copy, arm, install=True, m=m)
        record = grade_in_repo(arm, patch, Path(snap["path"]), snap, m)
        record["fresh_copy"] = True
        return record
    except EvalError as exc:
        return {"arm": arm, "patch_sha256": sha256_bytes(patch), "patch_paths": changed_paths(patch),
                "passed": False, "reason": "grader_setup_failed", "error": sanitize(str(exc))}
    finally:
        if not keep:
            shutil.rmtree(copy, ignore_errors=True)


def grade_summary(grade: dict[str, Any]) -> dict[str, Any]:
    hidden = grade.get("hidden") or {}
    return {"passed": grade.get("passed"), "reason": grade.get("reason"),
            "apply_exit": (grade.get("apply") or {}).get("exit"),
            "hidden_exit": hidden.get("exit"),
            "hidden_statuses": sorted((t["name"], t["status"]) for t in hidden.get("tests", [])),
            "regression_exit": (grade.get("regression") or {}).get("exit")}


# ── Equivalence and controls ─────────────────────────────────

def control_row(arm: str, name: str, expect: str, grade: dict[str, Any]) -> dict[str, Any]:
    hidden = grade.get("hidden") or {}
    actual = "pass" if grade.get("passed") else "fail"
    return {"arm": arm, "control": name, "expect": expect, "actual": actual,
            "ok": actual == expect and grade.get("reason") != "grader_setup_failed",
            "reason": grade.get("reason"), "apply_exit": (grade.get("apply") or {}).get("exit"),
            "hidden_exit": hidden.get("exit"), "hidden_passed": hidden.get("passed"),
            "hidden_failed": hidden.get("failed"),
            "regression_exit": (grade.get("regression") or {}).get("exit"),
            "failing_hidden_tests": [t["name"] for t in hidden.get("tests", []) if t["status"] != "passed"],
            "hidden_summary_lines": hidden.get("summary_lines", [])[-6:], "patch_sha256": grade["patch_sha256"]}


def arm_suite(arm: str, work_dir: Path, m: dict[str, Any]) -> dict[str, Any]:
    copy = work_dir / f"controls-{arm}-{secrets.token_hex(4)}"
    try:
        snap = build_snapshot(copy, arm, install=True, m=m)
        repo = Path(snap["path"])
        equivalence = run_vitest(repo, m["regression_tests"])
        equivalence["snapshot_tree"] = snap["tree"]
        specs = [("unedited-snapshot", b"", "fail")]
        specs += [(name, (HERE / spec["patch"]).read_bytes(), spec["expect"])
                  for name, spec in m["controls"][arm].items()]
        rows = [control_row(arm, name, expect, grade_in_repo(arm, patch, repo, snap, m))
                for name, patch, expect in specs]
        return {"equivalence": equivalence, "controls": rows}
    finally:
        shutil.rmtree(copy, ignore_errors=True)


def run_gate_suites(work_dir: Path, m: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ARMS)) as pool:
        suites = dict(zip(ARMS, pool.map(lambda arm: arm_suite(arm, work_dir, m), ARMS)))
    results = {arm: suites[arm]["equivalence"] for arm in ARMS}
    names = {arm: sorted((t["file"], t["name"], t["status"]) for t in results[arm]["tests"]) for arm in ARMS}
    eq_ok = (names["baseline"] == names["treatment"]
             and all(results[a]["exit"] == 0 and results[a]["failed"] == 0 and results[a]["passed"] > 0
                     for a in ARMS))
    equivalence = {"ok": eq_ok, "identical_test_outcomes": names["baseline"] == names["treatment"],
                   "arms": {a: {k: results[a][k] for k in ("command", "exit", "passed", "failed", "summary_lines",
                                                         "snapshot_tree")} for a in ARMS}}
    rows = sorted((row for arm in ARMS for row in suites[arm]["controls"]), key=lambda r: (r["arm"], r["control"]))
    unedited = {r["arm"]: sorted(r["failing_hidden_tests"]) for r in rows if r["control"] == "unedited-snapshot"}
    controls = {"ok": all(r["ok"] for r in rows), "rows": rows,
                "unedited_fails_identically": unedited.get("baseline") == unedited.get("treatment")}
    return equivalence, controls


# ── Isolation ────────────────────────────────────────────────

def realpath(p: str | Path) -> str:
    return os.path.realpath(os.path.expanduser(str(p)))


def resolve_auth_config_dir(spec: dict[str, Any]) -> str | None:
    env_key = spec.get("auth_config_dir_env")
    if not env_key:
        return None
    value = os.environ.get(env_key) or os.environ.get("CLAUDE_CONFIG_DIR") or spec.get("auth_config_dir_default")
    return realpath(value) if value else None


def isolation_plan(trial_dir: Path, state_dir: Path, work_root: Path, auth_dir: str | None) -> dict[str, Any]:
    home = realpath(Path.home())
    deny_all = {realpath(REPO_ROOT), realpath(HERE), realpath(state_dir), f"{home}/.claude", f"{home}/.codex",
                f"{home}/.config/gh", f"{home}/.ssh", f"{home}/.invoker", f"{home}/.git-credentials",
                f"{home}/.local/state/invoker-archmem"}
    allow_after = []
    if auth_dir:
        allow_after.append(auth_dir)
        for private in ("projects", "history.jsonl", "file-history", "todos", "plans", "skills", "plugins",
                        "commands", "agents", "hooks", "CLAUDE.md", "memory", "shell-snapshots", "debug"):
            deny_all.add(f"{auth_dir}/{private}")
    deny_exec = set()
    for tool in ("gh", "invoker-cli", "invoker-ui", "hub"):
        found = shutil.which(tool)
        if found:
            deny_exec.update({found, realpath(found)})
    exec_path = sh(["git", "--exec-path"]).stdout.decode().strip()
    git_binary = realpath(shutil.which("git") or "git")
    candidate = Path(exec_path) / "git-credential-osxkeychain"
    if candidate.exists() and realpath(candidate) != git_binary:
        deny_exec.update({str(candidate), realpath(candidate)})
    deny_exec.discard(git_binary)
    return {"work_root": realpath(work_root), "trial_dir": realpath(trial_dir),
            "deny_read_write": sorted(deny_all), "reallow_auth_dir": allow_after,
            "deny_exec": sorted(deny_exec)}


def sandbox_profile(plan: dict[str, Any]) -> str:
    def q(path: str) -> str:
        return json.dumps(path)

    lines = ["(version 1)", "(allow default)",
             f"(deny file-read-data file-write* (subpath {q(plan['work_root'])}))"]
    auth_dir = plan["reallow_auth_dir"][0] if plan["reallow_auth_dir"] else None
    for path in plan["deny_read_write"]:
        if auth_dir and path.startswith(auth_dir + "/"):
            continue
        lines.append(f"(deny file-read* file-read-data file-write* (subpath {q(path)}))")
    if auth_dir:
        lines.append(f"(allow file-read* file-read-data file-write* (subpath {q(auth_dir)}))")
        for path in plan["deny_read_write"]:
            if path.startswith(auth_dir + "/"):
                lines.append(f"(deny file-read* file-read-data file-write* (subpath {q(path)}))")
    lines.append(f"(allow file-read* file-read-data file-write* (subpath {q(plan['trial_dir'])}))")
    for path in plan["deny_exec"]:
        lines.append(f"(deny process-exec (literal {q(path)}))")
    return "\n".join(lines) + "\n"


def normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    trial = plan["trial_dir"]
    return {**plan, "trial_dir": "<TRIAL_DIR>",
            "deny_read_write": sorted(p.replace(trial, "<TRIAL_DIR>") for p in plan["deny_read_write"])}


def isolation_supported() -> tuple[bool, str]:
    if sys.platform != "darwin":
        return False, f"sandbox-exec isolation is only implemented for macOS; platform is {sys.platform}"
    if not Path("/usr/bin/sandbox-exec").exists():
        return False, "/usr/bin/sandbox-exec is missing"
    return True, "sandbox-exec"


def access_denial_controls(work_root: Path, state_dir: Path, auth_dir: str | None) -> dict[str, Any]:
    supported, detail = isolation_supported()
    if not supported:
        return {"ok": False, "blocked": detail, "rows": []}
    base = Path(realpath(work_root)) / f"denial-{secrets.token_hex(4)}"
    trial = base / "trial-baseline" / "repo"
    other = base / "trial-treatment" / "repo"
    private = base / "private"
    for d in (trial, other, private):
        d.mkdir(parents=True, exist_ok=True)
    (other / "other-arm.txt").write_text("other arm\n")
    (private / "gold.patch").write_text("gold\n")
    (trial / "own.txt").write_text("own\n")
    state_dir.mkdir(parents=True, exist_ok=True)
    plan = isolation_plan(trial, state_dir, work_root, auth_dir)
    profile = base / "profile.sb"
    profile.write_text(sandbox_profile(plan))
    grader = HERE / manifest()["grader"]["file"]
    probes = [
        ("read hidden grader in evaluator repo", ["cat", str(grader)], "deny"),
        ("read committed gold control", ["cat", str(HERE / "controls/baseline/gold.patch")], "deny"),
        ("read evaluator private copy", ["cat", str(private / "gold.patch")], "deny"),
        ("read other arm's trial copy", ["cat", str(other / "other-arm.txt")], "deny"),
        ("list evaluator state/ledger dir", ["ls", str(state_dir)], "deny"),
        ("list personal ~/.claude", ["ls", realpath("~/.claude")], "deny"),
        ("read gh credentials dir", ["ls", realpath("~/.config/gh")], "deny"),
    ]
    if auth_dir:
        probes.append(("list prior sessions in harness config", ["ls", f"{auth_dir}/projects"], "deny"))
        probes.append(("read harness prompt history", ["cat", f"{auth_dir}/history.jsonl"], "deny"))
    for tool in ("gh", "invoker-cli"):
        found = shutil.which(tool)
        if found:
            probes.append((f"execute {tool}", [found, "--version"], "deny"))
    probes += [
        ("read own trial file", ["cat", str(trial / "own.txt")], "allow"),
        ("write own trial file", ["sh", "-c", f"echo edit > {trial / 'edit.txt'}"], "allow"),
        ("run node inside trial", ["node", "-e", "process.stdout.write(process.cwd())"], "allow"),
    ]
    rows = []
    for label, cmd, expect in probes:
        cp = sh(["/usr/bin/sandbox-exec", "-f", str(profile), *cmd], cwd=trial, timeout=60)
        denied = cp.returncode != 0
        rows.append({"probe": label, "expect": expect, "exit": cp.returncode,
                     "observed": "deny" if denied else "allow",
                     "ok": (expect == "deny") == denied,
                     "stderr": sanitize(tail(cp.stderr, 2))})
    shutil.rmtree(base, ignore_errors=True)
    return {"ok": all(r["ok"] for r in rows), "mechanism": detail, "rows": rows,
            "profile_normalized_sha256": canonical_hash(normalize_plan(plan))}


# ── Harness registry and pinning ─────────────────────────────

def load_runners() -> dict[str, Any]:
    return load_json(RUNNERS_PATH)


def resolve_harness(name: str, model: str, effort: str, budget: float, timeout_s: int,
                    registry: dict[str, Any] | None = None) -> dict[str, Any]:
    registry = registry or load_runners()["harnesses"]
    if name not in registry:
        raise EvalError(f"harness {name!r} is not registered; known: {sorted(registry)}")
    spec = registry[name]
    found = shutil.which(spec["binary"]) if not os.path.isabs(spec["binary"]) else spec["binary"]
    if not found:
        raise EvalError(f"harness binary {spec['binary']!r} not installed")
    binary = realpath(found)
    version = sh([binary, *spec.get("version_args", ["--version"])], timeout=60)
    return {"harness": name, "binary": binary, "binary_sha256": sha256_file(Path(binary)),
            "version": version.stdout.decode(errors="replace").strip(), "model": model, "effort": effort,
            "budget_usd": budget, "timeout_seconds": timeout_s, "argv_template": spec["argv"],
            "env_template": spec.get("env", {}), "telemetry": spec.get("telemetry"),
            "auth_config_dir": resolve_auth_config_dir(spec)}


def render_invocation(pinned: dict[str, Any], prompt: str) -> tuple[list[str], dict[str, str]]:
    values = {"model": pinned["model"], "effort": pinned["effort"], "budget_usd": f"{pinned['budget_usd']:.2f}",
              "prompt": prompt, "auth_config_dir": pinned.get("auth_config_dir") or ""}
    argv = [pinned["binary"]] + [a.format(**values) if "{" in a and not a.startswith("{\"") else a
                                 for a in pinned["argv_template"]]
    env_extra = {k: v.format(**values) for k, v in pinned["env_template"].items()}
    return argv, env_extra


def trial_config(pinned: dict[str, Any], prompt_sha: str, plan: dict[str, Any], m: dict[str, Any]) -> dict[str, Any]:
    argv, env_extra = render_invocation(pinned, "<PROMPT>")
    return {"harness": {k: pinned[k] for k in ("harness", "binary", "binary_sha256", "version", "model", "effort",
                                               "budget_usd", "timeout_seconds", "telemetry")},
            "argv": argv, "env": env_extra, "prompt_sha256": prompt_sha,
            "isolation": normalize_plan(plan), "source_commit": m["source"]["commit"],
            "grader_sha256": m["pinned_files"][m["grader"]["file"]],
            "cache_policy": "fresh pnpm --offline install per copy; no shared build or vitest cache between arms",
            "retries": 0}


def base_env(env_extra: dict[str, str]) -> dict[str, str]:
    keep = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL", "TERM")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env.update({"CI": "1", "NO_COLOR": "1"})
    env.update(env_extra)
    return env


def run_process_group(argv: list[str], cwd: Path, env: dict[str, str], timeout_s: float,
                      stdout_path: Path, stderr_path: Path) -> dict[str, Any]:
    started = time.monotonic()
    with open(stdout_path, "wb") as out, open(stderr_path, "wb") as err:
        proc = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err, stdin=subprocess.DEVNULL,
                                start_new_session=True)
        timed_out = False
        try:
            proc.wait(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
    return {"exit": proc.returncode, "timed_out": timed_out, "wall_seconds": round(time.monotonic() - started, 1)}


def load_parse_response() -> Callable[[str, str], tuple[str, dict[str, Any], float | None]]:
    spec = importlib.util.spec_from_file_location("run_skill_evals", REPO_ROOT / "scripts" / "run_skill_evals.py")
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module.parse_response


def parse_telemetry(kind: str | None, stdout: str) -> dict[str, Any]:
    if kind == "claude-stream-json":
        events = []
        for line in stdout.splitlines():
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        result = next((e for e in reversed(events) if e.get("type") == "result"), None)
        init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
        tool_uses = sum(1 for e in events if e.get("type") == "assistant"
                        for c in (e.get("message", {}).get("content") or []) if c.get("type") == "tool_use")
        if not result:
            return {"result_event": False, "tool_uses": tool_uses, "init_model": init.get("model"),
                    "cost_usd": None, "cost_source": "missing: no result event"}
        text, usage, cost = load_parse_response()(json.dumps(result), "claude-json")
        return {"result_event": True, "is_error": result.get("is_error"), "subtype": result.get("subtype"),
                "num_turns": result.get("num_turns"), "duration_api_ms": result.get("duration_api_ms"),
                "usage": {k: usage.get(k) for k in ("input_tokens", "output_tokens", "cache_creation_input_tokens",
                                                    "cache_read_input_tokens")},
                "model_usage": result.get("modelUsage"), "cost_usd": cost,
                "cost_source": "claude CLI total_cost_usd (client-side estimate)" if cost is not None else "missing",
                "permission_denials": len(result.get("permission_denials") or []),
                "tool_uses": tool_uses, "init_model": init.get("model"),
                "init_tools": init.get("tools"), "init_mcp_servers": init.get("mcp_servers"),
                "init_plugins": init.get("plugins"), "init_skills_count": len(init.get("skills") or []),
                "final_message": sanitize((text or "")[:1500])}
    if kind == "codex-jsonl":
        text, usage, _ = load_parse_response()(stdout, "codex-jsonl")
        return {"result_event": bool(usage), "usage": usage, "cost_usd": None,
                "cost_source": "missing: codex exec reports no dollar cost", "final_message": sanitize(text[:1500])}
    if kind == "selftest":
        return {"result_event": True, "usage": {}, "cost_usd": None, "cost_source": "missing: self-test fake harness",
                "final_message": stdout.strip()[:200]}
    return {"result_event": False, "cost_usd": None, "cost_source": f"missing: unknown telemetry {kind}"}


# ── Ledger ───────────────────────────────────────────────────

class Ledger:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)

    def events(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def append(self, event: str, **fields: Any) -> dict[str, Any]:
        row = {"event": event, "at": now_iso(), **fields}
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        return row

    def arm_state(self, arm: str) -> str:
        events = [e for e in self.events() if e.get("arm") == arm]
        kinds = [e["event"] for e in events]
        if "trial_end" in kinds or "setup_failed" in kinds or "abandoned_partial" in kinds:
            return "finished"
        if "trial_start" in kinds:
            return "started"
        return "none"

    def invocations(self, arm: str) -> int:
        return sum(1 for e in self.events() if e.get("arm") == arm and e["event"] == "trial_start")


# ── Pair record validation ───────────────────────────────────

def validate_pair(record: dict[str, Any], records_dir: Path | None = None) -> list[str]:
    errors = []
    for key in ("experiment_id", "pair_id", "source", "arms", "order", "configs", "grades", "trials"):
        if key not in record:
            errors.append(f"missing field {key}")
    if errors:
        return errors
    if sorted(record["order"]) != sorted(ARMS):
        errors.append(f"order {record['order']} is not a permutation of {ARMS}")
    for arm in ARMS:
        for key in ("arms", "configs", "grades", "trials"):
            if arm not in record[key]:
                errors.append(f"{key}.{arm} missing (incomplete pair)")
    if errors:
        return errors
    hashes = {arm: canonical_hash(record["configs"][arm]) for arm in ARMS}
    for arm in ARMS:
        if record["arms"][arm].get("config_sha256") != hashes[arm]:
            errors.append(f"configs.{arm} does not match its recorded config_sha256")
    if hashes["baseline"] != hashes["treatment"]:
        errors.append("arm configurations differ (pair mismatch)")
    for arm in ARMS:
        trial = record["trials"][arm]
        if trial.get("status") not in TRIAL_STATUSES:
            errors.append(f"trials.{arm}.status {trial.get('status')!r} invalid")
        if trial.get("invocations") != 1 and trial.get("status") != "setup_failed":
            errors.append(f"trials.{arm} has {trial.get('invocations')} invocations; exactly 1 allowed")
        if trial.get("retries", 0) != 0:
            errors.append(f"trials.{arm} recorded retries")
        grade = record["grades"][arm]
        if "passed" not in grade:
            errors.append(f"grades.{arm} missing verdict")
        if records_dir is not None and trial.get("patch_file"):
            patch_path = records_dir / trial["patch_file"]
            if not patch_path.exists():
                errors.append(f"trials.{arm} patch file missing")
            elif sha256_file(patch_path) != trial.get("patch_sha256"):
                errors.append(f"trials.{arm} patch hash mismatch")
            elif grade.get("patch_sha256") != trial.get("patch_sha256"):
                errors.append(f"grades.{arm} graded a different patch than the trial produced")
    if record["arms"]["baseline"].get("snapshot_tree") == record["arms"]["treatment"].get("snapshot_tree"):
        errors.append("baseline and treatment snapshots are identical; structural delta missing")
    return errors


# ── Pilot ────────────────────────────────────────────────────

def preflight(work_dir: Path, state_dir: Path, auth_dir: str | None, m: dict[str, Any]) -> dict[str, Any]:
    assert_pinned_inputs()
    source = ensure_source(m)
    denial = access_denial_controls(work_dir, state_dir, auth_dir)
    equivalence, controls = run_gate_suites(work_dir, m)
    return {"source": source, "access_denial": denial, "equivalence": equivalence, "controls": controls,
            "ok": denial["ok"] and equivalence["ok"] and controls["ok"]}


def execute_trial(arm: str, pair_dir: Path, raw_dir: Path, ledger: Ledger, pinned: dict[str, Any], prompt: str,
                  state_dir: Path, work_root: Path, m: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    trial_root = pair_dir / f"trial-{arm}"
    repo = trial_root / "repo"
    try:
        snap = build_snapshot(repo, arm, install=True, m=m)
    except EvalError as exc:
        ledger.append("setup_failed", arm=arm, error=sanitize(str(exc)))
        return {"status": "setup_failed", "error": sanitize(str(exc)), "invocations": 0, "retries": 0}, {}
    plan = isolation_plan(repo, state_dir, work_root, pinned.get("auth_config_dir"))
    profile_path = trial_root / "sandbox.sb"
    profile_path.write_text(sandbox_profile(plan))
    config = trial_config(pinned, sha256_bytes(prompt.encode()), plan, m)
    argv, env_extra = render_invocation(pinned, prompt)
    stdout_path, stderr_path = raw_dir / f"{arm}.stdout.jsonl", raw_dir / f"{arm}.stderr.txt"
    ledger.append("trial_start", arm=arm, snapshot_tree=snap["tree"], config_sha256=canonical_hash(config))
    proc = run_process_group(["/usr/bin/sandbox-exec", "-f", str(profile_path), *argv], cwd=repo,
                             env=base_env(env_extra), timeout_s=pinned["timeout_seconds"],
                             stdout_path=stdout_path, stderr_path=stderr_path)
    telemetry = parse_telemetry(pinned["telemetry"], stdout_path.read_text(encoding="utf-8", errors="replace"))
    patch = capture_diff(repo, snap["commit"])
    status = ("timed_out" if proc["timed_out"] else
              "completed" if proc["exit"] == 0 and not telemetry.get("is_error") else "agent_error")
    ledger.append("trial_end", arm=arm, status=status, exit=proc["exit"], timed_out=proc["timed_out"],
                  wall_seconds=proc["wall_seconds"], patch_sha256=sha256_bytes(patch))
    trial = {"status": status, "exit": proc["exit"], "timed_out": proc["timed_out"],
             "wall_seconds": proc["wall_seconds"], "invocations": 1, "retries": 0,
             "human_intervention": "none", "telemetry": telemetry, "patch": patch,
             "patch_sha256": sha256_bytes(patch), "patch_paths": changed_paths(patch),
             "stderr_tail": sanitize(tail(stderr_path.read_bytes(), 8))}
    arm_info = {"snapshot_commit": snap["commit"], "snapshot_tree": snap["tree"],
                "install": snap.get("install"), "config_sha256": canonical_hash(config)}
    return trial, {"arm": arm_info, "config": config}


def pilot(args: argparse.Namespace) -> int:
    m = manifest()
    runners = load_runners()
    sel = runners["selection"]
    harness = args.harness or sel["harness"]
    if harness == "selftest" and not args._selftest:
        raise EvalError("the selftest harness is only allowed inside self-test")
    pair_id = args.pair_id
    records_dir = Path(args.records_dir)
    pair_dir_record = records_dir / pair_id
    state_dir = Path(args.state_dir)
    ledger = Ledger(state_dir / m["experiment_id"] / pair_id / "ledger.jsonl")
    if (pair_dir_record / "pair.json").exists():
        raise EvalError(f"pair {pair_id} already has a committed record; a new pair needs a new id")
    prior = {arm: ledger.arm_state(arm) for arm in ARMS}
    if any(state != "none" for state in prior.values()) and not args.resume:
        raise EvalError(f"ledger already has attempts for {pair_id} ({prior}); rerun with --resume to finalize "
                        "without buying new trials")
    registry = runners["harnesses"] if not args._selftest else {**runners["harnesses"], **args._selftest}
    pinned = resolve_harness(harness, args.model or sel["model"], args.effort or sel["effort"],
                             float(args.budget_usd or sel["budget_usd"]),
                             int(args.timeout or sel["trial_timeout_seconds"]), registry)
    if pinned["timeout_seconds"] > 900:
        raise EvalError("trial timeout above 15 minutes is not allowed")
    prompt = (HERE / m["task"]["prompt"]).read_text(encoding="utf-8")
    work_root = Path(args.work_root)
    pair_dir = Path(realpath(work_root)) / f"{pair_id}-{secrets.token_hex(3)}"
    raw_dir = state_dir / m["experiment_id"] / pair_id / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    pair_dir.mkdir(parents=True, exist_ok=True)

    events = ledger.events()
    order_event = next((e for e in events if e["event"] == "order"), None)
    pre_event = next((e for e in events if e["event"] == "preflight"), None)
    if pre_event is None:
        pre = getattr(args, "_preflight", None) or preflight(pair_dir, state_dir, pinned.get("auth_config_dir"), m)
        write_json(state_dir / m["experiment_id"] / pair_id / "preflight.json", pre)
        ledger.append("preflight", ok=pre["ok"])
        if not pre["ok"]:
            print(json.dumps({k: pre[k]["ok"] for k in ("access_denial", "equivalence", "controls")}))
            raise EvalError("preflight failed; trials are not permitted")
    pre = load_json(state_dir / m["experiment_id"] / pair_id / "preflight.json")
    if order_event is None:
        seed = secrets.token_hex(8)
        order = list(ARMS)
        random.Random(seed).shuffle(order)
        order_event = ledger.append("order", seed=seed, order=order, pinned={k: pinned[k] for k in (
            "harness", "binary", "binary_sha256", "version", "model", "effort", "budget_usd", "timeout_seconds")})
    order = order_event["order"]
    trials, arms, configs = {}, {}, {}
    for arm in order:
        state = ledger.arm_state(arm)
        if state == "started":
            ledger.append("abandoned_partial", arm=arm, note="trial_start without trial_end found on resume")
            trials[arm] = {"status": "abandoned_partial", "invocations": ledger.invocations(arm), "retries": 0,
                           "patch": b"", "patch_sha256": sha256_bytes(b""), "patch_paths": []}
            continue
        if state == "finished":
            raise EvalError(f"{arm} already finished in the ledger but no committed record exists; "
                            "inspect the raw directory instead of rerunning")
        print(f"[pilot] running {arm} ({order.index(arm) + 1}/2) with {pinned['harness']} {pinned['model']}",
              flush=True)
        trial, extra = execute_trial(arm, pair_dir, raw_dir, ledger, pinned, prompt, state_dir, work_root, m)
        trials[arm] = trial
        if extra:
            arms[arm] = extra["arm"]
            configs[arm] = extra["config"]
    for arm in ARMS:
        if arm not in configs:
            plan = isolation_plan(pair_dir / f"trial-{arm}" / "repo", state_dir, work_root,
                                  pinned.get("auth_config_dir"))
            configs[arm] = trial_config(pinned, sha256_bytes(prompt.encode()), plan, m)
            arms[arm] = {"config_sha256": canonical_hash(configs[arm]), "snapshot_tree": None}
    out_dir = records_dir / pair_id
    (out_dir / "patches").mkdir(parents=True, exist_ok=True)
    grades = {}
    for arm in ARMS:
        patch = trials[arm].pop("patch")
        patch_file = f"patches/{arm}.patch"
        (out_dir / patch_file).write_bytes(patch)
        trials[arm]["patch_file"] = patch_file
        print(f"[pilot] grading {arm} in a fresh evaluator copy", flush=True)
        grades[arm] = grade_patch(arm, patch, pair_dir, m)
        ledger.append("graded", arm=arm, passed=grades[arm].get("passed"), reason=grades[arm].get("reason"))
    record = {"experiment_id": m["experiment_id"], "pair_id": pair_id, "created_at": now_iso(),
              "source": pre["source"], "task_id": m["task"]["id"], "order": order,
              "order_seed": order_event["seed"], "arms": arms, "configs": configs, "trials": trials,
              "grades": grades, "preflight": pre, "expected_hidden_tests": m["grader"]["expected_tests"],
              "pinned_inputs": {k: v for k, v in m["pinned_files"].items()},
              "costs": cost_summary(trials), "selftest": bool(args._selftest)}
    errors = validate_pair(record, out_dir)
    record["validation_errors"] = errors
    write_json(out_dir / "pair.json", record)
    shutil.copyfile(ledger.path, out_dir / "ledger.jsonl")
    (out_dir / "report.html").write_text(render_report(record, out_dir), encoding="utf-8")
    if not args.keep:
        shutil.rmtree(pair_dir, ignore_errors=True)
    print(json.dumps({"pair_id": pair_id, "order": order,
                      "outcomes": {a: {"trial": trials[a]["status"], "graded_pass": grades[a].get("passed"),
                                       "reason": grades[a].get("reason")} for a in ARMS},
                      "validation_errors": errors}, indent=2))
    return 0 if not errors else 1


def cost_summary(trials: dict[str, Any]) -> dict[str, Any]:
    rows = {}
    for arm, trial in trials.items():
        tel = trial.get("telemetry") or {}
        rows[arm] = {"cost_usd": tel.get("cost_usd"), "cost_source": tel.get("cost_source", "missing"),
                     "usage": tel.get("usage")}
    dollars_complete = all(r["cost_usd"] is not None for r in rows.values())
    return {"measured_trials": rows,
            "dollar_telemetry_complete": dollars_complete,
            "dollar_efficiency_conclusion_allowed": False,
            "note": ("One pair cannot support an efficiency conclusion. Reported dollars are the harness's own "
                     "client-side estimate; no prices were invented and token totals are not converted to dollars."),
            "setup_costs": "no model calls outside the two trials; authoring-session cost is not measured here"}


# ── Verify recorded ──────────────────────────────────────────

def verify_recorded(args: argparse.Namespace) -> int:
    m = manifest()
    records_dir = Path(args.records_dir)
    pair_ids = [args.pair_id] if args.pair_id else sorted(p.name for p in records_dir.iterdir()
                                                        if (p / "pair.json").exists())
    if not pair_ids:
        print("FAIL no recorded pairs found")
        return 1
    failures = 0

    def check(ok: bool, label: str) -> None:
        nonlocal failures
        print(f"{'PASS' if ok else 'FAIL'} {label}")
        failures += 0 if ok else 1

    for row in verify_pinned_inputs(m):
        check(row["ok"], f"pinned input {row['file']} sha256 matches manifest")
    source = ensure_source(m)
    check(source["tree"] == m["source"]["tree"], f"source {source['commit'][:12]} tree {source['tree'][:12]}")
    for pair_id in pair_ids:
        out_dir = records_dir / pair_id
        record = load_json(out_dir / "pair.json")
        errors = validate_pair(record, out_dir)
        check(not errors, f"{pair_id}: pair record complete and configs identical {errors or ''}")
        check(not record.get("selftest"), f"{pair_id}: record came from a real harness run, not the self-test fake")
        check(record["pinned_inputs"] == m["pinned_files"], f"{pair_id}: recorded pinned inputs match manifest")
        check(record["source"]["commit"] == m["source"]["commit"], f"{pair_id}: source commit matches manifest")
        ledger_events = [json.loads(line) for line in (out_dir / "ledger.jsonl").read_text().splitlines() if line]
        for arm in ARMS:
            starts = sum(1 for e in ledger_events if e["event"] == "trial_start" and e.get("arm") == arm)
            check(starts <= 1, f"{pair_id}: ledger shows {starts} invocation(s) for {arm}")
            end = next((e for e in ledger_events if e["event"] == "trial_end" and e.get("arm") == arm), None)
            if end:
                check(end["patch_sha256"] == record["trials"][arm]["patch_sha256"],
                      f"{pair_id}: {arm} ledger patch hash matches recorded patch")
        pre = record.get("preflight", {})
        check(bool(pre.get("ok")), f"{pair_id}: preflight (access denial, equivalence, controls) passed before trials")
        with tempfile.TemporaryDirectory(prefix="archmem-verify-", dir=_ensure(Path(args.work_root))) as tmp:
            for arm in ARMS:
                snap = build_snapshot(Path(tmp) / f"snap-{arm}", arm, install=False, m=m)
                recorded_tree = record["arms"][arm].get("snapshot_tree")
                check(recorded_tree in (None, snap["tree"]),
                      f"{pair_id}: {arm} snapshot rebuilds to recorded tree {str(recorded_tree)[:12]}")
            regrades = {}
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futs = {arm: pool.submit(grade_patch, arm, (out_dir / record["trials"][arm]["patch_file"]).read_bytes(),
                                         Path(tmp), m) for arm in ARMS}
                regrades = {arm: fut.result() for arm, fut in futs.items()}
            for arm in ARMS:
                old, new = grade_summary(record["grades"][arm]), grade_summary(regrades[arm])
                print(f"     {arm}: recorded passed={old['passed']} ({old['reason']}), "
                      f"regraded passed={new['passed']} ({new['reason']}), hidden exit {new['hidden_exit']}")
                for line in (regrades[arm].get("hidden") or {}).get("summary_lines", [])[-4:]:
                    print(f"       | {line}")
                check(old == new, f"{pair_id}: {arm} regrade in a fresh copy reproduces the recorded verdict and "
                                  "per-check statuses")
    print(f"verify-recorded: {'OK' if failures == 0 else f'{failures} failure(s)'}")
    return 0 if failures == 0 else 1


def _ensure(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


# ── Report ───────────────────────────────────────────────────

def render_report(record: dict[str, Any], out_dir: Path) -> str:
    e = html.escape
    pre = record.get("preflight", {})

    def table(headers: list[str], rows: list[list[Any]]) -> str:
        head = "".join(f"<th>{e(str(h))}</th>" for h in headers)
        body = "".join("<tr>" + "".join(f"<td>{e(str(c))}</td>" for c in row) + "</tr>" for row in rows)
        return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"

    trial_rows = []
    for arm in ARMS:
        t, g = record["trials"][arm], record["grades"][arm]
        tel = t.get("telemetry") or {}
        usage = tel.get("usage") or {}
        trial_rows.append([arm, record["order"].index(arm) + 1, t.get("status"), t.get("exit"),
                           t.get("wall_seconds"), "PASS" if g.get("passed") else "FAIL", g.get("reason"),
                           f"{(g.get('hidden') or {}).get('passed')}/{record.get('expected_hidden_tests')}",
                           usage.get("input_tokens"), usage.get("output_tokens"),
                           usage.get("cache_read_input_tokens"), tel.get("cost_usd"), tel.get("num_turns"),
                           ", ".join(t.get("patch_paths") or []) or "(no diff)"])
    check_rows = []
    for arm in ARMS:
        for side in ("hidden", "regression"):
            res = record["grades"][arm].get(side) or {}
            for test in res.get("tests", []):
                if side == "hidden" or test["status"] != "passed":
                    check_rows.append([arm, side, test["name"], test["status"], test.get("failure", "")[:300]])
            check_rows.append([arm, side, f"exit code of: {res.get('command', '')}", res.get("exit"), ""])
    controls = [[r["arm"], r["control"], r["expect"], r["actual"], "ok" if r["ok"] else "MISMATCH",
                 r["hidden_exit"], f"{r['hidden_passed']}/{(r['hidden_passed'] or 0) + (r['hidden_failed'] or 0)}",
                 "; ".join(r["failing_hidden_tests"])[:200]] for r in pre.get("controls", {}).get("rows", [])]
    denial = [[r["probe"], r["expect"], r["observed"], r["exit"], "ok" if r["ok"] else "MISMATCH"]
              for r in pre.get("access_denial", {}).get("rows", [])]
    eq = pre.get("equivalence", {})
    eq_rows = [[arm, v.get("exit"), v.get("passed"), v.get("failed"), v.get("snapshot_tree", "")[:12]]
               for arm, v in eq.get("arms", {}).items()]
    cfg = record["configs"]["baseline"]
    harness = cfg["harness"]
    patches = ""
    for arm in ARMS:
        path = out_dir / record["trials"][arm].get("patch_file", "")
        text = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
        patches += f"<h3>{e(arm)} patch <code>{e(record['trials'][arm].get('patch_sha256', '')[:16])}</code></h3>"
        patches += f"<pre>{e(text) or '(empty)'}</pre>"
    finals = "".join(f"<h3>{e(arm)}</h3><pre>{e((record['trials'][arm].get('telemetry') or {}).get('final_message', ''))}</pre>"
                     for arm in ARMS)
    costs = record.get("costs", {})
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Architecture-as-memory pilot pair {e(record['pair_id'])}</title>
<style>
body{{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:1100px;margin:2em auto;padding:0 1em;color:#1d1d1f}}
table{{border-collapse:collapse;width:100%;margin:0.5em 0 1.5em}}th,td{{border:1px solid #d0d0d7;padding:4px 6px;
text-align:left;vertical-align:top}}th{{background:#f3f3f6}}pre{{background:#f6f6f8;padding:8px;overflow:auto;
font-size:12px;max-height:480px}}code{{background:#f3f3f6;padding:0 3px}}.note{{background:#fff7e0;padding:8px 12px;
border-left:4px solid #e0a800}}
</style></head><body>
<h1>Architecture-as-memory: pilot pair <code>{e(record['pair_id'])}</code></h1>
<p class="note"><b>Scope.</b> One real A/B pair establishes that the apparatus executes end to end and records
externally checked outcomes. It is not evidence for or against an architecture advantage: n=1 per arm, no variance
estimate, no significance test. No dollar-efficiency conclusion is allowed.</p>
<h2>Setup</h2>
{table(["field", "value"], [
    ["source commit", record['source']['commit']], ["source tree", record['source']['tree']],
    ["task", record['task_id']], ["execution order (randomized)", " → ".join(record['order'])],
    ["order seed", record['order_seed']], ["harness", harness['harness']], ["CLI version", harness['version']],
    ["CLI binary sha256", harness['binary_sha256']], ["model", harness['model']], ["effort", harness['effort']],
    ["budget per trial (USD cap)", harness['budget_usd']], ["timeout per trial (s)", harness['timeout_seconds']],
    ["config sha256 (baseline)", record['arms']['baseline']['config_sha256']],
    ["config sha256 (treatment)", record['arms']['treatment']['config_sha256']],
    ["prompt sha256", cfg['prompt_sha256']], ["grader sha256", cfg['grader_sha256']],
    ["automatic retries", cfg['retries']], ["human intervention", ", ".join(
        f"{a}: {record['trials'][a].get('human_intervention', 'none')}" for a in ARMS)],
])}
<h2>Trial outcomes</h2>
{table(["arm", "run #", "trial status", "harness exit", "wall s", "graded", "reason", "hidden checks passed",
        "input tok", "output tok", "cache-read tok", "reported USD", "turns", "files changed"], trial_rows)}
<p>Dollar telemetry complete: {e(str(costs.get('dollar_telemetry_complete')))}. {e(costs.get('note', ''))}
Setup/development costs: {e(costs.get('setup_costs', ''))}.</p>
<h2>External checks per arm (fresh evaluator copies)</h2>
{table(["arm", "suite", "check", "status / exit", "failure excerpt"], check_rows)}
<h2>Preflight gates run before any trial</h2>
<h3>Baseline behavioral equivalence (existing facade/API tests, unpatched snapshots)</h3>
<p>Identical per-test outcomes across arms: {e(str(eq.get('identical_test_outcomes')))}</p>
{table(["arm", "exit", "passed", "failed", "snapshot tree"], eq_rows)}
<h3>Grader controls</h3>
{table(["arm", "control", "expected", "actual", "verdict", "hidden exit", "hidden passed", "failing hidden checks"], controls)}
<h3>Access-denial controls (same sandbox profile as trials)</h3>
{table(["probe", "expected", "observed", "exit", "verdict"], denial)}
<h2>What was exercised</h2>
<ul>
<li>Two snapshots from one immutable source commit; the treatment differs only by the committed structural fixture
(a shared task-command lifecycle helper in <code>WorkflowMutationFacade</code>).</li>
<li>Identical prompt, harness binary, model, effort, tools, permissions, budget, timeout and isolation profile
(normalized config hashes above are equal).</li>
<li>Trials ran under macOS <code>sandbox-exec</code> with evaluator files, other-arm copies, ledger, prior sessions and
credential stores unreadable; results were graded afterwards by evaluator-owned hidden checks in fresh copies.</li>
</ul>
<h2>What was not exercised</h2>
<ul>
<li>No typecheck: the source commit has no working per-package <code>tsc</code> entry point, so grading is behavioral
(vitest) only.</li>
<li>The codex harness is registered but was not run; only one harness/model/effort was used.</li>
<li>Network egress is allowed (the harness needs its API); publication is blocked by removing git remotes, denying
credential helpers/<code>gh</code>/Invoker CLIs, and a Bash allowlist, not by a network firewall.</li>
<li>No repeated trials, no other tasks.</li>
</ul>
<h2>What would invalidate this pair</h2>
<ul>
<li>Any verify-recorded failure: a pinned input hash drift, a patch that no longer regrades to the recorded verdict,
a snapshot that no longer rebuilds to the recorded tree, or ledger evidence of more than one invocation per arm.</li>
<li>Evidence that a trial read evaluator-owned files (the access-denial controls would have to be wrong).</li>
<li>A rerun of either arm after seeing this result, or tuning the treatment in response to it.</li>
</ul>
<h2>Later protocol (not launched)</h2>
<p>Six behavioral tasks around task-mutation handling, each frozen with its own hidden grader and bad/good controls
before any trial, five paired repeats per task (60 trials), randomized order within each pair, same pinned harness
configuration, every attempt counted, and a pre-registered primary metric (hidden-check pass rate) with a paired
analysis. Only after this apparatus pair verifies cleanly.</p>
<h2>Agent final messages (sanitized)</h2>
{finals}
<h2>Replayable patches</h2>
{patches}
</body></html>
"""


# ── Self-test ────────────────────────────────────────────────

SELFTEST_AGENT = r'''
import pathlib, sys, time
mode = sys.argv[1]
grader = sys.argv[2]
try:
    open(grader).read()
    print("LEAK: grader readable")
    sys.exit(3)
except OSError:
    pass
if mode == "sleep":
    time.sleep(3600)
if mode == "edit":
    path = pathlib.Path("packages/app/src/workflow-mutation-facade.ts")
    text = path.read_text()
    anchor = "  async deleteTask(taskId: string): Promise<MutationResult> {\n"
    method = """  async editTaskPool(taskId: string, poolId: string): Promise<MutationResult> {
    await this.closeReviewForTask(taskId);
    const started = await this.runViaCommandService(
      (cs) => cs.editTaskPool(makeEnvelope('facade.edit-task-pool', 'surface', 'task', { taskId, poolId })),
    );
    return this.finalizeWithTopup(started, 'facade.edit-task-pool', { scopedTaskIds: [taskId] });
  }

"""
    path.write_text(text.replace(anchor, method + anchor, 1))
print(f"selftest agent {mode} done")
'''


class Results:
    def __init__(self) -> None:
        self.rows: list[tuple[str, bool, str]] = []

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.rows.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'} {name}{(' — ' + detail) if detail else ''}", flush=True)


def selftest(args: argparse.Namespace) -> int:
    res = Results()
    m = manifest()
    for row in verify_pinned_inputs(m):
        res.add(f"pinned input unchanged: {row['file']}", row["ok"])
    source = ensure_source(m)
    res.add("source commit retrievable with pinned tree", source["tree"] == m["source"]["tree"],
            f"{source['commit'][:12]} tree {source['tree'][:12]}")
    unit = sh([sys.executable, "-m", "unittest", "-q", "test_run"], cwd=HERE, timeout=300)
    res.add("focused unit tests (test_run.py)", unit.returncode == 0, tail(unit.stderr, 1))
    work_root = _ensure(Path(args.work_root))
    base = Path(tempfile.mkdtemp(prefix="selftest-", dir=realpath(work_root)))
    bin_dir = Path(tempfile.mkdtemp(prefix="archmem-selftest-bin-", dir="/private/tmp"))
    state_dir = base / "state"
    records_dir = base / "records"
    try:
        runners = load_runners()
        sel = runners["selection"]
        real = resolve_harness(sel["harness"], sel["model"], sel["effort"], sel["budget_usd"],
                               sel["trial_timeout_seconds"])
        plan_a = isolation_plan(base / "trial-baseline" / "repo", state_dir, work_root, real["auth_config_dir"])
        plan_b = isolation_plan(base / "trial-treatment" / "repo", state_dir, work_root, real["auth_config_dir"])
        cfg_a = trial_config(real, "p", plan_a, m)
        cfg_b = trial_config(real, "p", plan_b, m)
        res.add("configuration equality: both arms normalize to one config hash",
                canonical_hash(cfg_a) == canonical_hash(cfg_b), canonical_hash(cfg_a)[:16])
        cfg_c = trial_config({**real, "model": real["model"] + "-other"}, "p", plan_b, m)
        res.add("configuration equality: a model change is detected", canonical_hash(cfg_a) != canonical_hash(cfg_c))
        argv, env_extra = render_invocation(real, "PROMPT")
        res.add("pinned harness argv carries model/effort/isolation flags",
                all(x in argv for x in (real["model"], real["effort"], "--setting-sources", "--strict-mcp-config"))
                and "--dangerously-skip-permissions" not in argv and "bypassPermissions" not in argv,
                f"{real['harness']} {real['version']}")

        denial = access_denial_controls(work_root, state_dir, real["auth_config_dir"])
        if denial.get("blocked"):
            res.add("protected-grader access denial", False, f"BLOCKED: {denial['blocked']}")
        for row in denial["rows"]:
            res.add(f"access control: {row['probe']} → {row['observed']} (exit {row['exit']})", row["ok"])

        agent_path = bin_dir / "selftest_agent.py"
        agent_path.write_text(SELFTEST_AGENT)

        def fake(mode: str) -> dict[str, Any]:
            return {"selftest": {"binary": sys.executable, "version_args": ["--version"],
                                 "argv": [str(agent_path), mode, str(HERE / m["grader"]["file"])],
                                 "env": {}, "telemetry": "selftest"}}

        timeout_dir = base / "timeout-trial"
        timeout_dir.mkdir()
        sleeper = resolve_harness("selftest", "none", "none", 0, 2, fake("sleep"))
        t_argv, t_env = render_invocation(sleeper, "")
        t_profile = bin_dir / "timeout.sb"
        t_profile.write_text(sandbox_profile(isolation_plan(timeout_dir, state_dir, work_root, None)))
        started = time.monotonic()
        proc = run_process_group(["/usr/bin/sandbox-exec", "-f", str(t_profile), *t_argv], timeout_dir,
                                 base_env(t_env), 2, bin_dir / "t.out", bin_dir / "t.err")
        res.add("process timeout kills the trial process group", proc["timed_out"] and time.monotonic() - started < 30,
                f"exit {proc['exit']} after {proc['wall_seconds']}s")

        eq, controls = run_gate_suites(base, m)
        for arm in ARMS:
            v = eq["arms"][arm]
            res.add(f"baseline equivalence: existing tests on unpatched {arm}",
                    v["exit"] == 0 and v["failed"] == 0, f"exit {v['exit']}, {v['passed']} passed")
        res.add("baseline equivalence: identical per-test outcomes across arms", eq["identical_test_outcomes"])
        res.add("unedited snapshots fail the same hidden checks in both arms",
                controls["unedited_fails_identically"])
        denial_for_pilot = denial
        shared_preflight = {"source": source, "access_denial": denial_for_pilot, "equivalence": eq,
                            "controls": controls,
                            "ok": denial_for_pilot["ok"] and eq["ok"] and controls["ok"]}
        for row in controls["rows"]:
            res.add(f"control {row['arm']}/{row['control']}: expect {row['expect']}, got {row['actual']} "
                    f"(hidden exit {row['hidden_exit']}, {row['hidden_passed']} passed/{row['hidden_failed']} failed)",
                    row["ok"], "; ".join(row["failing_hidden_tests"])[:160])

        pilot_args = argparse.Namespace(harness="selftest", pair_id="selftest-pair", records_dir=str(records_dir),
                                        state_dir=str(state_dir), resume=False, model="none", effort="none",
                                        budget_usd=0.01, timeout=120, work_root=str(work_root),
                                        keep=False, _selftest=fake("edit"), _preflight=shared_preflight)
        rc = pilot(pilot_args)
        record = load_json(records_dir / "selftest-pair" / "pair.json")
        res.add("fake pair runs end to end with a randomized recorded order",
                rc == 0 and sorted(record["order"]) == sorted(ARMS), f"order {record['order']}")
        res.add("fake agent could not read the grader from inside the sandbox",
                all("LEAK" not in (record["trials"][a]["telemetry"].get("final_message") or "") and
                    record["trials"][a]["status"] == "completed" for a in ARMS))
        res.add("fake pair graded in fresh copies (edit passes in both arms)",
                all(record["grades"][a].get("passed") for a in ARMS))

        rerun = argparse.Namespace(**{**vars(pilot_args)})
        try:
            pilot(rerun)
            res.add("idempotent ledger: a second pilot for a recorded pair is refused", False)
        except EvalError as exc:
            res.add("idempotent ledger: a second pilot for a recorded pair is refused", True, str(exc)[:80])

        partial_ledger = Ledger(state_dir / m["experiment_id"] / "partial-pair" / "ledger.jsonl")
        partial_ledger.append("trial_start", arm="baseline", snapshot_tree="x", config_sha256="y")
        fresh = argparse.Namespace(**{**vars(pilot_args), "pair_id": "partial-pair"})
        try:
            pilot(fresh)
            res.add("idempotent ledger: a retried task cannot re-run a started trial", False)
        except EvalError:
            res.add("idempotent ledger: a retried task cannot re-run a started trial", True)
        before = len(partial_ledger.events())
        resumed = argparse.Namespace(**{**vars(pilot_args), "pair_id": "partial-pair", "resume": True,
                                        "_selftest": fake("noop")})
        pilot(resumed)
        events = partial_ledger.events()
        precord = load_json(records_dir / "partial-pair" / "pair.json")
        res.add("resume records the partial start as abandoned and never re-invokes it",
                precord["trials"]["baseline"]["status"] == "abandoned_partial"
                and partial_ledger.invocations("baseline") == 1 and len(events) > before,
                f"baseline invocations {partial_ledger.invocations('baseline')}")
        res.add("resume still runs the untouched arm exactly once", partial_ledger.invocations("treatment") == 1
                and precord["trials"]["treatment"]["status"] == "completed")

        good = load_json(records_dir / "selftest-pair" / "pair.json")
        res.add("pair validation accepts the complete fake pair", not validate_pair(good, records_dir / "selftest-pair"))
        bad = json.loads(json.dumps(good))
        bad["configs"]["treatment"]["harness"]["model"] = "different-model"
        bad["arms"]["treatment"]["config_sha256"] = canonical_hash(bad["configs"]["treatment"])
        res.add("pair validation rejects mismatched arm configurations",
                any("differ" in err for err in validate_pair(bad, records_dir / "selftest-pair")))
        bad = json.loads(json.dumps(good))
        del bad["grades"]["treatment"]
        res.add("pair validation rejects an incomplete record",
                any("incomplete" in err for err in validate_pair(bad, records_dir / "selftest-pair")))
        bad = json.loads(json.dumps(good))
        bad["trials"]["baseline"]["invocations"] = 2
        res.add("pair validation rejects a bought extra trial",
                any("invocations" in err for err in validate_pair(bad, records_dir / "selftest-pair")))
        tampered_dir = base / "tampered"
        shutil.copytree(records_dir / "selftest-pair", tampered_dir / "selftest-pair")
        (tampered_dir / "selftest-pair" / "patches" / "baseline.patch").write_bytes(b"")
        res.add("pair validation rejects a tampered patch",
                any("hash mismatch" in err for err in validate_pair(good, tampered_dir / "selftest-pair")))

        replay = argparse.Namespace(records_dir=str(records_dir), pair_id="selftest-pair", work_root=str(work_root))
        rc_replay = verify_recorded_selftest(replay)
        res.add("replay: verify-recorded logic regrades the fake pair to its recorded verdicts", rc_replay == 0)
        replay_bad = argparse.Namespace(records_dir=str(tampered_dir), pair_id="selftest-pair",
                                        work_root=str(work_root))
        res.add("replay: verify-recorded logic fails on a tampered patch", verify_recorded_selftest(replay_bad) != 0)
    finally:
        shutil.rmtree(bin_dir, ignore_errors=True)
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
    failed = [name for name, ok, _ in res.rows if not ok]
    print(f"\nself-test: {len(res.rows) - len(failed)} passed, {len(failed)} failed")
    return 0 if not failed else 1


def verify_recorded_selftest(args: argparse.Namespace) -> int:
    m = manifest()
    out_dir = Path(args.records_dir) / args.pair_id
    record = load_json(out_dir / "pair.json")
    if validate_pair(record, out_dir):
        return 1
    with tempfile.TemporaryDirectory(prefix="archmem-replay-", dir=realpath(args.work_root)) as tmp:
        for arm in ARMS:
            patch = (out_dir / record["trials"][arm]["patch_file"]).read_bytes()
            if grade_summary(grade_patch(arm, patch, Path(tmp), m)) != grade_summary(record["grades"][arm]):
                return 1
    return 0


# ── CLI ──────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--work-root", default=str(DEFAULT_WORK_ROOT))
    common.add_argument("--keep", action="store_true")
    sub.add_parser("self-test", parents=[common])
    p = sub.add_parser("pilot", parents=[common])
    p.add_argument("--pair-id", default="pilot-001")
    p.add_argument("--harness")
    p.add_argument("--model")
    p.add_argument("--effort")
    p.add_argument("--budget-usd", type=float)
    p.add_argument("--timeout", type=int)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--records-dir", default=str(RECORDS_DIR))
    p.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))
    v = sub.add_parser("verify-recorded", parents=[common])
    v.add_argument("--pair-id")
    v.add_argument("--records-dir", default=str(RECORDS_DIR))
    args = parser.parse_args(argv)
    try:
        if args.command == "self-test":
            return selftest(args)
        if args.command == "pilot":
            args._selftest = None
            args._preflight = None
            return pilot(args)
        return verify_recorded(args)
    except EvalError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
