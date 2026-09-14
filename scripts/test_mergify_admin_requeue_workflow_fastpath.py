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


class FastpathSettleObserver(unittest.TestCase):
    def _ledger(self, tmpdir):
        from mergify_admin_requeue_model import Ledger
        return Ledger(Path(tmpdir) / "state.jsonl")

    def test_settles_submitted_row_when_workflow_terminal(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            ledger.record("conflict-repair", 7484, "head1", "conflict:7484", 100,
                          meta={"workflowId": "wf-1", "via": "fastpath"})
            with mock.patch.object(f, "workflow_status", return_value="failed"):
                settled = f.settle_workflow_fastpath_rows(ledger, 200)
            self.assertEqual(settled, 1)
            row = ledger.latest("conflict-repair-settled", 7484, "head1", "conflict:7484")
            self.assertIsNotNone(row)
            self.assertEqual(row["meta"]["workflowStatus"], "failed")
            self.assertEqual(row["meta"]["workflowId"], "wf-1")

    def test_leaves_running_workflow_unsettled(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            ledger.record("conflict-repair", 7484, "head1", "conflict:7484", 100,
                          meta={"workflowId": "wf-1", "via": "fastpath"})
            with mock.patch.object(f, "workflow_status", return_value="running"):
                self.assertEqual(f.settle_workflow_fastpath_rows(ledger, 200), 0)
            self.assertIsNone(ledger.latest("conflict-repair-settled", 7484, "head1", "conflict:7484"))

    def test_skips_rows_without_workflow_handle(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            ledger.record("conflict-repair", 7484, "head1", "conflict:7484", 100)
            with mock.patch.object(f, "workflow_status") as status:
                self.assertEqual(f.settle_workflow_fastpath_rows(ledger, 200), 0)
                status.assert_not_called()

    def test_does_not_resettle_already_settled_row(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            ledger.record("repair-check", 7055, "head2", "pr-body", 100,
                          meta={"workflowId": "wf-2", "via": "fastpath"})
            ledger.record("repair-check-settled", 7055, "head2", "pr-body", 150,
                          meta={"workflowId": "wf-2"})
            with mock.patch.object(f, "workflow_status") as status:
                self.assertEqual(f.settle_workflow_fastpath_rows(ledger, 200), 0)
                status.assert_not_called()

    def test_unreadable_status_leaves_row_for_ttl_backstop(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            ledger.record("conflict-repair", 7484, "head1", "conflict:7484", 100,
                          meta={"workflowId": "wf-1", "via": "fastpath"})
            with mock.patch.object(f, "workflow_status", return_value=None):
                self.assertEqual(f.settle_workflow_fastpath_rows(ledger, 200), 0)

    def test_parse_last_json_object_skips_noise_lines(self):
        stdout = '[invoker] maxConcurrency=13 exceeds pool capacity\n{"id": "wf-1", "status": "failed"}\n'
        self.assertEqual(f._parse_last_json_object(stdout), {"id": "wf-1", "status": "failed"})


class RepairerPlanSettleObserver(unittest.TestCase):
    def _ledger(self, tmpdir):
        from mergify_admin_requeue_model import Ledger
        return Ledger(Path(tmpdir) / "state.jsonl")

    def test_promotes_crash_left_pending_request_when_invoker_has_the_workflow(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "4f4e937" + "0" * 33
            key = "rebase-onto-master:11149"
            plan_name = f.rebase_onto_master_plan_name(11149, head)
            ledger.record(
                "rebase-onto-master-pending",
                11149,
                head,
                key,
                100,
                meta={"dispatchState": "pending", "planName": plan_name},
            )
            workflows = [{"id": "wf-repair", "name": plan_name, "status": "running"}]
            with mock.patch.object(f, "list_workflows", return_value=workflows):
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 1)

            acknowledged = ledger.latest("rebase-onto-master", 11149, head, key)
            self.assertEqual(acknowledged["meta"]["dispatchState"], "acknowledged")
            self.assertEqual(acknowledged["meta"]["acknowledgedBy"], "pending-request-observer")
            self.assertEqual(acknowledged["meta"]["workflowId"], "wf-repair")

    def test_closes_unacknowledged_pending_request_without_creating_an_attempt(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "4f4e937" + "0" * 33
            key = "rebase-onto-master:11149"
            ledger.record(
                "rebase-onto-master-pending",
                11149,
                head,
                key,
                100,
                meta={
                    "dispatchState": "pending",
                    "planName": f.rebase_onto_master_plan_name(11149, head),
                },
            )
            with mock.patch.object(f, "list_workflows", return_value=[]):
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 1)

            self.assertIsNone(ledger.latest("rebase-onto-master", 11149, head, key))
            closed = ledger.latest("rebase-onto-master-pending-settled", 11149, head, key)
            self.assertEqual(closed["meta"]["dispatchState"], "not-acknowledged")

    def test_leaves_pending_request_open_when_invoker_cannot_be_queried(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "4f4e937" + "0" * 33
            key = "rebase-onto-master:11149"
            ledger.record("rebase-onto-master-pending", 11149, head, key, 100)
            with mock.patch.object(f, "list_workflows", return_value=None):
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 0)
            self.assertIsNone(ledger.latest("rebase-onto-master-pending-settled", 11149, head, key))

    def test_settles_a_failed_bot_thread_repair_by_matching_its_plan_name(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "7bbccbd" + "0" * 33
            ledger.record("repair-bot-thread", 9172, head, "PRRT_thread1", 100)
            plan_name = f.repair_bot_thread_plan_name(9172, head)
            workflows = [{"id": "wf-1", "name": plan_name, "status": "failed"}]
            with mock.patch.object(f, "list_workflows", return_value=workflows):
                settled = f.settle_repairer_plan_rows(ledger, 200)
            self.assertEqual(settled, 1)
            row = ledger.latest("repair-bot-thread-settled", 9172, head, "PRRT_thread1")
            self.assertIsNotNone(row)
            self.assertEqual(row["meta"]["workflowStatus"], "failed")
            self.assertEqual(row["meta"]["workflowId"], "wf-1")
            self.assertEqual(row["meta"]["settledBy"], "repairer-plan-observer")

    def test_owner_observer_settles_successful_repair_without_remote_ledger_write(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "b92253b" + "0" * 33
            ledger.record("repair-check", 9966, head, "PR Body", 100)
            plan_name = f.repair_check_plan_name(9966, "PR Body", head)
            workflows = [{"id": "wf-ok", "name": plan_name, "status": "completed"}]
            with mock.patch.object(f, "list_workflows", return_value=workflows):
                settled = f.settle_repairer_plan_rows(ledger, 200)
            self.assertEqual(settled, 1)
            row = ledger.latest("repair-check-settled", 9966, head, "PR Body")
            self.assertIsNotNone(row)
            self.assertEqual(row["meta"]["workflowStatus"], "completed")
            self.assertEqual(row["meta"]["settledBy"], "repairer-plan-observer")
            self.assertEqual(row["meta"]["outcomeClass"], "success")
            self.assertEqual(row["pr"], 9966)
            self.assertEqual(row["headSha"], head)
            self.assertEqual(row["key"], "PR Body")

    def test_settles_a_failed_check_repair_and_a_failed_conflict_repair_too(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "abc1234" + "0" * 33
            ledger.record("repair-check", 100, head, "UI Vitest", 100)
            ledger.record("conflict-repair", 200, head, "conflict:200", 100)
            workflows = [
                {"id": "wf-c1", "name": f.repair_check_plan_name(100, "UI Vitest", head), "status": "failed"},
                {"id": "wf-c2", "name": f.repair_conflict_plan_name(200, head), "status": "completed"},
            ]
            with mock.patch.object(f, "list_workflows", return_value=workflows):
                settled = f.settle_repairer_plan_rows(ledger, 200)
            self.assertEqual(settled, 2)
            self.assertIsNotNone(ledger.latest("repair-check-settled", 100, head, "UI Vitest"))
            self.assertIsNotNone(ledger.latest("conflict-repair-settled", 200, head, "conflict:200"))

    def test_leaves_a_still_running_repair_unsettled(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "7bbccbd" + "0" * 33
            ledger.record("repair-bot-thread", 9172, head, "PRRT_thread1", 100)
            plan_name = f.repair_bot_thread_plan_name(9172, head)
            workflows = [{"id": "wf-1", "name": plan_name, "status": "running"}]
            with mock.patch.object(f, "list_workflows", return_value=workflows):
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 0)
            self.assertIsNone(ledger.latest("repair-bot-thread-settled", 9172, head, "PRRT_thread1"))

    def test_does_not_resettle_an_already_settled_row(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "7bbccbd" + "0" * 33
            ledger.record("repair-bot-thread", 9172, head, "PRRT_thread1", 100)
            ledger.record("repair-bot-thread-settled", 9172, head, "PRRT_thread1", 150,
                          meta={"workflowId": "wf-1"})
            with mock.patch.object(f, "list_workflows") as listed:
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 0)
                listed.assert_not_called()

    def test_does_not_call_list_workflows_when_nothing_is_pending(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            with mock.patch.object(f, "list_workflows") as listed:
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 0)
                listed.assert_not_called()

    def test_unmatched_workflow_name_leaves_row_for_ttl_backstop(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = self._ledger(tmpdir)
            head = "7bbccbd" + "0" * 33
            ledger.record("repair-bot-thread", 9172, head, "PRRT_thread1", 100)
            with mock.patch.object(f, "list_workflows", return_value=[]):
                self.assertEqual(f.settle_repairer_plan_rows(ledger, 200), 0)
            self.assertIsNone(ledger.latest("repair-bot-thread-settled", 9172, head, "PRRT_thread1"))


class ClassifyRepairOutcome(unittest.TestCase):
    def test_completed_with_stale_head_is_superseded_not_success(self):
        tasks = [
            {
                "id": "wf/safe-push",
                "status": "completed",
                "execution": {
                    "pendingFixError": (
                        "pr-worker-safe-push: stale-head: refs/heads/stack/x "
                        "is b7a44e5d; expected 1cc00e13\n"
                        "[worktree] Process exited: exitCode=20"
                    ),
                },
            }
        ]
        with mock.patch.object(f, "list_workflow_tasks", return_value=tasks):
            self.assertEqual(f.classify_repair_outcome("wf-1", "completed"), "superseded")

    def test_completed_without_task_failures_is_success(self):
        with mock.patch.object(f, "list_workflow_tasks", return_value=[{"id": "wf/repair", "status": "completed", "execution": {}}]):
            self.assertEqual(f.classify_repair_outcome("wf-1", "completed"), "success")


if __name__ == "__main__":
    unittest.main()
