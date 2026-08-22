from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from scripts import pr_worker_safe_push as safe_push


REAL_GIT = shutil.which("git") or "git"


def git(cwd: Path, *args: str, env: dict[str, str] | None = None) -> str:
    completed = subprocess.run(
        [REAL_GIT, *args],
        cwd=str(cwd),
        check=True,
        text=True,
        capture_output=True,
        env=env,
    )
    return completed.stdout.strip()


class SafePushTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "repo"
        self.other = self.root / "other"
        git(self.root, "init", "--bare", str(self.remote))
        git(self.root, "clone", str(self.remote), str(self.repo))
        for clone in (self.repo,):
            git(clone, "config", "user.email", "worker@example.invalid")
            git(clone, "config", "user.name", "Worker Test")
        git(self.repo, "checkout", "-B", "main")
        (self.repo / "file.txt").write_text("base\n", encoding="utf-8")
        git(self.repo, "add", "file.txt")
        git(self.repo, "commit", "-m", "base")
        git(self.repo, "push", "origin", "HEAD:refs/heads/main")
        self.expected = git(self.repo, "rev-parse", "HEAD")

    def commit(self, repo: Path, message: str, content: str = "change\n") -> str:
        target = repo / "file.txt"
        target.write_text(target.read_text(encoding="utf-8") + content, encoding="utf-8")
        git(repo, "add", "file.txt")
        git(repo, "commit", "-m", message)
        return git(repo, "rev-parse", "HEAD")

    def clone_other(self) -> None:
        git(self.root, "clone", str(self.remote), str(self.other))
        git(self.other, "checkout", "main")
        git(self.other, "config", "user.email", "other@example.invalid")
        git(self.other, "config", "user.name", "Other Test")

    def remote_head(self, branch: str = "main") -> str:
        return safe_push.remote_branch_sha(branch, remote="origin", cwd=self.repo) or ""

    def invoke_helper(self, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        command = ["python3", str(Path(__file__).with_name("pr_worker_safe_push.py")), *args]
        merged_env = {**os.environ, **(env or {})}
        return subprocess.run(
            command,
            cwd=str(self.repo),
            check=False,
            text=True,
            capture_output=True,
            env=merged_env,
        )

    def test_matching_expected_sha_pushes_and_records_attempt_marker(self) -> None:
        pushed = self.commit(self.repo, "repair")
        ledger = self.root / "ledger.tsv"
        result = self.invoke_helper(
            "--branch", "main",
            "--expected-head", self.expected,
            "--record-tsv-ledger", str(ledger),
            "--tsv-kind", "queue-attempt",
            "--tsv-key", "123",
            "--tsv-marker", "fp1",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_head(), pushed)
        self.assertEqual(ledger.read_text(encoding="utf-8").split("\t")[:3], ["queue-attempt", "123", "fp1"])

    def test_moved_remote_head_exits_nonzero_leaves_remote_unchanged_and_records_no_attempt(self) -> None:
        self.clone_other()
        remote_after_race = self.commit(self.other, "race", "race\n")
        git(self.other, "push", "origin", "HEAD:refs/heads/main")
        self.commit(self.repo, "repair")
        ledger = self.root / "ledger.tsv"

        result = self.invoke_helper(
            "--branch", "main",
            "--expected-head", self.expected,
            "--record-tsv-ledger", str(ledger),
            "--tsv-kind", "queue-attempt",
            "--tsv-key", "123",
            "--tsv-marker", "fp1",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("stale-head", result.stderr)
        self.assertEqual(safe_push.remote_branch_sha("main", remote="origin", cwd=self.other), remote_after_race)
        self.assertFalse(ledger.exists())

    def test_push_lease_failure_records_no_attempt(self) -> None:
        self.clone_other()
        pushed = self.commit(self.repo, "repair")
        del pushed
        ledger = self.root / "ledger.tsv"
        marker = self.root / "race-done"
        wrapper_dir = self.root / "bin"
        wrapper_dir.mkdir()
        wrapper = wrapper_dir / "git"
        wrapper.write_text(
            textwrap.dedent(
                f"""\
                #!/usr/bin/env bash
                set -euo pipefail
                if [ "${{1:-}}" = "push" ] && [ ! -e {str(marker)!r} ]; then
                  touch {str(marker)!r}
                  printf 'lease-race\\n' >> {str(self.other / "file.txt")!r}
                  {REAL_GIT!r} -C {str(self.other)!r} add file.txt
                  {REAL_GIT!r} -C {str(self.other)!r} commit -m lease-race >/dev/null
                  {REAL_GIT!r} -C {str(self.other)!r} push origin HEAD:refs/heads/main >/dev/null
                fi
                exec {REAL_GIT!r} "$@"
                """
            ),
            encoding="utf-8",
        )
        wrapper.chmod(0o755)

        result = self.invoke_helper(
            "--branch", "main",
            "--expected-head", self.expected,
            "--record-tsv-ledger", str(ledger),
            "--tsv-kind", "queue-attempt",
            "--tsv-key", "123",
            "--tsv-marker", "fp1",
            env={"PATH": f"{wrapper_dir}:{os.environ['PATH']}"},
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("git push", result.stderr)
        self.assertFalse(ledger.exists())

    def test_missing_branch_with_merged_pr_skips_push_without_error(self) -> None:
        self.commit(self.repo, "repair")
        # Simulate the branch being deleted by GitHub on merge: remove it from the remote.
        git(self.repo, "push", "origin", "--delete", "main")

        with mock.patch.object(safe_push, "pr_is_merged", return_value=True) as mocked:
            pushed = safe_push.safe_push(
                branch="main",
                expected_head=self.expected,
                remote="origin",
                cwd=self.repo,
                pr_number=123,
            )

        mocked.assert_called_once_with(123, cwd=self.repo)
        self.assertIsNone(pushed)
        self.assertIsNone(safe_push.remote_branch_sha("main", remote="origin", cwd=self.repo))

    def test_missing_branch_with_open_pr_still_raises_stale_head(self) -> None:
        self.commit(self.repo, "repair")
        git(self.repo, "push", "origin", "--delete", "main")

        with mock.patch.object(safe_push, "pr_is_merged", return_value=False):
            with self.assertRaises(safe_push.SafePushError) as ctx:
                safe_push.safe_push(
                    branch="main",
                    expected_head=self.expected,
                    remote="origin",
                    cwd=self.repo,
                    pr_number=123,
                )

        self.assertIn("stale-head", str(ctx.exception))
        self.assertEqual(ctx.exception.exit_code, 20)

    def test_missing_branch_without_pr_number_still_raises_stale_head(self) -> None:
        self.commit(self.repo, "repair")
        git(self.repo, "push", "origin", "--delete", "main")

        with self.assertRaises(safe_push.SafePushError) as ctx:
            safe_push.safe_push(
                branch="main",
                expected_head=self.expected,
                remote="origin",
                cwd=self.repo,
            )

        self.assertIn("stale-head", str(ctx.exception))

    def test_new_prerequisite_branch_succeeds_only_when_remote_branch_is_absent(self) -> None:
        git(self.repo, "checkout", "-B", "stack/prereq")
        first = self.commit(self.repo, "prereq", "prereq\n")
        result = self.invoke_helper("--branch", "stack/prereq", "--expect-missing")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_head("stack/prereq"), first)

        second = self.commit(self.repo, "prereq-again", "again\n")
        del second
        result = self.invoke_helper("--branch", "stack/prereq", "--expect-missing")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected it to be missing", result.stderr)
        self.assertEqual(self.remote_head("stack/prereq"), first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
