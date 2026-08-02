"""Behavioural tests for mergify_admin_requeue_async_repair's plan builders.

Run:  python3 scripts/test_mergify_admin_requeue_async_repair.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.mergify_admin_requeue_async_repair as async_repair
import scripts.mergify_admin_requeue_model as m

HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"


def pr(**kw):
    base = dict(
        number=2647,
        title='Fix "quoted" title: with colons',
        body="",
        url="https://github.com/owner/repo/pull/2647",
        state="OPEN",
        is_draft=False,
        base_ref_name="master",
        head_ref_name="stack/2647",
        head_ref_oid=HEAD,
        merge_state_status="CLEAN",
        mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={},
        review_threads=(),
        latest_mergify=None,
    )
    base.update(kw)
    return m.PrSnapshot(**base)


class AsyncRepairPlanTests(unittest.TestCase):
    def test_all_three_plan_kinds_produce_parseable_yaml_with_expected_task_ids(self):
        checks_plan = async_repair.build_repair_check_plan(
            pr(), "PR Body", repo="owner/repo", details_url="https://example.invalid/job",
            log_path="/tmp/pr-body.log", queue_only=False, queue_pr_number=0, latest=None,
            start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
        )
        conflict_plan = async_repair.build_repair_conflict_plan(
            pr(), "GitHub reports merge conflict", repo="owner/repo", start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
        )
        bot_thread_plan = async_repair.build_repair_bot_thread_plan(
            pr(), "tbot", repo="owner/repo", start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
        )
        for plan, expected_task_ids in (
            (checks_plan, ["repair", "normalize", "safe-push"]),
            (conflict_plan, ["repair", "safe-push"]),
            (bot_thread_plan, ["repair", "safe-push"]),
        ):
            with self.subTest(plan=plan.plan_name):
                doc = yaml.safe_load(plan.yaml_text)
                self.assertEqual(doc["onFinish"], "none")
                self.assertEqual(doc["repoUrl"], "https://github.com/owner/repo.git")
                self.assertEqual([task["id"] for task in doc["tasks"]], expected_task_ids)
                for task, expected_id in zip(doc["tasks"][1:], expected_task_ids[1:]):
                    self.assertEqual(task["dependencies"], [expected_task_ids[expected_task_ids.index(expected_id) - 1]])

    def test_repair_check_plan_includes_three_tasks_in_dependency_order(self):
        plan = async_repair.build_repair_check_plan(
            pr(),
            "PR Body",
            repo="owner/repo",
            details_url="https://example.invalid/job",
            log_path="/tmp/pr-body.log",
            queue_only=False,
            queue_pr_number=0,
            latest=None,
            start_head=HEAD,
            state_file=Path("/tmp/ledger.jsonl"),
        )
        self.assertIn("id: repair", plan.yaml_text)
        self.assertIn("id: normalize", plan.yaml_text)
        self.assertIn("id: safe-push", plan.yaml_text)
        self.assertIn("dependencies: [repair]", plan.yaml_text)
        self.assertIn("dependencies: [normalize]", plan.yaml_text)
        self.assertIn("mergify_admin_requeue_repair_normalize.py", plan.yaml_text)
        self.assertIn("--json-kind 'repair-check-settled'", plan.yaml_text)
        self.assertIn("Failed check: PR Body", plan.yaml_text)
        # PR titles with quotes/colons must not corrupt the YAML document.
        self.assertIn('Fix \\"quoted\\" title: with colons', plan.yaml_text)

    def test_repair_check_plan_inlines_job_log_content_not_local_path(self):
        # log_path is a tempfile on the orchestrator's own machine; the plan
        # is dispatched to a separate headless worker that does not share
        # that filesystem, so the prompt must carry the log content itself.
        with tempfile.TemporaryDirectory() as tmp_dir:
            log_path = str(Path(tmp_dir) / "pr-body.log")
            Path(log_path).write_text("some failure detail\n", encoding="utf-8")
            plan = async_repair.build_repair_check_plan(
                pr(), "PR Body", repo="owner/repo", details_url="https://example.invalid/job",
                log_path=log_path, queue_only=False, queue_pr_number=0, latest=None,
                start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
            )
        self.assertIn("Job log (tail):", plan.yaml_text)
        self.assertIn("some failure detail", plan.yaml_text)
        self.assertNotIn(log_path, plan.yaml_text)

    def test_repair_check_plan_job_log_missing_says_not_available(self):
        plan = async_repair.build_repair_check_plan(
            pr(), "PR Body", repo="owner/repo", details_url="https://example.invalid/job",
            log_path="/does/not/exist/pr-body.log", queue_only=False, queue_pr_number=0, latest=None,
            start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
        )
        self.assertIn("Job log (tail):", plan.yaml_text)
        self.assertIn("(not available)", plan.yaml_text)

    def test_repair_check_plan_queue_only_appends_queue_pr_line(self):
        plan = async_repair.build_repair_check_plan(
            pr(checks={}),
            "required-fast / Guardrails",
            repo="owner/repo",
            details_url="https://example.invalid/job",
            log_path="/tmp/guardrails.log",
            queue_only=True,
            queue_pr_number=5854,
            latest=None,
            start_head=HEAD,
            state_file=Path("/tmp/ledger.jsonl"),
        )
        self.assertIn("Queue draft PR: #5854", plan.yaml_text)

    def test_repair_conflict_plan_has_two_tasks_and_conflict_key(self):
        plan = async_repair.build_repair_conflict_plan(
            pr(), "GitHub reports merge conflict", repo="owner/repo", start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
        )
        self.assertIn("id: repair", plan.yaml_text)
        self.assertIn("id: safe-push", plan.yaml_text)
        self.assertNotIn("id: normalize", plan.yaml_text)
        self.assertIn("--json-kind 'conflict-repair-settled'", plan.yaml_text)
        self.assertIn("--json-key 'conflict:2647'", plan.yaml_text)
        self.assertIn("commit locally. Do not push.", plan.yaml_text)

    def test_repair_bot_thread_plan_uses_thread_id_as_key(self):
        plan = async_repair.build_repair_bot_thread_plan(
            pr(), "tbot", repo="owner/repo", start_head=HEAD, state_file=Path("/tmp/ledger.jsonl"),
        )
        self.assertIn("--json-kind 'repair-bot-thread-settled'", plan.yaml_text)
        self.assertIn("--json-key 'tbot'", plan.yaml_text)
        self.assertIn("Thread: tbot", plan.yaml_text)

    def test_submit_async_repair_plan_calls_headless_run_and_cleans_up_temp_file(self):
        plan = async_repair.AsyncRepairPlan(plan_name="admin-bypass-repair-check-pr-1-abc", yaml_text="name: x\n")
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="{}\n", stderr="")
        written_paths = []

        def fake_run_headless(command, *extra_args):
            written_paths.append(Path(extra_args[0]))
            self.assertTrue(written_paths[-1].exists())
            self.assertEqual(written_paths[-1].read_text(encoding="utf-8"), "name: x\n")
            return completed

        with mock.patch("scripts.mergify_admin_requeue_async_repair.run_headless", side_effect=fake_run_headless) as run:
            async_repair.submit_async_repair_plan(plan)
        run.assert_called_once()
        self.assertFalse(written_paths[0].exists())

    def test_submit_async_repair_plan_raises_on_failure(self):
        plan = async_repair.AsyncRepairPlan(plan_name="p", yaml_text="name: x\n")
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")
        with mock.patch("scripts.mergify_admin_requeue_async_repair.run_headless", return_value=completed):
            with self.assertRaises(RuntimeError):
                async_repair.submit_async_repair_plan(plan)


if __name__ == "__main__":
    unittest.main()
