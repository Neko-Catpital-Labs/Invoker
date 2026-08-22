from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import mergify_admin_requeue_repair_body as repair_body
from scripts import pr_worker_safe_push as safe_push

REAL_GIT = shutil.which("git") or "git"


def git(cwd: Path, *args: str) -> str:
    completed = subprocess.run(
        [REAL_GIT, *args],
        cwd=str(cwd),
        check=True,
        text=True,
        capture_output=True,
    )
    return completed.stdout.strip()


class RebaseOntoBaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "repo"
        git(self.root, "init", "--bare", str(self.remote))
        git(self.root, "clone", str(self.remote), str(self.repo))
        git(self.repo, "config", "user.email", "worker@example.invalid")
        git(self.repo, "config", "user.name", "Worker Test")
        git(self.repo, "checkout", "-B", "master")
        self._write("shared.txt", "shared\n")
        git(self.repo, "add", "shared.txt")
        git(self.repo, "commit", "-m", "shared base")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

    def _write(self, name: str, content: str) -> None:
        (self.repo / name).write_text(content, encoding="utf-8")

    def _commit(self, message: str, filename: str = "shared.txt", content: str = "change\n") -> str:
        target = self.repo / filename
        existing = target.read_text(encoding="utf-8") if target.exists() else ""
        target.write_text(existing + content, encoding="utf-8")
        git(self.repo, "add", filename)
        git(self.repo, "commit", "-m", message)
        return git(self.repo, "rev-parse", "HEAD")

    def test_clean_ancestry_does_not_need_rebase(self) -> None:
        git(self.repo, "checkout", "-B", "stack/clean", "master")
        head = self._commit("clean addition", "clean.txt", "clean\n")
        git(self.repo, "push", "origin", "HEAD:refs/heads/stack/clean")

        self.assertFalse(repair_body.needs_rebase_onto_base(self.repo, "master", head))

    def test_duplicate_pre_squash_commit_needs_rebase(self) -> None:
        # Mirrors PR #7727's real shape: a branch carries a commit whose content
        # was already squash-merged into master under a different SHA, so the
        # branch's own history never became an ancestor of master's tip.
        git(self.repo, "checkout", "-B", "feature", "master")
        self._commit("feature work", "feature.txt", "feature\n")
        git(self.repo, "checkout", "master")
        git(self.repo, "merge", "--squash", "feature")
        git(self.repo, "commit", "-m", "squash-merged feature")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

        git(self.repo, "checkout", "-B", "stack/stale", "feature")
        head = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "push", "origin", "HEAD:refs/heads/stack/stale")

        self.assertTrue(repair_body.needs_rebase_onto_base(self.repo, "master", head))

    def test_rebase_onto_base_pushes_clean_rebase(self) -> None:
        git(self.repo, "checkout", "-B", "feature", "master")
        self._commit("feature work", "feature.txt", "feature\n")
        git(self.repo, "checkout", "master")
        git(self.repo, "merge", "--squash", "feature")
        git(self.repo, "commit", "-m", "squash-merged feature")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

        git(self.repo, "checkout", "-B", "stack/stale", "feature")
        self._write("only-new.txt", "only new\n")
        git(self.repo, "add", "only-new.txt")
        git(self.repo, "commit", "-m", "genuinely new work")
        stale_head = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "push", "origin", "HEAD:refs/heads/stack/stale")

        new_head = repair_body.rebase_onto_base(self.repo, "master", "stack/stale", stale_head)

        self.assertIsNotNone(new_head)
        self.assertNotEqual(new_head, stale_head)
        remote_head = safe_push.remote_branch_sha("stack/stale", remote="origin", cwd=self.repo)
        self.assertEqual(remote_head, new_head)
        self.assertFalse(repair_body.needs_rebase_onto_base(self.repo, "master", new_head))
        # Only the genuinely-new file survives the rebase; the duplicate
        # pre-squash content is gone because it's already reachable via master.
        self.assertTrue((self.repo / "only-new.txt").exists())

    def test_real_conflict_aborts_without_pushing(self) -> None:
        git(self.repo, "checkout", "-B", "stack/conflict", "master")
        self._commit("conflicting change on branch", "shared.txt", "branch change\n")
        conflict_head = git(self.repo, "rev-parse", "HEAD")
        git(self.repo, "push", "origin", "HEAD:refs/heads/stack/conflict")

        git(self.repo, "checkout", "master")
        self._commit("conflicting change on master", "shared.txt", "master change\n")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

        git(self.repo, "checkout", "stack/conflict")
        result = repair_body.rebase_onto_base(self.repo, "master", "stack/conflict", conflict_head)

        self.assertIsNone(result)
        remote_head = safe_push.remote_branch_sha("stack/conflict", remote="origin", cwd=self.repo)
        self.assertEqual(remote_head, conflict_head)
        # Working tree must be left clean, not mid-rebase.
        status = git(self.repo, "status", "--porcelain")
        self.assertEqual(status, "")


class ResolveValidationBaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "repo"
        git(self.root, "init", "--bare", str(self.remote))
        git(self.root, "clone", str(self.remote), str(self.repo))
        git(self.repo, "config", "user.email", "worker@example.invalid")
        git(self.repo, "config", "user.name", "Worker Test")
        git(self.repo, "checkout", "-B", "master")
        (self.repo / "shared.txt").write_text("shared\n", encoding="utf-8")
        git(self.repo, "add", "shared.txt")
        git(self.repo, "commit", "-m", "shared base")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")
        git(self.repo, "checkout", "-B", "stack/still-here", "master")
        git(self.repo, "push", "origin", "HEAD:refs/heads/stack/still-here")
        git(self.repo, "checkout", "master")

    def test_existing_remote_branch_is_kept(self) -> None:
        base = repair_body.resolve_validation_base(self.repo, "stack/still-here", {"baseRefName": "master"})
        self.assertEqual(base, "stack/still-here")

    def test_deleted_remote_branch_falls_back_to_live_pr_base(self) -> None:
        # Simulates a stacked prerequisite PR merging and its branch being
        # deleted (GitHub auto-retargets the dependent PR) while a sibling
        # PR's repair is still using the stale --base captured at start.
        base = repair_body.resolve_validation_base(
            self.repo, "stack/already-merged-and-deleted", {"baseRefName": "master"},
        )
        self.assertEqual(base, "master")

    def test_deleted_remote_branch_with_no_live_base_falls_back_to_original(self) -> None:
        base = repair_body.resolve_validation_base(self.repo, "stack/already-merged-and-deleted", {})
        self.assertEqual(base, "stack/already-merged-and-deleted")


if __name__ == "__main__":
    unittest.main(verbosity=2)
