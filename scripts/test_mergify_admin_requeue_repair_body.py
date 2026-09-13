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


PR_10742_LIVE_VALIDATION = {
    # Captured verbatim from the real wf-1787861446614-2/normalize task
    # failure on PR #10742 (2026-08-27): a "routing"-lane repair that fixed
    # scripts/with-invoker-development-profile.mjs (tooling-policy) plus its
    # test and docs/getting-started.md (docs). See
    # docs/incidents/2026-08-16-mergify-admin-bypass-thrash-review-followups.md
    # for the review context this class of failure belongs to.
    "valid": False,
    "errors": [
        "Review lane behavior cannot ship with docs, policy files in the same "
        "PR. Split behavior or cleanup from docs, policy, repro, and "
        "benchmark slices.",
        'PR body Review Unit "routing" cannot ship with tooling-policy, docs '
        "files in the same PR. Split this into one Review Unit per PR.",
    ],
    "reviewLane": "behavior",
    "reviewUnit": "routing",
    "reviewUnits": ["routing", "tooling-policy", "docs"],
    "scopeKinds": ["docs", "policy"],
}


class PrereqSplitValidationTests(unittest.TestCase):
    def test_live_pr_10742_shape_is_prereq_splittable_on_trunk(self) -> None:
        self.assertTrue(
            repair_body.is_incidental_tooling_docs_addition(PR_10742_LIVE_VALIDATION)
        )
        self.assertTrue(
            repair_body.is_prereq_split_validation(PR_10742_LIVE_VALIDATION, "master")
        )

    def test_non_trunk_base_still_blocks_for_human_split(self) -> None:
        self.assertFalse(
            repair_body.is_prereq_split_validation(PR_10742_LIVE_VALIDATION, "stack/base")
        )

    def test_extra_unit_outside_tooling_or_docs_is_not_auto_splittable(self) -> None:
        genuinely_mixed = {
            **PR_10742_LIVE_VALIDATION,
            "reviewUnits": ["routing", "tooling-policy", "write-path"],
        }
        self.assertFalse(repair_body.is_incidental_tooling_docs_addition(genuinely_mixed))
        self.assertFalse(repair_body.is_prereq_split_validation(genuinely_mixed, "master"))

    def test_valid_body_is_never_prereq_splittable(self) -> None:
        self.assertFalse(
            repair_body.is_incidental_tooling_docs_addition({"valid": True, "errors": []})
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
