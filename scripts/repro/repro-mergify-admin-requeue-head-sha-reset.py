#!/usr/bin/env python3
"""Hermetic repro for the admin-bypass retry-cap head_sha reset thrash.

Live incident shape: PR 9067's `UI Vitest` check kept failing, and each
repair attempt that ran pushed a new commit (a normal side effect of a
repair) -- so the *next* tick's ledger lookup, keyed on the current
head_sha, never saw the prior attempts. The retry cap (max_repair_attempts=3)
never fired: the same check refiled repeatedly across several different
head_shas in one day, never once appearing "capped" to a human.

This drives the *real* production code path -- AdminBypassRepairer.repair_check
and mergify_failed_check_actions, backed by a real on-disk Ledger -- across
four simulated ticks, each on a new head_sha (mirroring the real side effect
of a successful repair push). Only the actual external submission boundary
(async_repair.run_headless, which would otherwise shell out to a live
Invoker instance) is faked, following the same pattern as
repro-admin-bypass-ledger-gap.py.

Run:  python3 scripts/repro/repro-mergify-admin-requeue-head-sha-reset.py
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

PR = 9067
CHECK = "UI Vitest"
REPO = "Neko-Catpital-Labs/Invoker"
NOW = 1_786_732_000
MAX_REPAIR_ATTEMPTS = 3
HEAD_SHAS = [f"{n}" * 40 for n in ("1", "2", "3", "4")]


class FakeGh:
    """GhClient double: PR is always OPEN so terminal_repair_outcome never exits early."""

    def pr_detail(self, repo, number):
        return {"state": "OPEN"}


class FakeExecutor:
    """AdminBypassGhExecutor double: a non-empty job log so repair_check
    doesn't take the queue-only-noop branch for this ordinary failed check."""

    def __init__(self, work: Path):
        self.log = work / "job-log.txt"
        self.log.write_text("UI Vitest: 3 failing tests\nexit 1\n", encoding="utf-8")

    def download_job_log(self, repo, details_url, pr_number, check_name):
        return str(self.log)


def make_snapshot(head_sha: str) -> m.PrSnapshot:
    """Build the PR snapshot as it would look right after a push lands: same
    check still failing, but on a brand-new commit -- the exact real-world
    side effect a successful repair attempt produces."""
    latest = m.MergifyQueueEvent(
        comment_id="c1",
        state="dequeued",
        queue_rule_name="default",
        queued_at="2026-08-14T09:00:00Z",
        head_sha=head_sha,
        waiting_for=(),
        failing_checks=(CHECK,),
        comment_url=f"https://github.com/{REPO}/pull/{PR}#issuecomment-1",
        queue_pr_number=9067,
    )
    ctx = m.CheckContext(
        name=CHECK,
        state="failure",
        details_url="https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",
        head_sha=head_sha,
        completed_at="2026-08-14T09:00:00Z",
    )
    return m.PrSnapshot(
        number=PR,
        title="[CI regression: e73ee55-ui-vitest] Install libatomic for UI Vitest",
        body="",
        url=f"https://github.com/{REPO}/pull/{PR}",
        state="OPEN",
        is_draft=False,
        base_ref_name="master",
        head_ref_name="stack/ui-vitest-fix",
        head_ref_oid=head_sha,
        merge_state_status="BLOCKED",
        mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={CHECK: ctx},
        review_threads=(),
        latest_mergify=latest,
    )


class HeadShaResetThrash(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="repro-admin-requeue-head-sha-reset-")
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        self.ledger_path = self.work / "mergify-admin-requeue-state.jsonl"
        self.submitted_plan_names: list[str] = []

        def ok_run_headless(command, *extra_args, timeout_seconds=headless_shell.DEFAULT_TIMEOUT_SECONDS):
            plan_path = Path(extra_args[0])
            first_line = plan_path.read_text(encoding="utf-8").splitlines()[0]
            self.submitted_plan_names.append(first_line[len("name: "):].strip())
            return subprocess.CompletedProcess(["bash", "-c", command], returncode=0, stdout="ok", stderr="")

        headless = mock.patch.object(async_repair, "run_headless", ok_run_headless)
        headless.start()
        self.addCleanup(headless.stop)

        infra = mock.patch.object(plan_mod, "repair_task_crashed_on_infra", lambda plan_name: False)
        infra.start()
        self.addCleanup(infra.stop)

        self.repairer = AdminBypassRepairer(
            FakeGh(), FakeExecutor(self.work), AdminBypassLogger(), m.Ledger(self.ledger_path), REPO,
        )

    def fresh_ledger(self) -> m.Ledger:
        return m.Ledger(self.ledger_path)

    def planner_actions(self, head_sha: str, now: int):
        return plan_mod.mergify_failed_check_actions(
            make_snapshot(head_sha), self.fresh_ledger(), MAX_REPAIR_ATTEMPTS, now,
        )

    def test_four_repair_attempts_across_four_head_shas_never_caps(self):
        # Three real repair attempts, each on a NEW head_sha (as if the prior
        # attempt's own push landed before this tick's sweep ran).
        for index, head_sha in enumerate(HEAD_SHAS[:3]):
            outcome = self.repairer.repair_check(make_snapshot(head_sha), CHECK, now=NOW + index)
            self.assertEqual(outcome.status, "submitted")

        self.assertEqual(len(self.submitted_plan_names), 3)
        # Each of the 3 attempts landed as its own ledger row (proves nothing
        # was silently dropped) -- but every row is under a DIFFERENT head_sha.
        for head_sha in HEAD_SHAS[:3]:
            self.assertEqual(self.fresh_ledger().count("repair-check", PR, head_sha, CHECK), 1)

        # Fixed: on the 4th head_sha, with 3 real prior attempts already on
        # record, the planner now correctly caps it instead of filing a 4th.
        # retry_decision() counts via Ledger.count_by_unit(), which persists
        # across the head_sha change instead of resetting on every new commit.
        actions = self.planner_actions(HEAD_SHAS[3], NOW + 10)
        self.assertEqual([(a.kind, a.key) for a in actions], [("comment_blocked", "capped")])


if __name__ == "__main__":
    unittest.main(verbosity=2)
