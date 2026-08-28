from __future__ import annotations

import subprocess
from pathlib import Path


class GitFactsClient:
    """Local-git read-only facts. No `gh` calls, no mutation.

    All four "landed" signals are independent and OR'd by the policy layer:
    ancestry catches direct/rebase merges, empty-diff catches squash merges
    (the merged commits are never ancestors of master), and
    all_commits_equivalent catches per-commit reword/rebase onto master.
    is_rebase_equivalent catches a near-duplicate PR left behind when two
    open PRs independently add the same file and only one lands (the
    other's head still textually differs from master, so the first three
    signals all miss it, even though rebasing it would produce no change).
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

    def has_conflict(self, head_sha: str, upstream: str = "origin/master") -> bool:
        """True when merging head onto upstream hits any conflict at all,
        of any kind. Used only as a corroborating signal (never sufficient
        on its own) for a probable-duplicate flag -- see
        pr_duplicate_close_plan.plan_flag_probable_duplicates.
        """
        merge_base_sha = self.merge_base(upstream, head_sha)
        if merge_base_sha is None:
            return False
        result = self._run([
            "git", "merge-tree", "--write-tree", f"--merge-base={merge_base_sha}", upstream, head_sha,
        ])
        return result.returncode != 0

    def is_rebase_equivalent(self, head_sha: str, upstream: str = "origin/master") -> bool:
        """True when head's only differences from upstream are add/add
        conflicts (the same file independently added on both sides) and
        resolving those in upstream's favor reproduces upstream's tree
        exactly.

        Deliberately narrow: a modify/modify or delete/modify conflict means
        head and upstream genuinely diverge on content that already existed
        before either branched -- auto-preferring upstream there could
        silently discard a real, intentional change, so any such conflict
        makes this return False and defers to the normal (human/repair)
        path. Only the add/add case -- two independent additions of what
        turns out to be the same thing -- is safe to auto-resolve, and only
        that case is actually left unmatched by is_ancestor/is_empty_diff/
        all_commits_equivalent (see PR #11149 vs #11159).
        """
        merge_base_sha = self.merge_base(upstream, head_sha)
        if merge_base_sha is None:
            return False
        plain = self._run([
            "git", "merge-tree", "--write-tree", f"--merge-base={merge_base_sha}", upstream, head_sha,
        ])
        if plain.returncode == 0:
            # Clean merge, no conflicts to resolve -- not this signal's job;
            # is_ancestor/is_empty_diff already cover a genuinely clean case.
            return False
        conflict_lines = [line for line in plain.stdout.splitlines() if line.startswith("CONFLICT")]
        if not conflict_lines or any("(add/add)" not in line for line in conflict_lines):
            return False
        resolved = self._run([
            "git", "merge-tree", "--write-tree", "-X", "ours",
            f"--merge-base={merge_base_sha}", upstream, head_sha,
        ])
        if resolved.returncode != 0 or not resolved.stdout.strip():
            return False
        result_tree = resolved.stdout.splitlines()[0].strip()
        upstream_tree = self._run(["git", "rev-parse", f"{upstream}^{{tree}}"])
        if upstream_tree.returncode != 0:
            return False
        return result_tree == upstream_tree.stdout.strip()

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
