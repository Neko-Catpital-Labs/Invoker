"""Behavioural tests for ``pr_duplicate_close_git_facts.GitFactsClient``.

Runs real `git` against a throwaway sandbox repo (mkdtemp + git init, per the
project's testing convention for git-touching code) rather than mocking git
output — these are exactly the plumbing commands (merge-base, diff, cherry,
patch-id) where a hand-rolled fake would risk drifting from real behavior.

Run:  python3 scripts/test_pr_duplicate_close_git_facts.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pr_duplicate_close_git_facts import GitFactsClient


def run(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, text=True, capture_output=True,
    ).stdout.strip()


def write_and_commit(repo: Path, filename: str, content: str, message: str) -> str:
    (repo / filename).write_text(content, encoding="utf-8")
    run(repo, "add", filename)
    run(repo, "commit", "-m", message)
    return run(repo, "rev-parse", "HEAD")


class GitFactsTestCase(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: shutil.rmtree(self.repo, ignore_errors=True))
        run(self.repo, "init", "-q", "-b", "master")
        run(self.repo, "config", "user.email", "test@example.com")
        run(self.repo, "config", "user.name", "Test")
        self.base_sha = write_and_commit(self.repo, "base.txt", "base\n", "base commit")
        self.client = GitFactsClient(cwd=self.repo)


class IsAncestor(GitFactsTestCase):
    def test_true_when_head_has_no_new_commits(self):
        run(self.repo, "branch", "feature")
        feature_sha = run(self.repo, "rev-parse", "feature")
        self.assertTrue(self.client.is_ancestor(feature_sha, "master"))

    def test_false_before_merge_true_after(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "feature.txt", "feature\n", "feature commit")
        run(self.repo, "checkout", "-q", "master")

        self.assertFalse(self.client.is_ancestor(feature_sha, "master"))

        run(self.repo, "merge", "-q", "--no-ff", "feature", "-m", "merge feature")
        self.assertTrue(self.client.is_ancestor(feature_sha, "master"))


class IsEmptyDiff(GitFactsTestCase):
    def test_true_for_squash_equivalent_content(self):
        # Simulates a squash-merge: feature's commit is never an ancestor of
        # master, but master independently ends up with a tree identical to
        # feature's tree (the squash commit reproduces the same net change).
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "squash.txt", "same content\n", "feature commit")
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(self.repo, "squash.txt", "same content\n", "squash-merged equivalent")

        self.assertFalse(self.client.is_ancestor(feature_sha, "master"))
        self.assertTrue(self.client.is_empty_diff(feature_sha, "master"))

    def test_false_when_content_differs(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "diverge.txt", "feature content\n", "feature commit")
        self.assertFalse(self.client.is_empty_diff(feature_sha, "master"))

    def test_true_when_head_has_no_new_commits(self):
        run(self.repo, "branch", "feature")
        feature_sha = run(self.repo, "rev-parse", "feature")
        self.assertTrue(self.client.is_empty_diff(feature_sha, "master"))


class IsRebaseEquivalent(GitFactsTestCase):
    def test_true_for_add_add_conflict_with_trivially_different_content(self):
        # Matches the real PR #11149 vs #11159 shape: two open PRs
        # independently add the same domain file, one with a couple of
        # extra comment lines. Neither is_ancestor, is_empty_diff, nor
        # all_commits_equivalent catches this -- the head still textually
        # differs from master -- but rebasing it produces no real change.
        run(self.repo, "checkout", "-q", "-b", "pr-a")
        pr_a_sha = write_and_commit(
            self.repo, "domain.mjs", "export function f() {}\n\nconst X = 1;\n", "PR A adds domain.mjs",
        )
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(
            self.repo, "domain.mjs",
            "export function f() {}\n\n// mirrors an existing convention\nconst X = 1;\n",
            "master already has domain.mjs (landed via a sibling PR)",
        )

        self.assertFalse(self.client.is_ancestor(pr_a_sha, "master"))
        self.assertFalse(self.client.is_empty_diff(pr_a_sha, "master"))
        self.assertFalse(self.client.all_commits_equivalent(pr_a_sha, "master"))
        self.assertTrue(self.client.is_rebase_equivalent(pr_a_sha, "master"))

    def test_false_when_a_real_new_file_is_also_present(self):
        # The add/add conflict alone is trivial, but this PR also carries a
        # genuinely new, non-conflicting file -- rebasing it would NOT
        # produce an empty diff, so it must not be flagged as landed.
        run(self.repo, "checkout", "-q", "-b", "pr-a")
        (self.repo / "domain.mjs").write_text("export function f() {}\n\nconst X = 1;\n", encoding="utf-8")
        (self.repo / "unique.mjs").write_text("export const REAL_NEW_THING = 1;\n", encoding="utf-8")
        run(self.repo, "add", "domain.mjs", "unique.mjs")
        run(self.repo, "commit", "-q", "-m", "PR A adds domain.mjs and a real new file")
        pr_a_sha = run(self.repo, "rev-parse", "HEAD")
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(
            self.repo, "domain.mjs",
            "export function f() {}\n\n// mirrors an existing convention\nconst X = 1;\n",
            "master already has domain.mjs",
        )

        self.assertFalse(self.client.is_rebase_equivalent(pr_a_sha, "master"))

    def test_false_when_conflict_is_modify_modify_not_add_add(self):
        # A modify/modify conflict means head and upstream genuinely diverge
        # on content that already existed -- must never be auto-resolved in
        # upstream's favor, since that could silently discard a real fix.
        write_and_commit(self.repo, "shared.txt", "original\n", "shared base content")
        run(self.repo, "checkout", "-q", "-b", "pr-a")
        pr_a_sha = write_and_commit(self.repo, "shared.txt", "pr-a's real change\n", "PR A modifies shared.txt")
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(self.repo, "shared.txt", "master's different change\n", "master modifies shared.txt")

        self.assertFalse(self.client.is_rebase_equivalent(pr_a_sha, "master"))

    def test_false_for_a_genuinely_unrelated_pr(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "feature.txt", "feature\n", "feature commit")
        self.assertFalse(self.client.is_rebase_equivalent(feature_sha, "master"))


class HasConflict(GitFactsTestCase):
    def test_true_for_modify_modify_conflict(self):
        write_and_commit(self.repo, "shared.txt", "original\n", "shared base content")
        run(self.repo, "checkout", "-q", "-b", "pr-a")
        pr_a_sha = write_and_commit(self.repo, "shared.txt", "pr-a's real change\n", "PR A modifies shared.txt")
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(self.repo, "shared.txt", "master's different change\n", "master modifies shared.txt")

        self.assertTrue(self.client.has_conflict(pr_a_sha, "master"))

    def test_true_for_add_add_conflict(self):
        run(self.repo, "checkout", "-q", "-b", "pr-a")
        pr_a_sha = write_and_commit(self.repo, "domain.mjs", "same\n", "PR A adds domain.mjs")
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(self.repo, "domain.mjs", "different\n", "master already has domain.mjs")

        self.assertTrue(self.client.has_conflict(pr_a_sha, "master"))

    def test_false_for_a_clean_merge(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "feature.txt", "feature\n", "feature commit")
        self.assertFalse(self.client.has_conflict(feature_sha, "master"))


class AllCommitsEquivalent(GitFactsTestCase):
    def test_true_when_master_has_an_equivalent_commit(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "reword.txt", "identical patch\n", "feature: add file")
        run(self.repo, "checkout", "-q", "master")
        write_and_commit(self.repo, "reword.txt", "identical patch\n", "master: reworded add file")

        self.assertTrue(self.client.all_commits_equivalent(feature_sha, "master"))

    def test_false_when_a_commit_is_genuinely_new(self):
        run(self.repo, "checkout", "-q", "-b", "feature")
        feature_sha = write_and_commit(self.repo, "new.txt", "brand new\n", "feature: genuinely new change")

        self.assertFalse(self.client.all_commits_equivalent(feature_sha, "master"))


class PatchId(GitFactsTestCase):
    def test_identical_diffs_produce_the_same_patch_id(self):
        run(self.repo, "checkout", "-q", "-b", "branch-a")
        sha_a = write_and_commit(self.repo, "same.txt", "identical\n", "branch a change")
        run(self.repo, "checkout", "-q", "master")
        run(self.repo, "checkout", "-q", "-b", "branch-b")
        sha_b = write_and_commit(self.repo, "same.txt", "identical\n", "branch b change, same content")

        base_a = self.client.merge_base("master", sha_a)
        base_b = self.client.merge_base("master", sha_b)
        self.assertEqual(self.client.patch_id(base_a, sha_a), self.client.patch_id(base_b, sha_b))

    def test_different_diffs_produce_different_patch_ids(self):
        run(self.repo, "checkout", "-q", "-b", "branch-a")
        sha_a = write_and_commit(self.repo, "a.txt", "content a\n", "branch a change")
        run(self.repo, "checkout", "-q", "master")
        run(self.repo, "checkout", "-q", "-b", "branch-b")
        sha_b = write_and_commit(self.repo, "b.txt", "content b\n", "branch b change")

        base_a = self.client.merge_base("master", sha_a)
        base_b = self.client.merge_base("master", sha_b)
        self.assertNotEqual(self.client.patch_id(base_a, sha_a), self.client.patch_id(base_b, sha_b))

    def test_none_for_an_empty_diff(self):
        run(self.repo, "branch", "feature")
        feature_sha = run(self.repo, "rev-parse", "feature")
        self.assertIsNone(self.client.patch_id(self.base_sha, feature_sha))


if __name__ == "__main__":
    unittest.main()
