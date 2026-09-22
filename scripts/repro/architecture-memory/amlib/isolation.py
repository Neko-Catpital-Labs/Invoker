"""Filesystem isolation for trial agents, plus the controls that prove it works.

The trial agent runs under a macOS Seatbelt profile that denies reads and writes
to the evaluator-owned paths: the checked-out repository (which contains this
evaluator, its grader, and its gold patches) and the run's private directory
(which holds the pristine snapshots and every recorded result). Trial
workspaces live outside both, so a trial can read and write only its own tree.

Denial is asserted by probe commands run through the same wrapper, so an
isolation regression fails self-test instead of silently un-blinding a trial.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence

from .util import CommandOutcome, run_command

PROBE_TIMEOUT_SECONDS = 60

USER_MEMORY_CANDIDATES = (
    ".claude/CLAUDE.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/history.jsonl",
    ".claude/commands",
    ".claude/hooks",
    ".claude/plugins",
    ".claude/projects",
    ".claude/sessions",
    ".claude/skills",
    ".claude/agents",
    ".claude/plans",
    ".claude/file-history",
    ".claude/shell-snapshots",
    ".claude/memory",
    ".claude/todos",
    ".cursor",
    ".codex",
)


class IsolationUnavailable(RuntimeError):
    """Raised when no supported filesystem isolation mechanism is present."""


@dataclass
class Isolation:
    mechanism: str
    profile_path: Path
    protected_paths: list[str]
    user_memory_paths: list[str] = field(default_factory=list)

    def wrap(self, argv: Sequence[str]) -> list[str]:
        return ["sandbox-exec", "-f", str(self.profile_path), *argv]


def _real(path: Path) -> str:
    return str(Path(os.path.realpath(path)))


def user_memory_paths() -> list[Path]:
    """Existing cross-session memory and plugin locations under the operator's home.

    Redirecting the harness config directory would also drop the operator's
    credentials, so these channels are closed at the filesystem layer instead and
    proven closed by probes.
    """
    home = Path.home()
    return [home / candidate for candidate in USER_MEMORY_CANDIDATES if (home / candidate).exists()]


def build_isolation(
    profile_path: Path,
    protected_paths: Sequence[Path],
    memory_paths: Sequence[Path] | None = None,
) -> Isolation:
    if os.uname().sysname != "Darwin" or shutil.which("sandbox-exec") is None:
        raise IsolationUnavailable(
            "sandbox-exec is required for verified trial isolation on this host; "
            "no substitute mechanism is configured"
        )
    resolved = sorted({_real(path) for path in protected_paths})
    memory = list(memory_paths) if memory_paths is not None else user_memory_paths()
    lines = ["(version 1)", "(allow default)"]
    for path in resolved:
        lines.append(f'(deny file-read* (subpath "{path}"))')
        lines.append(f'(deny file-write* (subpath "{path}"))')
    resolved_memory: list[str] = []
    for path in sorted(memory):
        real = _real(path)
        resolved_memory.append(real)
        rule = "subpath" if Path(real).is_dir() else "literal"
        lines.append(f'(deny file-read* ({rule} "{real}"))')
        lines.append(f'(deny file-write* ({rule} "{real}"))')
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text("\n".join(lines) + "\n")
    return Isolation(
        mechanism="sandbox-exec",
        profile_path=profile_path,
        protected_paths=resolved,
        user_memory_paths=resolved_memory,
    )


def probe_read_denied(isolation: Isolation, target: Path) -> CommandOutcome:
    return run_command(
        isolation.wrap(["/bin/cat", str(target)]),
        timeout_seconds=PROBE_TIMEOUT_SECONDS,
    )


def probe_list_denied(isolation: Isolation, target: Path) -> CommandOutcome:
    return run_command(
        isolation.wrap(["/bin/ls", str(target)]),
        timeout_seconds=PROBE_TIMEOUT_SECONDS,
    )


def probe_write_denied(isolation: Isolation, target: Path) -> CommandOutcome:
    return run_command(
        isolation.wrap(["/bin/sh", "-c", f"printf tampered >> {target}"]),
        timeout_seconds=PROBE_TIMEOUT_SECONDS,
    )


def probe_workspace_allowed(isolation: Isolation, workspace: Path) -> CommandOutcome:
    return run_command(
        isolation.wrap(["/bin/sh", "-c", "printf ok > .isolation-probe && cat .isolation-probe"]),
        cwd=workspace,
        timeout_seconds=PROBE_TIMEOUT_SECONDS,
    )
