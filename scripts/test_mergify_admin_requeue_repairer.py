"""Regression tests for AdminBypassRepairer async dispatch ledger recording.

Run:  python3 scripts/test_mergify_admin_requeue_repairer.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import scripts.mergify_admin_requeue_async_repair as async_repair
import scripts.mergify_admin_requeue_model as m
import scripts.mergify_admin_requeue_repairer as repairer


HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"
NOW = 2_000_000_000


def pr(**kw):
    base = dict(
        number=2647,
        title="Fix failing check",
        body="",
        url="https://github.com/owner/repo/pull/2647",
        state="OPEN",
        is_draft=False,
        base_ref_name="master",
        head_ref_name="stack/2647",
        head_ref_oid=HEAD,
        merge_state_status="BLOCKED",
        mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={
            "build": m.CheckContext(
                name="build",
                state="failure",
                details_url="https://github.com/owner/repo/actions/runs/1/job/2",
                head_sha=HEAD,
                completed_at="",
            ),
        },
        review_threads=(),
        latest_mergify=None,
    )
    base.update(kw)
    return m.PrSnapshot(**base)


class RepairerLedgerOrderTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ledger = m.Ledger(Path(tmp.name) / "ledger.jsonl")
        self.executor = mock.Mock()
        self.executor.download_job_log.return_value = "/does/not/exist/build.log"
        self.logger = mock.Mock()
        self.repairer = repairer.AdminBypassRepairer(
            gh=object(),
            executor=self.executor,
            logger=self.logger,
            ledger=self.ledger,
            repo="owner/repo",
        )

    def plan(self, name="admin-bypass-repair"):
        return async_repair.AsyncRepairPlan(plan_name=name, yaml_text="name: x\n")

    def assert_row(self, kind, key):
        row = self.ledger.latest(kind, 2647, HEAD, key)
        self.assertIsNotNone(row)
        self.assertEqual(row["epoch"], NOW)

    def test_repair_check_records_before_dispatch_failure(self):
        with mock.patch(
            "scripts.mergify_admin_requeue_repairer.async_repair.build_repair_check_plan",
            return_value=self.plan("repair-check"),
        ):
            with mock.patch(
                "scripts.mergify_admin_requeue_repairer.async_repair.submit_async_repair_plan",
                side_effect=RuntimeError("timed out after 30s"),
            ):
                with self.assertRaises(RuntimeError):
                    self.repairer.repair_check(pr(), "build", now=NOW)

        self.assert_row("repair-check", "build")

    def test_repair_conflict_records_before_dispatch_failure(self):
        with mock.patch(
            "scripts.mergify_admin_requeue_repairer.async_repair.build_repair_conflict_plan",
            return_value=self.plan("repair-conflict"),
        ):
            with mock.patch(
                "scripts.mergify_admin_requeue_repairer.async_repair.submit_async_repair_plan",
                side_effect=RuntimeError("timed out after 30s"),
            ):
                with self.assertRaises(RuntimeError):
                    self.repairer.repair_conflict(pr(), "GitHub reports merge conflict", now=NOW)

        self.assert_row("conflict-repair", "conflict:2647")

    def test_repair_bot_thread_records_before_dispatch_failure(self):
        with mock.patch(
            "scripts.mergify_admin_requeue_repairer.async_repair.build_repair_bot_thread_plan",
            return_value=self.plan("repair-bot-thread"),
        ):
            with mock.patch(
                "scripts.mergify_admin_requeue_repairer.async_repair.submit_async_repair_plan",
                side_effect=RuntimeError("timed out after 30s"),
            ):
                with self.assertRaises(RuntimeError):
                    self.repairer.repair_bot_thread(pr(), "thread-1", now=NOW)

        self.assert_row("repair-bot-thread", "thread-1")

    def test_repair_check_success_still_records_and_returns_submitted(self):
        with mock.patch(
            "scripts.mergify_admin_requeue_repairer.async_repair.build_repair_check_plan",
            return_value=self.plan("repair-check"),
        ):
            with mock.patch("scripts.mergify_admin_requeue_repairer.async_repair.submit_async_repair_plan") as submit:
                outcome = self.repairer.repair_check(pr(), "build", now=NOW)

        submit.assert_called_once()
        self.assertEqual(outcome.status, "submitted")
        self.assert_row("repair-check", "build")


if __name__ == "__main__":
    unittest.main()
