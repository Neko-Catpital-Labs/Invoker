"""Behavioural tests for ``mergify_admin_requeue_infra_signal``.

Documentation-by-test: given a stubbed ``run_headless_fn`` standing in for the
real Invoker headless CLI bridge, prove the two lookups this module performs
-- find a workflow by its exact plan name, then check whether that workflow's
`repair` task output contains the known SSH/OAuth infra crash signature.

Run:  python3 scripts/test_mergify_admin_requeue_infra_signal.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_infra_signal as s


def completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=["fake"], returncode=returncode, stdout=stdout, stderr=stderr)


def workflows_json(*rows):
    return completed(stdout=json.dumps(list(rows)))


class FindLatestWorkflowId(unittest.TestCase):
    def test_none_when_command_fails(self):
        calls = []
        result = s.find_latest_workflow_id("plan-a", run_headless_fn=lambda *a: calls.append(a) or completed(returncode=1))
        self.assertIsNone(result)
        self.assertEqual(len(calls), 1)

    def test_none_when_output_is_not_json(self):
        result = s.find_latest_workflow_id("plan-a", run_headless_fn=lambda *a: completed(stdout="not json"))
        self.assertIsNone(result)

    def test_none_when_no_workflow_matches_the_name(self):
        result = s.find_latest_workflow_id(
            "plan-a",
            run_headless_fn=lambda *a: workflows_json({"id": "wf-1", "name": "plan-b", "createdAt": "2026-01-01T00:00:00Z"}),
        )
        self.assertIsNone(result)

    def test_returns_the_most_recently_created_match(self):
        result = s.find_latest_workflow_id(
            "plan-a",
            run_headless_fn=lambda *a: workflows_json(
                {"id": "wf-old", "name": "plan-a", "createdAt": "2026-01-01T00:00:00Z"},
                {"id": "wf-new", "name": "plan-a", "createdAt": "2026-01-02T00:00:00Z"},
                {"id": "wf-other", "name": "plan-b", "createdAt": "2026-01-03T00:00:00Z"},
            ),
        )
        self.assertEqual(result, "wf-new")


class RepairTaskCrashedOnInfra(unittest.TestCase):
    def _run_headless_fn(self, workflows_result, task_output_result):
        def run_headless_fn(command, *extra_args):
            if "query workflows" in command:
                return workflows_result
            self.assertIn("task-output", command)
            self.assertEqual(extra_args, ("wf-1/repair",))
            return task_output_result
        return run_headless_fn

    def test_false_when_workflow_not_found(self):
        result = s.repair_task_crashed_on_infra(
            "plan-a", run_headless_fn=lambda *a: completed(returncode=1),
        )
        self.assertFalse(result)

    def test_false_when_task_output_query_fails(self):
        run_headless_fn = self._run_headless_fn(
            workflows_json({"id": "wf-1", "name": "plan-a", "createdAt": "2026-01-01T00:00:00Z"}),
            completed(returncode=1),
        )
        result = s.repair_task_crashed_on_infra("plan-a", run_headless_fn=run_headless_fn)
        self.assertFalse(result)

    def test_false_when_output_does_not_contain_the_signature(self):
        run_headless_fn = self._run_headless_fn(
            workflows_json({"id": "wf-1", "name": "plan-a", "createdAt": "2026-01-01T00:00:00Z"}),
            completed(stdout="Done in 12s using pnpm\nsome ordinary failure\n"),
        )
        result = s.repair_task_crashed_on_infra("plan-a", run_headless_fn=run_headless_fn)
        self.assertFalse(result)

    def test_true_when_output_contains_the_exact_captured_signature(self):
        run_headless_fn = self._run_headless_fn(
            workflows_json({"id": "wf-1", "name": "plan-a", "createdAt": "2026-01-01T00:00:00Z"}),
            completed(stdout="[SshExecutor] Running task payload...\n" + s.SSH_OAUTH_INFRA_SIGNATURE + "\n"),
        )
        result = s.repair_task_crashed_on_infra("plan-a", run_headless_fn=run_headless_fn)
        self.assertTrue(result)


if __name__ == "__main__":
    unittest.main()
