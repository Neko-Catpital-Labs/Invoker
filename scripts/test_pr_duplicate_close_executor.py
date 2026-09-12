"""Behavioural tests for ``pr_duplicate_close_executor``.

The executor is the only layer allowed to submit a close, and every action
is CAS-guarded (re-fetch state/headRefOid immediately before acting) against
the value the policy layer decided on. These tests fake `GhClient` and the
Invoker hand-off (`submit_close_pr`) so no real `gh`/`headless_mutation` call
ever happens.

Run:  python3 scripts/test_pr_duplicate_close_executor.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_model as m
import pr_duplicate_close_executor as ex
import pr_duplicate_close_model as dm


class FakeGh:
    def __init__(self, states: dict[int, dict]):
        self.states = states
        self.calls: list[int] = []

    def pr_detail(self, repo: str, number: int) -> dict:
        self.calls.append(number)
        return self.states[number]


class FakeLogger:
    def __init__(self):
        self.events: list[tuple[str, dict]] = []

    def trace(self, event: str, **fields: object) -> None:
        self.events.append((event, fields))


def landed_action(**kw) -> dm.CloseAction:
    base = dict(
        kind=dm.CLOSE_LANDED,
        pr_number=1,
        expected_head_oid="h1",
        reason=dm.LANDED_ANCESTOR,
        evidence="content already on origin/master",
    )
    base.update(kw)
    return dm.CloseAction(**base)


def duplicate_action(**kw) -> dm.CloseAction:
    base = dict(
        kind=dm.CLOSE_DUPLICATE,
        pr_number=5,
        expected_head_oid="h5",
        reason=dm.DUPLICATE_SAME_BRANCH,
        evidence="duplicate of open PR #9",
        kept_pr_number=9,
    )
    base.update(kw)
    return dm.CloseAction(**base)


def flag_action(**kw) -> dm.CloseAction:
    base = dict(
        kind=dm.FLAG_DUPLICATE,
        pr_number=11153,
        expected_head_oid="bfc6",
        reason=dm.DUPLICATE_TITLE_COLLISION_MERGED,
        evidence="title exactly matches already-merged #10820",
        kept_pr_number=10820,
    )
    base.update(kw)
    return dm.CloseAction(**base)


class ExecutorTestCase(unittest.TestCase):
    def _ledger(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        return m.Ledger(Path(d) / "ledger.jsonl")


class CasGuards(ExecutorTestCase):
    def test_aborts_when_own_head_moved(self):
        gh = FakeGh({1: {"state": "OPEN", "headRefOid": "h1-moved"}})
        ledger = self._ledger()
        logger = FakeLogger()
        executor = ex.PrDuplicateCloseExecutor(gh, ledger, logger, "owner/repo")

        with patch.object(ex, "submit_close_pr") as submit:
            performed = executor.execute(landed_action())

        self.assertFalse(performed)
        submit.assert_not_called()
        self.assertEqual(ledger.count(dm.LEDGER_KIND_SUBMIT, 1, "h1", dm.ledger_key(dm.LANDED_ANCESTOR, None)), 0)
        self.assertEqual(logger.events[0][0], "pr-duplicate-close-stale-head-skip")

    def test_aborts_when_own_pr_no_longer_open(self):
        gh = FakeGh({1: {"state": "CLOSED", "headRefOid": "h1"}})
        executor = ex.PrDuplicateCloseExecutor(gh, self._ledger(), FakeLogger(), "owner/repo")

        with patch.object(ex, "submit_close_pr") as submit:
            performed = executor.execute(landed_action())

        self.assertFalse(performed)
        submit.assert_not_called()

    def test_aborts_duplicate_close_when_kept_pr_no_longer_open(self):
        gh = FakeGh({
            5: {"state": "OPEN", "headRefOid": "h5"},
            9: {"state": "CLOSED", "headRefOid": "h9"},
        })
        ledger = self._ledger()
        logger = FakeLogger()
        executor = ex.PrDuplicateCloseExecutor(gh, ledger, logger, "owner/repo")

        with patch.object(ex, "submit_close_pr") as submit:
            performed = executor.execute(duplicate_action())

        self.assertFalse(performed)
        submit.assert_not_called()
        self.assertEqual(logger.events[-1][0], "pr-duplicate-close-kept-pr-not-open-skip")

    def test_proceeds_when_own_head_and_kept_pr_both_current(self):
        gh = FakeGh({
            5: {"state": "OPEN", "headRefOid": "h5"},
            9: {"state": "OPEN", "headRefOid": "h9"},
        })
        executor = ex.PrDuplicateCloseExecutor(gh, self._ledger(), FakeLogger(), "owner/repo")

        with patch.object(ex, "submit_close_pr") as submit:
            performed = executor.execute(duplicate_action())

        self.assertTrue(performed)
        submit.assert_called_once_with(
            pr_number=5, repo="owner/repo", reason="duplicate of open PR #9",
            expected_head_oid="h5", kept_pr_number=9,
        )


class FlagProbableDuplicate(ExecutorTestCase):
    def test_flag_never_checks_the_merged_prs_state(self):
        # #10820 is MERGED, not OPEN -- the CLOSE_DUPLICATE "kept PR must
        # still be open" guard would wrongly block this. A flag only
        # references an immutable merged PR, so that check must not apply.
        gh = FakeGh({11153: {"state": "OPEN", "headRefOid": "bfc6"}})
        executor = ex.PrDuplicateCloseExecutor(gh, self._ledger(), FakeLogger(), "owner/repo")

        with patch.object(ex, "submit_flag_probable_duplicate") as submit:
            performed = executor.execute(flag_action())

        self.assertTrue(performed)
        self.assertNotIn(10820, gh.calls)
        submit.assert_called_once_with(
            pr_number=11153, repo="owner/repo",
            evidence="title exactly matches already-merged #10820",
            expected_head_oid="bfc6", merged_pr_number=10820,
        )

    def test_flag_records_ledger_on_success(self):
        gh = FakeGh({11153: {"state": "OPEN", "headRefOid": "bfc6"}})
        ledger = self._ledger()
        executor = ex.PrDuplicateCloseExecutor(gh, ledger, FakeLogger(), "owner/repo")

        with patch.object(ex, "submit_flag_probable_duplicate"):
            executor.execute(flag_action())

        self.assertEqual(
            ledger.count(dm.LEDGER_KIND_SUBMIT, 11153, "bfc6", dm.ledger_key(dm.DUPLICATE_TITLE_COLLISION_MERGED, 10820)), 1,
        )

    def test_flag_still_aborts_on_stale_head(self):
        gh = FakeGh({11153: {"state": "OPEN", "headRefOid": "moved"}})
        executor = ex.PrDuplicateCloseExecutor(gh, self._ledger(), FakeLogger(), "owner/repo")

        with patch.object(ex, "submit_flag_probable_duplicate") as submit:
            performed = executor.execute(flag_action())

        self.assertFalse(performed)
        submit.assert_not_called()


class SuccessfulHandoff(ExecutorTestCase):
    def test_records_ledger_on_successful_submission(self):
        gh = FakeGh({1: {"state": "OPEN", "headRefOid": "h1"}})
        ledger = self._ledger()
        executor = ex.PrDuplicateCloseExecutor(gh, ledger, FakeLogger(), "owner/repo")

        with patch.object(ex, "submit_close_pr") as submit:
            performed = executor.execute(landed_action())

        self.assertTrue(performed)
        submit.assert_called_once_with(
            pr_number=1, repo="owner/repo", reason="content already on origin/master",
            expected_head_oid="h1", kept_pr_number=None,
        )
        self.assertEqual(ledger.count(dm.LEDGER_KIND_SUBMIT, 1, "h1", dm.ledger_key(dm.LANDED_ANCESTOR, None)), 1)

    def test_submission_failure_does_not_record_ledger_so_it_can_retry(self):
        gh = FakeGh({1: {"state": "OPEN", "headRefOid": "h1"}})
        ledger = self._ledger()
        logger = FakeLogger()
        executor = ex.PrDuplicateCloseExecutor(gh, ledger, logger, "owner/repo")

        with patch.object(ex, "submit_close_pr", side_effect=RuntimeError("headless_mutation failed")):
            performed = executor.execute(landed_action())

        self.assertFalse(performed)
        self.assertEqual(ledger.count(dm.LEDGER_KIND_SUBMIT, 1, "h1", dm.ledger_key(dm.LANDED_ANCESTOR, None)), 0)
        event, fields = logger.events[-1]
        self.assertEqual(event, "pr-duplicate-close-submit-failed")
        self.assertIn("headless_mutation failed", fields["error"])


if __name__ == "__main__":
    unittest.main()
