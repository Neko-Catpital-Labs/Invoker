"""Shared primitives: hashing, path sanitisation, bounded subprocess runs."""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping, Sequence

NODE_MODULES = "node_modules"
ANSI_ESCAPE = re.compile("\\x1b\\[[0-9;?]*[ -/]*[@-~]")


def strip_ansi(text: str) -> str:
    return ANSI_ESCAPE.sub("", text)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sha256_tree(root: Path, skip_dirs: Iterable[str] = (NODE_MODULES, ".git")) -> str:
    """Content hash of a directory tree, ignoring build/dependency directories."""
    skip = set(skip_dirs)
    digest = hashlib.sha256()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in skip)
        rel_dir = Path(dirpath).relative_to(root)
        for name in sorted(filenames):
            rel = (rel_dir / name).as_posix()
            full = Path(dirpath) / name
            digest.update(rel.encode())
            digest.update(b"\0")
            if full.is_symlink():
                digest.update(b"symlink:" + os.readlink(full).encode())
            else:
                digest.update(sha256_file(full).encode())
            digest.update(b"\n")
    return digest.hexdigest()


def sha256_paths(paths: Sequence[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode())
        digest.update(b"\0")
        digest.update(sha256_file(path).encode())
        digest.update(b"\n")
    return digest.hexdigest()


@dataclass
class CommandOutcome:
    """A bounded subprocess result. Exit codes and output are preserved verbatim."""

    argv: list[str]
    exit_code: int
    timed_out: bool
    duration_seconds: float
    stdout: str
    stderr: str
    env_overrides: dict[str, str] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.exit_code == 0 and not self.timed_out

    def tail(self, limit: int = 4000) -> str:
        combined = strip_ansi(self.stdout + self.stderr).strip()
        return combined[-limit:]


def run_command(
    argv: Sequence[str],
    *,
    cwd: Path | None = None,
    timeout_seconds: float,
    env: Mapping[str, str] | None = None,
    stdin_text: str | None = None,
) -> CommandOutcome:
    merged = dict(os.environ)
    if env:
        merged.update(env)
    started = time.monotonic()
    try:
        completed = subprocess.run(
            list(argv),
            cwd=str(cwd) if cwd else None,
            env=merged,
            input=stdin_text,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
        return CommandOutcome(
            argv=list(argv),
            exit_code=completed.returncode,
            timed_out=False,
            duration_seconds=time.monotonic() - started,
            stdout=completed.stdout,
            stderr=completed.stderr,
            env_overrides=dict(env or {}),
        )
    except subprocess.TimeoutExpired as expired:
        return CommandOutcome(
            argv=list(argv),
            exit_code=124,
            timed_out=True,
            duration_seconds=time.monotonic() - started,
            stdout=_decode(expired.stdout),
            stderr=_decode(expired.stderr),
            env_overrides=dict(env or {}),
        )


def _decode(value: bytes | str | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def clone_tree(source: Path, destination: Path) -> None:
    """Copy-on-write clone where the filesystem supports it, plain copy otherwise."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    if _supports_clonefile():
        outcome = run_command(["cp", "-Rc", str(source), str(destination)], timeout_seconds=1800)
        if outcome.ok:
            return
        if destination.exists():
            shutil.rmtree(destination, ignore_errors=True)
    shutil.copytree(source, destination, symlinks=True)


def _supports_clonefile() -> bool:
    return os.uname().sysname == "Darwin"


def sanitise(text: str, replacements: Mapping[str, str]) -> str:
    for needle, token in replacements.items():
        if needle:
            text = text.replace(needle, token)
    return text


def tree_file_hashes(root: Path, skip_dirs: Iterable[str] = (NODE_MODULES, ".git")) -> dict[str, str]:
    """Per-file content hashes, keyed by path relative to `root`."""
    skip = set(skip_dirs)
    hashes: dict[str, str] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(name for name in dirnames if name not in skip)
        rel_dir = Path(dirpath).relative_to(root)
        for name in sorted(filenames):
            full = Path(dirpath) / name
            rel = (rel_dir / name).as_posix()
            if full.is_symlink():
                hashes[rel] = "symlink:" + os.readlink(full)
            else:
                hashes[rel] = sha256_file(full)
    return hashes
