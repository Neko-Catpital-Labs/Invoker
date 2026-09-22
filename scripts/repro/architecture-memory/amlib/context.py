"""Run context: immutable sources, both snapshots, isolation, and the grader.

Everything a subcommand needs is derived here so self-test, pilot, and
verify-recorded exercise exactly the same apparatus.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import manifest, snapshots
from .grading import Grader
from .isolation import Isolation, IsolationUnavailable, build_isolation
from .snapshots import Snapshot, SnapshotSources
from .util import sha256_file


@dataclass
class RunContext:
    root: Path
    repo_root: Path
    run_root: Path
    workspaces_root: Path
    sources: SnapshotSources
    structural_delta: Path
    prompt_path: Path
    grader: Grader
    evaluator_copies: dict[str, Snapshot]
    isolation: Isolation | None
    isolation_error: str

    def provenance(self) -> dict:
        return {
            "source_commit": self.sources.source_commit,
            "source_remote": manifest.EXPERIMENT_SOURCE_REMOTE,
            "archive_sha256": self.sources.archive_sha256,
            "manifest_sha256": sha256_file(self.root / "amlib" / "manifest.py"),
            "grader_sha256": self.grader.grader_sha256,
            "structural_delta_sha256": sha256_file(self.structural_delta),
            "prompt_sha256": sha256_file(self.prompt_path),
            "runners_sha256": sha256_file(self.root / "runners.json"),
            "redactions": list(manifest.TRIAL_WORKSPACE_REDACTIONS),
            "snapshots": {
                variant: {
                    "source_tree_sha256": copy.source_tree_sha256,
                    "target_file_sha256": copy.target_file_sha256,
                }
                for variant, copy in sorted(self.evaluator_copies.items())
            },
        }

    def sanitisation_map(self) -> dict[str, str]:
        return {
            str(self.workspaces_root): "<workspaces-root>",
            str(self.run_root): "<run-root>",
            str(self.repo_root): "<repo-root>",
            os.path.expanduser("~"): "<home>",
        }


def default_run_root(run_id: str) -> Path:
    base = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "architecture-memory-runs"
    return base / run_id


def build_context(
    root: Path,
    repo_root: Path,
    run_root: Path,
    *,
    commit: str | None = None,
    require_isolation: bool = True,
    build_evaluator_copies: bool = True,
) -> RunContext:
    run_root.mkdir(parents=True, exist_ok=True)
    workspaces_root = run_root.parent / f"{run_root.name}-workspaces"
    workspaces_root.mkdir(parents=True, exist_ok=True)
    resolved = snapshots.resolve_commit(repo_root, commit or manifest.EXPERIMENT_SOURCE_COMMIT)
    sources = snapshots.build_source_archive(repo_root, resolved, run_root / "source.tar")
    structural_delta = root / "treatment" / "structural-delta.patch"
    grader = Grader(root, sources, structural_delta)

    copies: dict[str, Snapshot] = {}
    if build_evaluator_copies:
        for variant in snapshots.VARIANTS:
            copies[variant] = snapshots.build_evaluator_copy(
                sources, variant, run_root / f"evaluator-{variant}", structural_delta
            )

    isolation: Isolation | None = None
    isolation_error = ""
    try:
        isolation = build_isolation(
            run_root / "trial-isolation.sb",
            [repo_root, run_root, Path.home() / ".invoker"],
        )
    except IsolationUnavailable as error:
        isolation_error = str(error)
        if require_isolation:
            raise SystemExit(
                "BLOCKED: verified trial isolation is unavailable on this host.\n"
                f"  {error}\n"
                "  No trial was started. Rerun on a host with a supported isolation "
                "mechanism rather than substituting a weaker benchmark."
            )

    return RunContext(
        root=root,
        repo_root=repo_root,
        run_root=run_root,
        workspaces_root=workspaces_root,
        sources=sources,
        structural_delta=structural_delta,
        prompt_path=root / "task" / "PROMPT.md",
        grader=grader,
        evaluator_copies=copies,
        isolation=isolation,
        isolation_error=isolation_error,
    )
