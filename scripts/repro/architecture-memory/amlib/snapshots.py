"""Trial and evaluator snapshots built from one immutable upstream commit.

Both arms come from the same commit. The only difference between them is the
structural-delta fixture patch, which is applied to experimental copies only and
never to the submitted product tree.
"""

from __future__ import annotations

import os
import subprocess
import shutil
import tarfile
from dataclasses import dataclass
from pathlib import Path

from . import manifest
from .util import NODE_MODULES, clone_tree, run_command, sha256_file, sha256_tree

VARIANTS = ("baseline", "treatment")


@dataclass
class SnapshotSources:
    """Where the immutable source archive and the dependency tree come from."""

    archive: Path
    node_modules_donor: Path
    source_commit: str
    archive_sha256: str


def resolve_commit(repo_root: Path, commit: str, *, allow_fetch: bool = True) -> str:
    probe = run_command(["git", "cat-file", "-t", commit], cwd=repo_root, timeout_seconds=60)
    if probe.ok and probe.stdout.strip() == "commit":
        return commit
    if not allow_fetch:
        raise SystemExit(f"commit {commit} is not present locally")
    fetch = run_command(
        ["git", "fetch", "--no-tags", manifest.EXPERIMENT_SOURCE_REMOTE, commit],
        cwd=repo_root,
        timeout_seconds=900,
    )
    if not fetch.ok:
        raise SystemExit(f"could not fetch {commit} from {manifest.EXPERIMENT_SOURCE_REMOTE}:\n{fetch.tail()}")
    return commit


def build_source_archive(repo_root: Path, commit: str, destination: Path) -> SnapshotSources:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as handle:
        completed = subprocess.run(
            ["git", "archive", "--format=tar", commit],
            cwd=str(repo_root),
            stdout=handle,
            stderr=subprocess.PIPE,
            timeout=600,
        )
    if completed.returncode != 0:
        raise SystemExit(f"git archive failed: {completed.stderr.decode('utf-8', 'replace')}")
    return SnapshotSources(
        archive=destination,
        node_modules_donor=repo_root,
        source_commit=commit,
        archive_sha256=sha256_file(destination),
    )


def extract_source(archive: Path, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r") as tar:
        tar.extractall(target, filter="data")


def wipe_source(target: Path) -> None:
    """Delete every non-dependency file, leaving node_modules trees intact."""
    for entry in sorted(target.iterdir()):
        if entry.name in {NODE_MODULES, ".git"}:
            continue
        if entry.is_dir() and not entry.is_symlink():
            _wipe_dir(entry)
            if not any(entry.iterdir()):
                entry.rmdir()
        else:
            entry.unlink()


def _wipe_dir(directory: Path) -> None:
    for entry in sorted(directory.iterdir()):
        if entry.name == NODE_MODULES:
            continue
        if entry.is_dir() and not entry.is_symlink():
            _wipe_dir(entry)
            if not any(entry.iterdir()):
                entry.rmdir()
        else:
            entry.unlink()


def install_node_modules(donor: Path, target: Path) -> None:
    clone_tree(donor / NODE_MODULES, target / NODE_MODULES)
    for package_dir in sorted((donor / "packages").iterdir()):
        source = package_dir / NODE_MODULES
        if source.is_dir():
            destination = target / "packages" / package_dir.name / NODE_MODULES
            if destination.exists():
                shutil.rmtree(destination)
            clone_tree(source, destination)


def apply_patch(workspace: Path, patch: Path, *, reverse: bool = False) -> None:
    argv = ["git", "apply", "--whitespace=nowarn"]
    if reverse:
        argv.append("--reverse")
    argv.append(str(patch))
    outcome = run_command(argv, cwd=workspace, timeout_seconds=120)
    if not outcome.ok:
        raise SystemExit(f"failed to apply {patch.name} in {workspace.name}: {outcome.tail()}")


def redact_discussion_artifacts(workspace: Path) -> list[str]:
    """Remove prose instruction/history files from a trial workspace.

    The claim under test is that *code structure* carries the knowledge, so both
    arms lose every prose channel that could carry it instead. The list is
    identical for both arms and is recorded in the pair record.
    """
    removed: list[str] = []
    for relative in manifest.TRIAL_WORKSPACE_REDACTIONS:
        target = workspace / relative
        if not target.exists():
            continue
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
        removed.append(relative)
    return removed


def git_init_snapshot(workspace: Path) -> str:
    for argv in (
        ["git", "init", "-q", "-b", "snapshot"],
        ["git", "add", "-A"],
        [
            "git",
            "-c",
            "user.name=architecture-memory-evaluator",
            "-c",
            "user.email=evaluator@invalid",
            "commit",
            "-q",
            "-m",
            "trial snapshot",
        ],
    ):
        outcome = run_command(argv, cwd=workspace, timeout_seconds=600, env={"GIT_CONFIG_GLOBAL": os.devnull})
        if not outcome.ok:
            raise SystemExit(f"{' '.join(argv)} failed in {workspace}: {outcome.tail()}")
    head = run_command(["git", "rev-parse", "HEAD"], cwd=workspace, timeout_seconds=60)
    return head.stdout.strip()


@dataclass
class Snapshot:
    variant: str
    path: Path
    source_tree_sha256: str
    target_file_sha256: str


def build_trial_workspace(
    sources: SnapshotSources,
    variant: str,
    path: Path,
    structural_delta: Path,
) -> Snapshot:
    if path.exists():
        shutil.rmtree(path)
    extract_source(sources.archive, path)
    if variant == "treatment":
        apply_patch(path, structural_delta)
    redact_discussion_artifacts(path)
    install_node_modules(sources.node_modules_donor, path)
    git_init_snapshot(path)
    return _describe(variant, path)


def build_evaluator_copy(
    sources: SnapshotSources,
    variant: str,
    path: Path,
    structural_delta: Path,
) -> Snapshot:
    """A clean grading copy: never handed to a trial agent, never redacted."""
    if path.exists():
        shutil.rmtree(path)
    extract_source(sources.archive, path)
    if variant == "treatment":
        apply_patch(path, structural_delta)
    install_node_modules(sources.node_modules_donor, path)
    return _describe(variant, path)


def reset_evaluator_copy(
    sources: SnapshotSources,
    variant: str,
    path: Path,
    structural_delta: Path,
    expected: Snapshot,
) -> None:
    wipe_source(path)
    extract_source(sources.archive, path)
    if variant == "treatment":
        apply_patch(path, structural_delta)
    actual = _describe(variant, path)
    if actual.source_tree_sha256 != expected.source_tree_sha256:
        raise SystemExit(
            f"evaluator copy {path} did not reset to its pristine {variant} state"
        )


def _describe(variant: str, path: Path) -> Snapshot:
    return Snapshot(
        variant=variant,
        path=path,
        source_tree_sha256=sha256_tree(path),
        target_file_sha256=sha256_file(path / manifest.TARGET_FILE),
    )
