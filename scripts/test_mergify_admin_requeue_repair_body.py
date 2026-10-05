from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
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


class _FakeGh:
    def __init__(self) -> None:
        self.created: list[tuple[str, str, str, str, str]] = []
        self.labels: list[tuple[str, int, str]] = []

    def create_pr(self, repo: str, title: str, body: str, branch: str, base: str) -> dict[str, int]:
        self.created.append((repo, title, body, branch, base))
        return {"number": 123}

    def edit_label(self, repo: str, number: int, *, add: str) -> None:
        self.labels.append((repo, number, add))


class _FakeLedger:
    def __init__(self) -> None:
        self.records: list[tuple[object, ...]] = []

    def record(self, *args: object, **kwargs: object) -> None:
        self.records.append((*args, kwargs))


class _FakeLogger:
    def __init__(self) -> None:
        self.traces: list[tuple[str, dict[str, object]]] = []

    def trace(self, event: str, **kwargs: object) -> None:
        self.traces.append((event, kwargs))


class CreateRepairPrerequisiteCherryPickTests(unittest.TestCase):
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
        self._write("shared.txt", "base\n")
        git(self.repo, "add", "shared.txt")
        git(self.repo, "commit", "-m", "base")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")
        self.start_head = git(self.repo, "rev-parse", "HEAD")
        self.gh = _FakeGh()
        self.ledger = _FakeLedger()
        self.logger = _FakeLogger()

    def _write(self, name: str, content: str) -> None:
        (self.repo / name).write_text(content, encoding="utf-8")

    def _commit_file(self, message: str, name: str, content: str) -> str:
        self._write(name, content)
        git(self.repo, "add", name)
        git(self.repo, "commit", "-m", message)
        return git(self.repo, "rev-parse", "HEAD")

    def _create_prerequisite(self, repair_commits: list[str]) -> dict[str, object]:
        with mock.patch.object(
            repair_body,
            "validate_current_pr_body",
            return_value={"valid": True, "errors": []},
        ):
            return repair_body.create_repair_prerequisite(
                self.gh,
                self.ledger,
                self.logger,
                "Neko-Catpital-Labs/Invoker",
                self.repo,
                42,
                "f" * 40,
                "required-check",
                self.start_head,
                repair_commits,
                123456,
            )

    def _git_path(self, name: str) -> Path:
        value = git(self.repo, "rev-parse", "--git-path", name)
        path = Path(value)
        return path if path.is_absolute() else self.repo / path

    def test_empty_pick_among_real_commits_is_skipped_and_branch_is_created(self) -> None:
        git(self.repo, "checkout", "-B", "repair-source", "master")
        empty_pick = self._commit_file("duplicate repair content", "already-on-master.txt", "already\n")
        real_one = self._commit_file("real repair one", "real-one.txt", "one\n")
        real_two = self._commit_file("real repair two", "real-two.txt", "two\n")

        git(self.repo, "checkout", "master")
        self._commit_file("master already has duplicate repair", "already-on-master.txt", "already\n")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

        result = self._create_prerequisite([empty_pick, real_one, real_two])

        branch = str(result["branch"])
        self.assertIsNotNone(safe_push.remote_branch_sha(branch, remote="origin", cwd=self.repo))
        self.assertEqual((self.repo / "real-one.txt").read_text(encoding="utf-8"), "one\n")
        self.assertEqual((self.repo / "real-two.txt").read_text(encoding="utf-8"), "two\n")
        self.assertEqual(git(self.repo, "rev-list", "--count", f"origin/master..{branch}"), "2")
        self.assertEqual(
            git(self.repo, "log", "--format=%s", "--reverse", f"origin/master..{branch}").splitlines(),
            ["real repair one", "real repair two"],
        )
        self.assertFalse(self._git_path("CHERRY_PICK_HEAD").exists())
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_every_empty_pick_raises_named_error_without_pushing_empty_branch(self) -> None:
        git(self.repo, "checkout", "-B", "repair-source", "master")
        empty_one = self._commit_file("duplicate repair one", "already-one.txt", "one\n")
        empty_two = self._commit_file("duplicate repair two", "already-two.txt", "two\n")

        git(self.repo, "checkout", "master")
        self._commit_file("master already has repair one", "already-one.txt", "one\n")
        self._commit_file("master already has repair two", "already-two.txt", "two\n")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

        branch = repair_body.prerequisite_branch_name(42, self.start_head)
        expected_error = getattr(repair_body, "EmptyRepairPrerequisiteError", RuntimeError)
        with self.assertRaises(expected_error):
            self._create_prerequisite([empty_one, empty_two])

        self.assertIsNot(expected_error, RuntimeError)
        self.assertIsNone(safe_push.remote_branch_sha(branch, remote="origin", cwd=self.repo))
        self.assertFalse(self._git_path("CHERRY_PICK_HEAD").exists())
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")

    def test_conflict_aborts_and_propagates_original_cherry_pick_exception(self) -> None:
        git(self.repo, "checkout", "-B", "repair-source", "master")
        conflict_commit = self._commit_file("conflicting repair", "shared.txt", "repair\n")

        git(self.repo, "checkout", "master")
        self._commit_file("conflicting trunk change", "shared.txt", "trunk\n")
        git(self.repo, "push", "origin", "HEAD:refs/heads/master")

        with self.assertRaises(subprocess.CalledProcessError) as caught:
            self._create_prerequisite([conflict_commit])

        self.assertEqual(caught.exception.cmd[:2], ["git", "cherry-pick"])
        combined = "\n".join(part for part in (caught.exception.stdout, caught.exception.stderr) if part)
        self.assertIn("CONFLICT", combined)
        self.assertFalse(self._git_path("CHERRY_PICK_HEAD").exists())
        self.assertEqual(git(self.repo, "status", "--porcelain"), "")


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

    def test_scope_split_uses_review_units_not_error_text(self) -> None:
        self.assertEqual(
            repair_body.scope_split_review_units(
                {"valid": False, "reviewUnits": ["proof", "tooling-policy", "proof"]}
            ),
            ("proof", "tooling-policy"),
        )
        self.assertEqual(
            repair_body.scope_split_review_units({"valid": False, "reviewUnits": ["proof"]}),
            (),
        )
        self.assertEqual(
            repair_body.scope_split_review_units(
                {"valid": True, "reviewUnits": ["proof", "tooling-policy"]}
            ),
            (),
        )
        self.assertEqual(
            repair_body.scope_split_review_units(
                {
                    "valid": False,
                    "errors": ["Split this into one Review Unit per PR."],
                }
            ),
            (),
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
