"""Behavioural tests for mergify_admin_requeue_repair_normalize's CLI.

This is the async replacement for the local post-run_claude_repair inspection
AdminBypassRepairer.repair_check used to do synchronously: dirty-check/reset,
normalize_repair_commit, PR-body re-validation, and (on a restructuring-needed
verdict) create_repair_prerequisite instead of a direct push.

Run:  python3 scripts/test_mergify_admin_requeue_repair_normalize.py
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.mergify_admin_requeue_repair_normalize as normalize

HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"
NEW_HEAD = "b" * 40

PROOF_TOOLING_POLICY_VALIDATION = {
    "valid": False,
    "errors": [
        "Review lane proof cannot ship with policy files in the same PR. "
        "Keep benchmarks, repros, and regression proof separate from behavior or policy changes.",
        'PR body Review Unit "proof" cannot ship with tooling-policy files in the same PR. '
        "Split this into one Review Unit per PR.",
    ],
    "reviewLane": "proof",
    "reviewUnit": "proof",
    "reviewUnits": ["tooling-policy"],
    "scopeKinds": ["policy"],
}

MANUAL_SPLIT_VALIDATION = {
    "valid": False,
    "errors": [
        "PR body mentions multiple review units (validation-policy, routing); split into one conceptual unit per diff/task.",
        'PR body Review Unit "routing" cannot ship with tooling-policy, proof files in the same PR. '
        "Split this into one Review Unit per PR.",
    ],
    "reviewLane": "behavior",
    "reviewUnit": "routing",
    "reviewUnits": ["routing", "tooling-policy", "proof"],
    "scopeKinds": ["product", "policy"],
}


class RepairNormalizeTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.cwd = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, self.cwd)
        self.state_file = Path(tmp.name) / "ledger.jsonl"

    def argv(self, **overrides):
        base = {
            "--repo": "owner/repo",
            "--pr": "2647",
            "--check": "PR Body",
            "--start-head": HEAD,
            "--base": "master",
            "--trunk": "master",
            "--state-file": str(self.state_file),
        }
        base.update(overrides)
        out = []
        for key, value in base.items():
            out += [key, value]
        return out

    def settled_rows(self):
        if not self.state_file.exists():
            return []
        return [line for line in self.state_file.read_text(encoding="utf-8").splitlines() if '"repair-check-settled"' in line]

    def test_import_disables_bytecode_writes(self):
        self.assertIs(normalize.sys.dont_write_bytecode, True)

    def test_records_settle_marker_first_regardless_of_outcome(self):
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=("M file.py",)):
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.hard_reset_work_root"):
                code = normalize.main(self.argv())
        self.assertEqual(code, 1)
        self.assertEqual(len(self.settled_rows()), 1)

    def test_dirty_working_tree_resets_and_fails(self):
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=("M file.py",)):
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.hard_reset_work_root") as reset:
                code = normalize.main(self.argv())
        self.assertEqual(code, 1)
        reset.assert_called_once_with(Path.cwd(), HEAD)

    def test_dirty_working_tree_error_names_dirty_paths(self):
        stderr = io.StringIO()
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=["?? stray.txt"]):
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.hard_reset_work_root"):
                with mock.patch("sys.stderr", stderr):
                    code = normalize.main(self.argv())
        self.assertEqual(code, 1)
        self.assertIn("blocked_dirty", stderr.getvalue())
        self.assertIn("?? stray.txt", stderr.getvalue())

    def test_no_commit_returns_zero_without_further_work(self):
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=()):
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_output", return_value=HEAD):
                with mock.patch("scripts.mergify_admin_requeue_repair_normalize.GhClient") as gh_cls:
                    code = normalize.main(self.argv())
        self.assertEqual(code, 0)
        gh_cls.assert_not_called()

    def test_valid_body_ready_for_push_returns_zero(self):
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=()):
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_output", return_value=NEW_HEAD):
                with mock.patch("scripts.mergify_admin_requeue_repair_normalize.normalize_repair_commit", return_value=NEW_HEAD):
                    with mock.patch("scripts.mergify_admin_requeue_repair_normalize.GhClient") as gh_cls:
                        gh_cls.return_value.pr_detail.return_value = {"body": "## Summary\n\nok\n"}
                        with mock.patch(
                            "scripts.mergify_admin_requeue_repair_normalize.validate_current_pr_body",
                            return_value={"valid": True, "errors": []},
                        ):
                            code = normalize.main(self.argv())
        self.assertEqual(code, 0)
        self.assertFalse(normalize.PREREQ_SENTINEL.exists())

    def test_prereq_split_creates_prerequisite_and_writes_sentinel(self):
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=("commit-a",)) as git_lines:
            git_lines.side_effect = lambda cwd, *args: ("commit-a",) if args[:1] == ("rev-list",) else ()
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_output", return_value=NEW_HEAD):
                with mock.patch("scripts.mergify_admin_requeue_repair_normalize.normalize_repair_commit", return_value=NEW_HEAD):
                    with mock.patch("scripts.mergify_admin_requeue_repair_normalize.GhClient") as gh_cls:
                        gh_cls.return_value.pr_detail.return_value = {"body": "## Summary\n\nmixed\n"}
                        with mock.patch(
                            "scripts.mergify_admin_requeue_repair_normalize.validate_current_pr_body",
                            return_value=PROOF_TOOLING_POLICY_VALIDATION,
                        ):
                            with mock.patch(
                                "scripts.mergify_admin_requeue_repair_normalize.create_repair_prerequisite",
                                return_value={"prNumber": 5801, "branch": "stack/pr-babysit-prereq-2647-c2532d2"},
                            ) as create_prereq:
                                with mock.patch("scripts.mergify_admin_requeue_repair_normalize.hard_reset_work_root"):
                                    code = normalize.main(self.argv())
        self.addCleanup(lambda: normalize.PREREQ_SENTINEL.unlink(missing_ok=True))
        self.assertEqual(code, 0)
        create_prereq.assert_called_once()
        call_kwargs = create_prereq.call_args
        self.assertEqual(call_kwargs.args[5], 2647)
        self.assertEqual(call_kwargs.args[6], HEAD)
        self.assertEqual(call_kwargs.args[7], "PR Body")
        self.assertTrue(normalize.PREREQ_SENTINEL.exists())

    def test_invalid_non_trunk_blocks_human_split(self):
        with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_lines", return_value=()):
            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.git_output", return_value=NEW_HEAD):
                with mock.patch("scripts.mergify_admin_requeue_repair_normalize.normalize_repair_commit", return_value=NEW_HEAD):
                    with mock.patch("scripts.mergify_admin_requeue_repair_normalize.GhClient") as gh_cls:
                        gh_cls.return_value.pr_detail.return_value = {"body": "## Summary\n\nmixed\n"}
                        with mock.patch(
                            "scripts.mergify_admin_requeue_repair_normalize.validate_current_pr_body",
                            return_value=MANUAL_SPLIT_VALIDATION,
                        ):
                            with mock.patch("scripts.mergify_admin_requeue_repair_normalize.hard_reset_work_root") as reset:
                                code = normalize.main(self.argv(**{"--base": "stack/base"}))
        self.assertEqual(code, 1)
        reset.assert_called_once_with(Path.cwd(), HEAD)


if __name__ == "__main__":
    unittest.main()
