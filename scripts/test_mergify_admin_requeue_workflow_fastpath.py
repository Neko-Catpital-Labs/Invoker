"""Tests for the `submit_close_pr` Invoker hand-off added to
``mergify_admin_requeue_workflow_fastpath`` for the PR duplicate-close worker.

Run:  python3 scripts/test_mergify_admin_requeue_workflow_fastpath.py
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_workflow_fastpath as f


class ClosePrCommandScript(unittest.TestCase):
    def test_landed_close_has_no_kept_pr_check(self):
        script = f._close_pr_command_script(1, "owner/repo", "landed on master", "h1", None)
        self.assertNotIn("kept_state", script)
        self.assertIn("gh pr view \"$num\" --repo \"$repo\" --json state,headRefOid", script)
        self.assertIn("gh pr comment \"$num\" --repo \"$repo\"", script)
        self.assertIn("gh pr close \"$num\" --repo \"$repo\"", script)
        self.assertNotIn("--delete-branch", script)

    def test_duplicate_close_checks_kept_pr_is_still_open(self):
        script = f._close_pr_command_script(5, "owner/repo", "duplicate of #9", "h5", 9)
        self.assertIn("kept=9", script)
        self.assertIn("kept_state", script)
        self.assertIn('if [ "$kept_state" != "OPEN" ]; then', script)

    def test_stale_head_check_precedes_any_mutation(self):
        script = f._close_pr_command_script(1, "owner/repo", "r", "h1", None)
        self.assertLess(script.index("exit 20"), script.index("gh pr comment"))
        self.assertLess(script.index("exit 20"), script.index("gh pr close"))

    def test_reason_is_shell_quoted(self):
        script = f._close_pr_command_script(1, "owner/repo", "it's a \"test\"", "h1", None)
        self.assertIn("reason=", script)
        # shlex.quote of a string containing a single quote wraps in '"'"' form;
        # the important invariant is the raw quote character is never left
        # unescaped where it could break out of the surrounding shell string.
        reason_line = next(line for line in script.splitlines() if line.startswith("reason="))
        subprocess.run(["bash", "-c", f'{reason_line}\necho "$reason"'], check=True, capture_output=True, text=True)


class ClosePrPlanYaml(unittest.TestCase):
    def test_plan_has_no_llm_prompt_task_only_a_command(self):
        plan = f._close_pr_plan_yaml(1, "owner/repo", "reason", "h1", None)
        self.assertIn("onFinish: none\n", plan)
        self.assertIn("- id: close\n", plan)
        self.assertIn("command: |\n", plan)
        self.assertNotIn("prompt:", plan)

    def test_kept_pr_number_changes_the_fingerprint_suffix(self):
        landed = f._close_pr_plan_yaml(1, "owner/repo", "r", "h1", None)
        duplicate = f._close_pr_plan_yaml(1, "owner/repo", "r", "h1", 9)
        self.assertIn("name: close-pr-1-landed\n", landed)
        self.assertIn("name: close-pr-1-dup-9\n", duplicate)

    def test_double_quotes_in_reason_are_sanitized_for_the_yaml_scalar(self):
        plan = f._close_pr_plan_yaml(1, "owner/repo", 'reason with "quotes"', "h1", None)
        self.assertIn("description: \"Close PR #1: reason with 'quotes'\"\n", plan)


class SubmitClosePr(unittest.TestCase):
    def test_raises_on_nonzero_exit_and_cleans_up_the_plan_file(self):
        written_paths: list[str] = []

        def fake_run(args, **kwargs):
            written_paths.append(args[-1])
            self.assertTrue(Path(args[-1]).exists())
            return subprocess.CompletedProcess(args, returncode=1, stdout="", stderr="boom")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            with self.assertRaises(RuntimeError) as ctx:
                f.submit_close_pr(1, "owner/repo", "reason", "h1")

        self.assertIn("boom", str(ctx.exception))
        self.assertFalse(Path(written_paths[0]).exists())

    def test_cleans_up_the_plan_file_on_success_too(self):
        written_paths: list[str] = []

        def fake_run(args, **kwargs):
            written_paths.append(args[-1])
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            f.submit_close_pr(1, "owner/repo", "reason", "h1")

        self.assertFalse(Path(written_paths[0]).exists())

    def test_forwards_run_command_to_headless_mutation(self):
        captured = {}

        def fake_run(args, **kwargs):
            captured["args"] = args
            return subprocess.CompletedProcess(args, returncode=0, stdout="", stderr="")

        with mock.patch.object(subprocess, "run", side_effect=fake_run):
            f.submit_close_pr(1, "owner/repo", "reason", "h1")

        script = captured["args"][2]
        self.assertIn('headless_mutation run "$2"', script)


if __name__ == "__main__":
    unittest.main()
