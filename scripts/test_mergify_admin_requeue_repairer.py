import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
from scripts.mergify_admin_requeue_logger import AdminBypassLogger
from scripts.mergify_admin_requeue_model import Ledger, PrSnapshot
from scripts.mergify_admin_requeue_repairer import AdminBypassRepairer

HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"
CHECK_NAME = "quality / TypeScript Types"


def make_pr(number=2606):
    return PrSnapshot(
        number=number,
        title=f"PR {number}",
        body="",
        url=f"https://github.com/owner/repo/pull/{number}",
        state="OPEN",
        is_draft=False,
        base_ref_name="master",
        head_ref_name=f"stack/{number}",
        head_ref_oid=HEAD,
        merge_state_status="CLEAN",
        mergeable="MERGEABLE",
        labels=frozenset({"admin-bypass"}),
        checks={},
        review_threads=(),
        latest_mergify=None,
    )


class RepairCheckLedgerOrderingTests(unittest.TestCase):
    """Covers AdminBypassRepairer.repair_check's submit-then-record sequence.

    No test previously exercised this execution path at all -- every existing
    mergify_admin_requeue test seeds a Ledger directly and asserts on the
    planner's resulting decision, never on what repair_check itself does when
    submission and ledger bookkeeping disagree. That gap is why PR #7560's
    "PR Body" check retried 11+ times on 2026-08-06 instead of stopping at the
    3-attempt cap: the DO1 disk filled to 0 bytes free, Ledger.record's
    unguarded append write started raising OSError(ENOSPC), and because
    repair_check submits the real Invoker workflow *before* recording the
    attempt, every write failure left a real, running repair permanently
    invisible to repair_attempt_count_excluding_infra_crash's ledger count.
    """

    def ledger(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Ledger(Path(tmp.name) / "ledger.jsonl")

    def repairer(self, ledger):
        gh = object()  # no pr_detail attribute -> terminal_repair_outcome is a no-op
        logger = AdminBypassLogger()
        executor = AdminBypassGhExecutor(gh, ledger, logger, "owner/repo")
        return AdminBypassRepairer(gh, executor, logger, ledger, "owner/repo")

    def test_a_submitted_repair_is_always_countable_by_the_retry_cap_ledger(self):
        ledger = self.ledger()
        pr = make_pr()
        repairer = self.repairer(ledger)

        submitted = []
        with mock.patch(
            "scripts.mergify_admin_requeue_repairer.async_repair.submit_async_repair_plan",
            side_effect=lambda plan: submitted.append(plan),
        ):
            repairer.repair_check(pr, CHECK_NAME, now=1000)

        self.assertEqual(len(submitted), 1, "expected exactly one real submission")
        self.assertEqual(
            ledger.count("repair-check", pr.number, HEAD, CHECK_NAME),
            1,
            "a submitted repair attempt must always be reflected in the retry-cap ledger",
        )

    def test_a_broken_ledger_write_blocks_submission_instead_of_orphaning_it(self):
        ledger = self.ledger()
        pr = make_pr()
        repairer = self.repairer(ledger)

        def raise_enospc(*args, **kwargs):
            raise OSError(28, "No space left on device")

        submitted = []
        with mock.patch(
            "scripts.mergify_admin_requeue_repairer.async_repair.submit_async_repair_plan",
            side_effect=lambda plan: submitted.append(plan),
        ), mock.patch.object(ledger, "record", side_effect=raise_enospc):
            with self.assertRaises(OSError):
                repairer.repair_check(pr, CHECK_NAME, now=1000)

        self.assertEqual(
            submitted,
            [],
            "must not submit a repair to Invoker when the attempt can't be recorded -- "
            "otherwise the workflow runs but is invisible to the retry cap forever",
        )


if __name__ == "__main__":
    unittest.main()
