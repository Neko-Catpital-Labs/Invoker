"""Behavioural tests for pr_duplicate_close_exec's git-fact computation.

Runs real `git` against a throwaway sandbox repo (same convention as
test_pr_duplicate_close_git_facts.py), because this is exactly the
distinction that was wrong before: a same-diff duplicate comparison must
diff each PR against its own base, not always against master. See
scripts/pr_duplicate_close_exec.py's _compute_patch_id.

Run:  python3 scripts/test_pr_duplicate_close_exec.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pr_duplicate_close_exec import _compute_patch_id
from pr_duplicate_close_git_facts import GitFactsClient
from pr_duplicate_close_model import CandidatePr


def run(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, text=True, capture_output=True,
    ).stdout.strip()


def write_and_commit(repo: Path, filename: str, content: str, message: str) -> str:
    (repo / filename).write_text(content, encoding="utf-8")
    run(repo, "add", filename)
    run(repo, "commit", "-m", message)
    return run(repo, "rev-parse", "HEAD")


def candidate(**kw) -> CandidatePr:
    base = dict(
        number=1, title="t", url="u", state="OPEN", is_draft=False,
        head_ref_name="branch", base_ref_name="master", head_ref_oid="",
    )
    base.update(kw)
    return CandidatePr(**base)


class ComputePatchIdTestCase(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.remote = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.repo, ignore_errors=True))
        self.addCleanup(lambda: shutil.rmtree(self.remote, ignore_errors=True))
        run(self.remote, "init", "-q", "--bare")
        run(self.repo, "init", "-q", "-b", "master")
        run(self.repo, "config", "user.email", "test@example.com")
        run(self.repo, "config", "user.name", "Test")
        run(self.repo, "remote", "add", "origin", str(self.remote))
        write_and_commit(self.repo, "base.txt", "base\n", "base commit")
        run(self.repo, "push", "-q", "origin", "master")
        self.client = GitFactsClient(cwd=self.repo)

    def push_base(self, branch: str) -> None:
        run(self.repo, "push", "-q", "origin", branch)


class MasterBasedPr(ComputePatchIdTestCase):
    def test_matches_direct_master_diff(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        head = write_and_commit(self.repo, "change.txt", "content\n", "add change.txt")
        pr = candidate(base_ref_name="master", head_ref_oid=head)

        got = _compute_patch_id(self.client, pr)
        want = self.client.patch_id(self.client.merge_base("origin/master", head), head)
        self.assertEqual(got, want)
        self.assertIsNotNone(got)


class StackedBasePr(ComputePatchIdTestCase):
    """Reproduces the real #4343-vs-#4277 shape: one PR is based directly on
    master, the other is based on an unmerged intermediate branch that has
    its own, unrelated commits. Diffing both against master directly (the
    pre-fix behavior) makes their patch-ids diverge even though they carry
    the identical local change; diffing each against its own base (the fix)
    makes them match."""

    def test_same_local_change_on_different_bases_produces_matching_patch_ids(self):
        run(self.repo, "checkout", "-q", "-b", "integration")
        write_and_commit(self.repo, "integration-only.txt", "unrelated\n", "integration: unrelated prior work")
        self.push_base("integration")

        run(self.repo, "checkout", "-q", "-b", "pr-stacked")
        stacked_head = write_and_commit(self.repo, "shared.txt", "same-content\n", "pr-stacked: the actual change")
        stacked_pr = candidate(number=4343, base_ref_name="integration", head_ref_oid=stacked_head)

        run(self.repo, "checkout", "-q", "master")
        run(self.repo, "checkout", "-q", "-b", "pr-master")
        master_head = write_and_commit(self.repo, "shared.txt", "same-content\n", "pr-master: the identical change")
        master_pr = candidate(number=4277, base_ref_name="master", head_ref_oid=master_head)

        stacked_patch_id = _compute_patch_id(self.client, stacked_pr)
        master_patch_id = _compute_patch_id(self.client, master_pr)

        self.assertIsNotNone(stacked_patch_id)
        self.assertEqual(stacked_patch_id, master_patch_id)

    def test_diffing_the_stacked_pr_against_master_directly_would_have_diverged(self):
        # Documents *why* the fix is needed: the old, wrong computation
        # (always against master) does NOT match, even for the identical
        # scenario the fix above proves now works correctly.
        run(self.repo, "checkout", "-q", "-b", "integration")
        write_and_commit(self.repo, "integration-only.txt", "unrelated\n", "integration: unrelated prior work")

        run(self.repo, "checkout", "-q", "-b", "pr-stacked")
        stacked_head = write_and_commit(self.repo, "shared.txt", "same-content\n", "pr-stacked: the actual change")

        run(self.repo, "checkout", "-q", "master")
        run(self.repo, "checkout", "-q", "-b", "pr-master")
        master_head = write_and_commit(self.repo, "shared.txt", "same-content\n", "pr-master: the identical change")

        old_stacked_patch_id = self.client.patch_id(self.client.merge_base("master", stacked_head), stacked_head)
        old_master_patch_id = self.client.patch_id(self.client.merge_base("master", master_head), master_head)

        self.assertNotEqual(old_stacked_patch_id, old_master_patch_id)


class UnfetchableBase(ComputePatchIdTestCase):
    def test_degrades_to_none_instead_of_raising(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        head = write_and_commit(self.repo, "change.txt", "content\n", "add change.txt")
        pr = candidate(base_ref_name="this-branch-does-not-exist", head_ref_oid=head)

        self.assertIsNone(_compute_patch_id(self.client, pr))


if __name__ == "__main__":
    unittest.main()
