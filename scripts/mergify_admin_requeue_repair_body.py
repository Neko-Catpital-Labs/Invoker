from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

try:
    from .mergify_admin_requeue_snapshot import run_logged
except ImportError:
    from mergify_admin_requeue_snapshot import run_logged


def git_output(cwd: Path, *args: str) -> str:
    return run_logged(["git", *args], cwd=cwd)


def git_lines(cwd: Path, *args: str) -> tuple[str, ...]:
    return tuple(line.strip() for line in git_output(cwd, *args).splitlines() if line.strip())


def hard_reset_work_root(cwd: Path, target: str) -> None:
    git_output(cwd, "reset", "--hard", target)
    git_output(cwd, "clean", "-fd")


def is_ancestor(cwd: Path, ancestor: str, descendant: str) -> bool:
    if not cwd.exists():
        return True
    completed = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(cwd),
        check=False,
        text=True,
        capture_output=True,
    )
    return completed.returncode == 0


def normalize_repair_commit(cwd: Path, start_head: str, end_head: str, check_name: str) -> str:
    if is_ancestor(cwd, start_head, end_head):
        return end_head
    diff = git_output(cwd, "diff", "--binary", start_head, end_head)
    hard_reset_work_root(cwd, start_head)
    if not diff.strip():
        return start_head
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
        handle.write(diff)
        patch_path = Path(handle.name)
    try:
        git_output(cwd, "apply", "--index", str(patch_path))
    finally:
        patch_path.unlink(missing_ok=True)
    if not git_lines(cwd, "status", "--porcelain"):
        return start_head
    git_output(cwd, "commit", "-m", f"Repair {check_name}")
    return git_output(cwd, "rev-parse", "HEAD").strip()
