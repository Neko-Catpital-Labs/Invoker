"""Behavioural tests for ``mergify_admin_requeue_plan``.

Documentation-by-test for the planner. This layer does not parse text — it reads
a typed ``PrSnapshot``/``StackGroup`` and decides the single next ``Action`` to
take, via a fixed priority ladder. The ``Ledger`` caps how often the same repair
repeats on the same commit.

`classify_pr` reads a PR's state into blockers; `plan_stack_actions` turns those
blockers into exactly one action, honouring priority and the retry caps. Each
test pins one rung of that ladder and why it fires.

Run:  python3 scripts/test_mergify_admin_requeue_plan.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_model as m
import mergify_admin_requeue_plan as p


HEAD = "a" * 40
REQUIRED = {"build"}


def check(state, name="build"):
    return m.CheckContext(name=name, state=state, details_url="", head_sha=HEAD, completed_at="")


def event(state="dequeued", head=HEAD, comment_id="cm1", failing=(), conditions=()):
    return m.MergifyQueueEvent(
        comment_id=comment_id, state=state, queue_rule_name="default",
        queued_at="2026-07-07T05:00:00Z", head_sha=head, waiting_for=(),
        failing_checks=failing, comment_url="u", condition_states=conditions,
    )


def pr(**kw):
    base = dict(
        number=1, title="t", url="u", state="OPEN", is_draft=False,
        base_ref_name="master", head_ref_name="branch", head_ref_oid=HEAD,
        merge_state_status="BLOCKED", mergeable="MERGEABLE",
        labels=frozenset(), checks={"build": check("success")},
        review_threads=(), latest_mergify=None,
    )
    base.update(kw)
    return m.PrSnapshot(**base)


class ClassifyPr(unittest.TestCase):
    """Reading a PR's state into blocker reasons."""

    def _kinds(self, snapshot):
        return {b.kind for b in p.classify_pr(snapshot, REQUIRED, trunk="master")}

    def test_green_pr_has_no_blockers(self):
        self.assertEqual(self._kinds(pr()), set())

    def test_draft_short_circuits(self):
        self.assertEqual(self._kinds(pr(is_draft=True)), {"draft"})

    def test_closed_short_circuits(self):
        self.assertEqual(self._kinds(pr(state="CLOSED")), {"closed"})

    def test_failed_required_check(self):
        self.assertEqual(self._kinds(pr(checks={"build": check("failure")})), {"failed_check"})

    def test_missing_required_check_only_on_bottom(self):
        # Missing check counts as a blocker only when the PR sits on trunk.
        self.assertEqual(self._kinds(pr(checks={})), {"missing_check"})
        self.assertEqual(self._kinds(pr(checks={}, base_ref_name="other")),
                         {"not_current_bottom"})

    def test_conflict_from_git_state(self):
        self.assertIn("conflict", self._kinds(pr(merge_state_status="DIRTY")))
        self.assertIn("conflict", self._kinds(pr(mergeable="CONFLICTING")))

    def test_human_vs_bot_review_threads(self):
        human = pr(review_threads=(m.ReviewThread("t", False, ("alice",)),))
        bot = pr(review_threads=(m.ReviewThread("t", False, ("coderabbitai[bot]",)),))
        self.assertIn("human_review_thread", self._kinds(human))
        self.assertIn("bot_review_thread", self._kinds(bot))

    def test_merge_hold_label(self):
        self.assertIn("merge_hold", self._kinds(pr(labels=frozenset({"merge-hold"}))))


class EffectiveBlockers(unittest.TestCase):
    def test_mergify_success_condition_clears_missing_check(self):
        # classify_pr flags "build" as missing, but the current Mergify event
        # says that condition passed -> the loader-derived blocker is dropped.
        snapshot = pr(checks={}, latest_mergify=event(conditions=(("build", "success"),)))
        kinds = {b.kind for b in p.effective_blockers(snapshot, REQUIRED, trunk="master")}
        self.assertNotIn("missing_check", kinds)


class PlanStackActions(unittest.TestCase):
    """The priority ladder: one PR state in, one Action out."""

    def _ledger(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        return m.Ledger(Path(d) / "ledger.jsonl")

    def _plan(self, snapshot, ledger=None):
        ledger = ledger or self._ledger()
        return p.plan_stack_actions(m.StackGroup("s", (snapshot,)), REQUIRED, ledger, now_epoch=0)

    def test_pending_check_means_wait_do_nothing(self):
        self.assertEqual(self._plan(pr(checks={"build": check("pending")})), ())

    def test_conflict_triggers_claude_repair(self):
        actions = self._plan(pr(merge_state_status="DIRTY"))
        self.assertEqual((actions[0].kind, actions[0].pr_number), ("repair_conflict", 1))

    def test_failed_check_triggers_repair(self):
        actions = self._plan(pr(checks={"build": check("failure")}))
        self.assertEqual((actions[0].kind, actions[0].key), ("repair_check", "build"))

    def test_mergify_dequeue_with_failing_check_repairs_first(self):
        # A Mergify dequeue naming a failing check outranks everything else.
        actions = self._plan(pr(latest_mergify=event(failing=("build",))))
        self.assertEqual(actions[0].kind, "repair_check")

    def test_clean_bottom_missing_label_nudges_human(self):
        actions = self._plan(pr())  # green, no admin-bypass label
        self.assertEqual((actions[0].kind, actions[0].key), ("comment_admin_bypass_nudge", "admin-bypass"))

    def test_clean_bottom_dequeued_gets_requeued(self):
        snapshot = pr(labels=frozenset({"admin-bypass"}), latest_mergify=event(state="dequeued"))
        actions = self._plan(snapshot)
        self.assertEqual((actions[0].kind, actions[0].detail), ("requeue", "eligible-after-dequeue"))

    def test_clean_bottom_queues_without_prior_dequeue(self):
        snapshot = pr(labels=frozenset({"admin-bypass"}))
        actions = self._plan(snapshot)
        self.assertEqual((actions[0].kind, actions[0].detail), ("requeue", "eligible-when-ready"))

    def test_requeue_is_capped_after_repeated_attempts(self):
        ledger = self._ledger()
        # Two prior requeue attempts on this head+key -> the third is capped.
        ledger.record("requeue", 1, HEAD, "cm1")
        ledger.record("requeue", 1, HEAD, "cm1")
        snapshot = pr(labels=frozenset({"admin-bypass"}), latest_mergify=event(state="dequeued", comment_id="cm1"))
        actions = self._plan(snapshot, ledger)
        self.assertEqual((actions[0].kind, actions[0].key), ("comment_blocked", "capped"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
