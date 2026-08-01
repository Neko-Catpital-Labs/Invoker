from __future__ import annotations

import subprocess
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
