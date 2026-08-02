from __future__ import annotations

import subprocess
from pathlib import Path


class GitFactsClient:
    """Local-git read-only facts. No `gh` calls, no mutation.

    All three "landed" signals are independent and OR'd by the policy layer:
    ancestry catches direct/rebase merges, empty-diff catches squash merges
    (the merged commits are never ancestors of master), and
    all_commits_equivalent catches per-commit reword/rebase onto master.
    """

    def __init__(self, cwd: Path | str | None = None):
        self.cwd = str(cwd) if cwd is not None else None

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args,
            cwd=self.cwd,
            text=True,
            capture_output=True,
        )

    def fetch(self, remote: str = "origin", ref: str = "master", timeout: float = 30.0) -> None:
        subprocess.run(
            ["git", "fetch", remote, ref],
            cwd=self.cwd,
            check=True,
            text=True,
            capture_output=True,
            timeout=timeout,
        )

    def merge_base(self, ref_a: str, ref_b: str) -> str | None:
        completed = self._run(["git", "merge-base", ref_a, ref_b])
        if completed.returncode != 0:
            return None
        return completed.stdout.strip() or None

    def is_ancestor(self, sha: str, upstream: str = "origin/master") -> bool:
        completed = self._run(["git", "merge-base", "--is-ancestor", sha, upstream])
        return completed.returncode == 0

    def is_empty_diff(self, head_sha: str, upstream: str = "origin/master") -> bool:
        # Deliberately a direct two-ref tree comparison (no merge-base
        # subtraction): `<merge-base>..<head>` is just the PR's own diff,
        # which is never empty for a real PR. What signals a squash-merge is
        # upstream's *current tip* already matching head's tree exactly.
        completed = self._run(["git", "diff", "--quiet", upstream, head_sha])
        return completed.returncode == 0

    def all_commits_equivalent(self, head_sha: str, upstream: str = "origin/master") -> bool:
        completed = self._run(["git", "cherry", upstream, head_sha])
        if completed.returncode != 0:
            return False
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        return len(lines) > 0 and all(line.startswith("-") for line in lines)

    def patch_id(self, merge_base_sha: str, head_sha: str) -> str | None:
        diff = self._run(["git", "diff", f"{merge_base_sha}..{head_sha}"])
        if diff.returncode != 0 or not diff.stdout.strip():
            return None
        patch_id = subprocess.run(
            ["git", "patch-id", "--stable"],
            cwd=self.cwd,
            input=diff.stdout,
            text=True,
            capture_output=True,
        )
        if patch_id.returncode != 0 or not patch_id.stdout.strip():
            return None
        return patch_id.stdout.split()[0]
