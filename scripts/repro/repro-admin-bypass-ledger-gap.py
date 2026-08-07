#!/usr/bin/env python3
"""Hermetic repro for the admin-bypass repair ledger-before-dispatch guard.

This pins the PR #7560 incident shape: the owner accepts an async repair plan,
but the client-side 30s watchdog returns rc=124 / "timed out after 30s". The
attempt must still be visible to the planner's repair_in_flight and retry-cap
gates.

Run:  python3 scripts/repro/repro-admin-bypass-ledger-gap.py
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import scripts.mergify_admin_requeue_async_repair as async_repair
import scripts.mergify_admin_requeue_headless_shell as headless_shell
import scripts.mergify_admin_requeue_model as m
import scripts.mergify_admin_requeue_plan as plan_mod
from scripts.mergify_admin_requeue_logger import AdminBypassLogger
from scripts.mergify_admin_requeue_repairer import AdminBypassRepairer


PR = 7560
HEAD = "4a64a9c" + "0" * 33
CHECK = "PR Body"
REPO = "EdbertChan/Invoker"
NOW = 1_786_051_200
MAX_REPAIR_ATTEMPTS = 3


class FakeGh:
    """GhClient double: PR is OPEN so terminal_repair_outcome never exits early."""

    def pr_detail(self, repo, number):
        return {"state": "OPEN"}


class FakeExecutor:
    """AdminBypassGhExecutor double with a non-empty PR Body job log."""

    def __init__(self, work: Path):
        self.log = work / "job-log.txt"
        self.log.write_text(
            "validate_current_pr_body: PR body stack marker mismatch\nexit 1\n",
            encoding="utf-8",
        )

    def download_job_log(self, repo, details_url, pr_number, check_name):
        return str(self.log)


def make_snapshot() -> m.PrSnapshot:
    latest = m.MergifyQueueEvent(
        comment_id="c1",
        state="dequeued",
        queue_rule_name="default",
        queued_at="2026-08-06T08:00:00Z",
        head_sha=HEAD,
        waiting_for=(),
        failing_checks=(CHECK,),
        comment_url="https://github.com/EdbertChan/Invoker/pull/7560#issuecomment-1",
        queue_pr_number=7643,
    )
    ctx = m.CheckContext(
        name=CHECK,
        state="failure",
        details_url="https://github.com/EdbertChan/Invoker/actions/runs/1/job/2",
        head_sha=HEAD,
        completed_at="2026-08-06T08:00:00Z",
    )
    return m.PrSnapshot(
        number=PR,
        title="fix: data-store persistence",
        body="stack body",
        url="https://github.com/EdbertChan/Invoker/pull/7560",
        state="OPEN",
        is_draft=False,
        base_ref_name="master",
        head_ref_name="stack/data-store-fix",
        head_ref_oid=HEAD,
        merge_state_status="BLOCKED",
        mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={CHECK: ctx},
        review_threads=(),
        latest_mergify=latest,
    )


class AdminBypassLedgerGapRepro(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="repro-admin-bypass-ledger-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.ledger_path = self.work / "mergify-admin-requeue-state.jsonl"
        self.pr = make_snapshot()
        self.accepted: list[str] = []

        def fake_run_headless(
            command,
            *extra_args,
            timeout_seconds=headless_shell.DEFAULT_TIMEOUT_SECONDS,
        ):
            self.assertIn("headless_mutation", command)
            first = Path(extra_args[0]).read_text(encoding="utf-8").splitlines()[0]
            self.assertTrue(first.startswith("name: "), first)
            self.accepted.append(first[len("name: "):].strip())
            return subprocess.CompletedProcess(
                ["bash", "-c", command],
                returncode=124,
                stdout="",
                stderr=f"timed out after {timeout_seconds}s",
            )

        headless = mock.patch.object(async_repair, "run_headless", fake_run_headless)
        headless.start()
        self.addCleanup(headless.stop)

        infra = mock.patch.object(plan_mod, "repair_task_crashed_on_infra", lambda plan_name: False)
        infra.start()
        self.addCleanup(infra.stop)

        self.repairer = AdminBypassRepairer(
            FakeGh(),
            FakeExecutor(self.work),
            AdminBypassLogger(),
            m.Ledger(self.ledger_path),
            REPO,
        )

    def fresh_ledger(self) -> m.Ledger:
        return m.Ledger(self.ledger_path)

    def timed_out(self, method, *args, now):
        with self.assertRaisesRegex(RuntimeError, "timed out after"):
            method(*args, now=now)

    def planner_actions(self, now):
        return plan_mod.mergify_failed_check_actions(
            self.pr,
            self.fresh_ledger(),
            MAX_REPAIR_ATTEMPTS,
            now,
        )

    def settle(self, epoch):
        self.fresh_ledger().record("repair-check-settled", PR, HEAD, CHECK, epoch)

    def test_timed_out_submit_records_row_on_all_three_repair_paths(self):
        self.timed_out(self.repairer.repair_check, self.pr, CHECK, now=NOW + 1)
        self.assertEqual(self.fresh_ledger().count("repair-check", PR, HEAD, CHECK), 1)

        self.timed_out(
            self.repairer.repair_conflict,
            self.pr,
            "GitHub reports merge conflict",
            now=NOW + 2,
        )
        self.assertEqual(
            self.fresh_ledger().count("conflict-repair", PR, HEAD, f"conflict:{PR}"),
            1,
        )

        self.timed_out(
            self.repairer.repair_bot_thread,
            self.pr,
            "PRRT_kwDOtest",
            now=NOW + 3,
        )
        self.assertEqual(
            self.fresh_ledger().count("repair-bot-thread", PR, HEAD, "PRRT_kwDOtest"),
            1,
        )

        self.assertEqual(len(self.accepted), 3)
        self.assertEqual(
            self.accepted[0],
            async_repair.repair_check_plan_name(PR, CHECK, HEAD),
        )

    def test_unsettled_timeout_arms_repair_in_flight_for_next_tick(self):
        self.timed_out(self.repairer.repair_check, self.pr, CHECK, now=NOW + 1)

        self.assertTrue(
            plan_mod.repair_in_flight(
                self.fresh_ledger(),
                PR,
                HEAD,
                "repair-check",
                CHECK,
                NOW + 2,
            )
        )
        self.assertEqual(self.planner_actions(NOW + 2), ())

    def test_timed_out_attempts_count_toward_retry_cap_after_settle_rows(self):
        self.timed_out(self.repairer.repair_check, self.pr, CHECK, now=NOW + 1)
        self.settle(NOW + 2)

        self.timed_out(self.repairer.repair_check, self.pr, CHECK, now=NOW + 3)
        self.settle(NOW + 4)

        self.assertEqual(self.fresh_ledger().count("repair-check", PR, HEAD, CHECK), 2)
        acts = self.planner_actions(NOW + 5)
        self.assertEqual([(a.kind, a.key) for a in acts], [("repair_check", CHECK)])

        self.timed_out(self.repairer.repair_check, self.pr, CHECK, now=NOW + 6)
        self.settle(NOW + 7)

        self.assertEqual(self.fresh_ledger().count("repair-check", PR, HEAD, CHECK), 3)
        acts = self.planner_actions(NOW + 8)
        self.assertEqual([(a.kind, a.key) for a in acts], [("comment_blocked", "capped")])

    def test_successful_submit_still_records_exactly_one_attempt(self):
        def ok_run_headless(
            command,
            *extra_args,
            timeout_seconds=headless_shell.DEFAULT_TIMEOUT_SECONDS,
        ):
            return subprocess.CompletedProcess(
                ["bash", "-c", command],
                returncode=0,
                stdout="ok",
                stderr="",
            )

        with mock.patch.object(async_repair, "run_headless", ok_run_headless):
            outcome = self.repairer.repair_check(self.pr, CHECK, now=NOW + 1)

        self.assertEqual(outcome.status, "submitted")
        self.assertEqual(self.fresh_ledger().count("repair-check", PR, HEAD, CHECK), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
