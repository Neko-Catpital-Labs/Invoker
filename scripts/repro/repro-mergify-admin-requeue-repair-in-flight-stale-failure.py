#!/usr/bin/env python3
"""Hermetic e2e repro for the repair_in_flight stale-failure incident (PR #9172).

repairer.py's ad-hoc repair plans (repair-check, conflict-repair,
repair-bot-thread) settle via their own plan's `safe-push` task, which only
runs if the upstream `repair` task succeeds. When `repair` itself fails,
`safe-push` never runs, so the ledger's `-settled` row is never written --
even though the real workflow is already over. `repair_in_flight` then has
no way to tell the difference between "genuinely still running" and "already
failed, nobody recorded it", and quietly waits out its full 90-minute TTL.

This pins the actual PR #9172 incident shape: a real repair-bot-thread
submission whose workflow fails within a minute, but which `repair_in_flight`
still reports as in-flight nearly an hour later -- proven against the real
`repair_in_flight` (mergify_admin_requeue_plan.py) and, once fixed, the real
`settle_repairer_plan_rows` (mergify_admin_requeue_workflow_fastpath.py). The
only thing faked is the one genuine external boundary: the subprocess call
that lists live Invoker workflows.

Run:  python3 scripts/repro/repro-mergify-admin-requeue-repair-in-flight-stale-failure.py
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import scripts.mergify_admin_requeue_model as m
import scripts.mergify_admin_requeue_plan as plan_mod
import scripts.mergify_admin_requeue_workflow_fastpath as fastpath


PR = 9172
HEAD = "7bbccbd" + "0" * 33
THREAD_ID = "PRRT_kwDOSFkSDM6ZdeL6"
SUBMITTED_AT = 1_786_764_040  # the real epoch this repair was actually submitted at
NOW_ALMOST_AN_HOUR_LATER = SUBMITTED_AT + 55 * 60  # matches the real elapsed time observed live


class RepairInFlightStaleFailureRepro(unittest.TestCase):
    def test_a_failed_repair_stays_in_flight_until_settled_by_the_real_workflow_status(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            ledger = m.Ledger(Path(tmpdir) / "state.jsonl")

            # Exactly what AdminBypassRepairer.repair_bot_thread records before
            # submitting -- no meta, no workflowId, real production shape.
            ledger.record("repair-bot-thread", PR, HEAD, THREAD_ID, SUBMITTED_AT)

            # The real, deterministic plan name the submission used.
            plan_name = fastpath.repair_bot_thread_plan_name(PR, HEAD)

            # The one genuine external boundary: querying live Invoker
            # workflows. This workflow is real and already terminal --
            # it failed less than a minute after being submitted.
            live_workflows = [{
                "id": "wf-1786764055013-3",
                "name": plan_name,
                "status": "failed",
            }]

            still_in_flight_before_any_settlement = plan_mod.repair_in_flight(
                ledger, PR, HEAD, "repair-bot-thread", THREAD_ID, NOW_ALMOST_AN_HOUR_LATER,
            )
            self.assertTrue(
                still_in_flight_before_any_settlement,
                "sanity check: repair_in_flight's own TTL (90 min) has not "
                "elapsed yet at the 55-minute mark, matching the real incident",
            )

            # Run the real settlement pass a scan tick would run, with only
            # the external workflow-listing call faked.
            with mock.patch.object(fastpath, "list_workflows", return_value=live_workflows):
                settled_count = fastpath.settle_repairer_plan_rows(ledger, NOW_ALMOST_AN_HOUR_LATER)

            still_in_flight_after_settlement = plan_mod.repair_in_flight(
                ledger, PR, HEAD, "repair-bot-thread", THREAD_ID, NOW_ALMOST_AN_HOUR_LATER,
            )

            self.assertEqual(settled_count, 1, "the failed workflow should be recognized and settled")
            self.assertFalse(
                still_in_flight_after_settlement,
                "once settled, repair_in_flight must stop waiting on a repair that already failed",
            )


if __name__ == "__main__":
    unittest.main()
