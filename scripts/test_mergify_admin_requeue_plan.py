"""Behavioural tests for ``mergify_admin_requeue_plan``.

Documentation-by-test for the staged planner. This layer first classifies raw PR
state, then builds immutable stack facts, then runs named planning passes to
pick exactly one next ``Action`` from the priority ladder. The ``Ledger`` caps
how often the same repair repeats on the same commit.

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
QUEUE_ONLY_CHECK = "required-fast / Guardrails"


def check(state, name="build"):
    return m.CheckContext(name=name, state=state, details_url="", head_sha=HEAD, completed_at="")


def event(state="dequeued", head=HEAD, comment_id="cm1", failing=(), conditions=(), queue_rule_name="admin-bypass"):
    return m.MergifyQueueEvent(
        comment_id=comment_id,
        state=state,
        queue_rule_name=queue_rule_name,
        queued_at="2026-07-07T05:00:00Z",
        head_sha=head,
        waiting_for=(),
        failing_checks=failing,
        comment_url="u",
        condition_states=conditions,
    )


def pr(**kw):
    base = dict(
        number=1,
        title="t",
        body="",
        url="u",
        state="OPEN",
        is_draft=False,
        base_ref_name="master",
        head_ref_name="branch",
        head_ref_oid=HEAD,
        merge_state_status="BLOCKED",
        mergeable="MERGEABLE",
        labels=frozenset(),
        checks={"build": check("success")},
        review_threads=(),
        latest_mergify=None,
    )
    base.update(kw)
    return m.PrSnapshot(**base)


class PlannerTestCase(unittest.TestCase):
    def _ledger(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        return m.Ledger(Path(d) / "ledger.jsonl")

    def _facts(self, stack, required_checks=REQUIRED, ledger=None, open_pr_numbers=(), trunk="master"):
        ledger = ledger or self._ledger()
        return p.build_stack_facts(stack, required_checks, ledger, open_pr_numbers, trunk), ledger


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
        self.assertEqual(self._kinds(pr(checks={}, base_ref_name="other")), {"not_current_bottom"})

    def test_conflict_from_git_state(self):
        self.assertIn("conflict", self._kinds(pr(merge_state_status="DIRTY")))
        self.assertIn("conflict", self._kinds(pr(mergeable="CONFLICTING")))

    def test_human_vs_bot_review_threads(self):
        human = pr(review_threads=(m.ReviewThread("t", False, ("alice",)),))
        bot = pr(review_threads=(m.ReviewThread("t", False, ("coderabbitai[bot]",)),))
        outdated = pr(review_threads=(m.ReviewThread("t", False, ("coderabbitai[bot]",), True),))
        self.assertIn("human_review_thread", self._kinds(human))
        self.assertIn("bot_review_thread", self._kinds(bot))
        self.assertIn("outdated_bot_review_thread", self._kinds(outdated))

    def test_merge_hold_label(self):
        self.assertIn("merge_hold", self._kinds(pr(labels=frozenset({"merge-hold"}))))


class EffectiveBlockers(unittest.TestCase):
    def test_queue_only_missing_check_is_not_pr_head_blocker(self):
        snapshot = pr(checks={})
        kinds = {
            b.kind for b in p.effective_blockers(
                snapshot,
                {QUEUE_ONLY_CHECK},
                trunk="master",
            )
        }
        self.assertNotIn("missing_check", kinds)

    def test_mergify_success_condition_clears_missing_check(self):
        # classify_pr flags "build" as missing, but the current Mergify event
        # says that condition passed -> the loader-derived blocker is dropped.
        snapshot = pr(checks={}, latest_mergify=event(conditions=(("build", "success"),)))
        kinds = {b.kind for b in p.effective_blockers(snapshot, REQUIRED, trunk="master")}
        self.assertNotIn("missing_check", kinds)

    def test_dequeued_queue_only_failure_clears_missing_check(self):
        snapshot = pr(
            checks={},
            latest_mergify=event(
                failing=(QUEUE_ONLY_CHECK,),
            ),
        )
        kinds = {
            b.kind for b in p.effective_blockers(
                snapshot,
                {QUEUE_ONLY_CHECK},
                trunk="master",
            )
        }
        self.assertNotIn("missing_check", kinds)


class BuildStackFacts(PlannerTestCase):
    """Derived stack facts stay stable and enforce planner invariants."""

    def test_queue_only_missing_check_suppressed_from_blockers(self):
        facts, _ledger = self._facts(
            m.StackGroup(
                "s",
                (
                    pr(
                        checks={},
                        latest_mergify=event(failing=(QUEUE_ONLY_CHECK,)),
                    ),
                ),
            ),
            required_checks={QUEUE_ONLY_CHECK},
        )
        self.assertEqual(facts.blockers_by_pr[1], ())
        self.assertIsNone(facts.queue_only_noop_check)

    def test_prerequisite_created_suppresses_one_followup_requeue(self):
        ledger = self._ledger()
        ledger.record(
            "repair-prereq-created",
            10,
            HEAD,
            "build",
            1,
            meta={"prNumber": 99, "branch": "stack/pr-babysit-prereq-10-aaaaaaa"},
        )
        facts, _ = self._facts(
            m.StackGroup(
                "s",
                (
                    pr(
                        number=10,
                        labels=frozenset({"admin-bypass"}),
                        checks={"build": check("failure")},
                        latest_mergify=event(state="dequeued", comment_id="cm10"),
                    ),
                ),
            ),
            ledger=ledger,
            open_pr_numbers={10},
        )
        self.assertEqual(facts.suppressed_failed_checks_by_pr, {10: ("build",)})
        self.assertEqual(facts.blockers_by_pr[10], ())
        self.assertTrue(facts.prereq_status.needs_followup_requeue)

    def test_queue_only_noop_suppresses_one_followup_requeue(self):
        ledger = self._ledger()
        ledger.record("queue-only-noop", 10, HEAD, QUEUE_ONLY_CHECK, 1)
        facts, _ = self._facts(
            m.StackGroup(
                "s",
                (
                    pr(
                        number=10,
                        labels=frozenset({"admin-bypass", "dequeued"}),
                        checks={},
                        latest_mergify=event(
                            state="dequeued",
                            comment_id="cm10",
                            failing=(QUEUE_ONLY_CHECK,),
                        ),
                    ),
                ),
            ),
            required_checks={QUEUE_ONLY_CHECK},
            ledger=ledger,
            open_pr_numbers={10},
        )
        self.assertEqual(facts.queue_only_noop_check, QUEUE_ONLY_CHECK)
        self.assertEqual(facts.suppressed_failed_checks_by_pr, {10: (QUEUE_ONLY_CHECK,)})
        self.assertEqual(facts.blockers_by_pr[10], ())

    def test_pr_body_noop_suppresses_stale_failed_check_on_bottom(self):
        ledger = self._ledger()
        ledger.record("queue-only-noop", 10, HEAD, QUEUE_ONLY_CHECK, 1)
        ledger.record("repair-noop", 10, HEAD, "PR Body", 2)
        facts, _ = self._facts(
            m.StackGroup(
                "s",
                (
                    pr(
                        number=10,
                        labels=frozenset({"dequeued"}),
                        checks={"PR Body": check("failure", "PR Body")},
                        latest_mergify=event(
                            state="dequeued",
                            comment_id="cm10",
                            failing=(QUEUE_ONLY_CHECK,),
                        ),
                    ),
                ),
            ),
            required_checks={"PR Body", QUEUE_ONLY_CHECK},
            ledger=ledger,
            open_pr_numbers={10},
        )
        self.assertEqual(facts.suppressed_failed_checks_by_pr, {10: (QUEUE_ONLY_CHECK, "PR Body")})
        self.assertEqual(facts.blockers_by_pr[10], ())
        actions = p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3)
        self.assertEqual([(action.kind, action.key) for action in actions], [("restore_admin_bypass_label", QUEUE_ONLY_CHECK)])

    def test_detects_bottom_and_unaccepted_upper(self):
        facts, _ledger = self._facts(
            m.StackGroup(
                "s",
                (
                    pr(number=10, head_ref_name="stack/a", labels=frozenset({"admin-bypass"})),
                    pr(number=11, base_ref_name="stack/a", labels=frozenset({"dequeued"})),
                ),
            ),
        )
        self.assertEqual(facts.bottom.number, 10)
        self.assertTrue(facts.upper_stack_needs_acceptance)


class PlanStackActions(PlannerTestCase):
    """Named planning passes over prebuilt facts still honor the same ladder."""

    def _plan(self, stack_or_snapshot, ledger=None, required_checks=REQUIRED, open_pr_numbers=()):
        ledger = ledger or self._ledger()
        stack = stack_or_snapshot if isinstance(stack_or_snapshot, m.StackGroup) else m.StackGroup("s", (stack_or_snapshot,))
        facts = p.build_stack_facts(stack, required_checks, ledger, open_pr_numbers, "master")
        return p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3)

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

    def test_queued_label_with_headless_active_queue_event_waits(self):
        snapshot = pr(labels=frozenset({"admin-bypass", "queued"}), latest_mergify=event(state="queued", head=""))
        actions = self._plan(snapshot)
        self.assertEqual(actions, ())

    def test_clean_bottom_queues_without_prior_dequeue(self):
        snapshot = pr(labels=frozenset({"admin-bypass"}))
        actions = self._plan(snapshot)
        self.assertEqual((actions[0].kind, actions[0].detail), ("requeue", "eligible-when-ready"))

    def test_upper_human_decision_does_not_block_clean_bottom_requeue(self):
        bottom = pr(number=10, head_ref_name="stack/bottom", labels=frozenset({"admin-bypass"}))
        upper = pr(
            number=11,
            base_ref_name="stack/bottom",
            labels=frozenset({"admin-bypass"}),
            checks={"build": check("failure")},
            repair_stop_comments=(
                m.RepairStopComment(
                    "Mergify repair stopped: worker cannot auto-split this PR on a non-trunk base; human stack split required",
                    "2026-07-20T00:00:00Z",
                    "EdbertChan",
                ),
            ),
        )
        actions = self._plan(m.StackGroup("s", (bottom, upper)))
        self.assertEqual((actions[0].kind, actions[0].pr_number), ("requeue", 10))

    def test_requeue_is_capped_after_repeated_attempts(self):
        ledger = self._ledger()
        # Two prior requeue attempts on this head+key -> the third is capped.
        ledger.record("requeue", 1, HEAD, "cm1")
        ledger.record("requeue", 1, HEAD, "cm1")
        snapshot = pr(labels=frozenset({"admin-bypass"}), latest_mergify=event(state="dequeued", comment_id="cm1"))
        actions = self._plan(snapshot, ledger)
        self.assertEqual((actions[0].kind, actions[0].key), ("comment_blocked", "capped"))

    def test_queue_only_missing_head_check_repairs_from_mergify_failure(self):
        snapshot = pr(
            checks={},
            labels=frozenset({"admin-bypass", "dequeued"}),
            latest_mergify=event(
                failing=(QUEUE_ONLY_CHECK,),
                conditions=((QUEUE_ONLY_CHECK, "failure"),),
            ),
        )
        actions = self._plan(snapshot, required_checks={QUEUE_ONLY_CHECK})
        self.assertEqual(
            [(action.kind, action.key) for action in actions],
            [("repair_check", QUEUE_ONLY_CHECK)],
        )

    def test_admin_bypass_stack_members_progress_as_they_become_bottom(self):
        before_land = m.StackGroup(
            "s",
            (
                pr(number=10, head_ref_name="stack/a", labels=frozenset({"admin-bypass"})),
                pr(number=11, base_ref_name="stack/a", labels=frozenset({"admin-bypass"})),
            ),
        )
        after_land = m.StackGroup(
            "s",
            (
                pr(number=11, labels=frozenset({"admin-bypass"})),
            ),
        )
        self.assertEqual(
            [(action.kind, action.pr_number, action.detail) for action in self._plan(before_land)],
            [("requeue", 10, "eligible-when-ready")],
        )
        self.assertEqual(
            [(action.kind, action.pr_number, action.detail) for action in self._plan(after_land)],
            [("requeue", 11, "eligible-when-ready")],
        )


class PlanStackExecution(PlannerTestCase):
    def test_open_prerequisite_forces_wait_plan(self):
        ledger = self._ledger()
        bottom = pr(
            number=10,
            labels=frozenset({"admin-bypass"}),
            checks={"build": check("failure")},
            latest_mergify=event(state="dequeued"),
        )
        ledger.record(
            "repair-prereq-created",
            10,
            HEAD,
            "build",
            1,
            meta={"prNumber": 99, "branch": "stack/pr-babysit-prereq-10-aaaaaaa"},
        )
        plan = p.plan_stack_execution(
            m.StackGroup("s", (bottom,)),
            REQUIRED,
            ledger,
            now_epoch=0,
            open_pr_numbers={10, 99},
        )
        self.assertEqual(plan.wait_reason, "repair-prereq-open")
        self.assertEqual(plan.actions, ())
        self.assertEqual(plan.prereq_status.prereq_pr_number, 99)
        self.assertTrue(plan.prereq_status.is_open)
        self.assertIsNone(plan.queue_only_noop_check)

    def test_closed_prerequisite_suppresses_one_failed_check_for_requeue(self):
        ledger = self._ledger()
        bottom = pr(
            number=10,
            labels=frozenset({"admin-bypass"}),
            checks={"build": check("failure")},
            latest_mergify=event(state="dequeued", comment_id="cm1"),
        )
        ledger.record(
            "repair-prereq-created",
            10,
            HEAD,
            "build",
            1,
            meta={"prNumber": 99, "branch": "stack/pr-babysit-prereq-10-aaaaaaa"},
        )
        plan = p.plan_stack_execution(
            m.StackGroup("s", (bottom,)),
            REQUIRED,
            ledger,
            now_epoch=0,
            open_pr_numbers={10},
        )
        self.assertEqual(plan.actions[0].kind, "requeue")
        self.assertTrue(plan.prereq_status.needs_followup_requeue)

    def test_queue_only_noop_restores_label_then_requeues_then_retries_normally(self):
        ledger = self._ledger()
        bottom = pr(
            number=10,
            checks={},
            labels=frozenset({"dequeued"}),
            latest_mergify=event(
                state="dequeued",
                comment_id="cm10",
                failing=(QUEUE_ONLY_CHECK,),
            ),
        )
        ledger.record("queue-only-noop", 10, HEAD, QUEUE_ONLY_CHECK, 1)
        restore = p.plan_stack_execution(
            m.StackGroup("s", (bottom,)),
            {QUEUE_ONLY_CHECK},
            ledger,
            now_epoch=0,
            open_pr_numbers={10},
        )
        self.assertEqual(
            [(action.kind, action.key) for action in restore.actions],
            [("restore_admin_bypass_label", QUEUE_ONLY_CHECK)],
        )
        self.assertEqual(restore.queue_only_noop_check, QUEUE_ONLY_CHECK)

        requeue = p.plan_stack_execution(
            m.StackGroup(
                "s",
                (
                    pr(
                        number=10,
                        checks={},
                        labels=frozenset({"admin-bypass", "dequeued"}),
                        latest_mergify=event(
                            state="dequeued",
                            comment_id="cm10",
                            failing=(QUEUE_ONLY_CHECK,),
                        ),
                    ),
                ),
            ),
            {QUEUE_ONLY_CHECK},
            ledger,
            now_epoch=0,
            open_pr_numbers={10},
        )
        self.assertEqual(
            [(action.kind, action.key) for action in requeue.actions],
            [("requeue", "cm10")],
        )

        ledger.record("queue-only-requeue", 10, HEAD, QUEUE_ONLY_CHECK, 2)
        retry = p.plan_stack_execution(
            m.StackGroup(
                "s",
                (
                    pr(
                        number=10,
                        checks={},
                        labels=frozenset({"admin-bypass", "dequeued"}),
                        latest_mergify=event(
                            state="dequeued",
                            comment_id="cm10",
                            failing=(QUEUE_ONLY_CHECK,),
                        ),
                    ),
                ),
            ),
            {QUEUE_ONLY_CHECK},
            ledger,
            now_epoch=0,
            open_pr_numbers={10},
        )
        self.assertEqual(
            [(action.kind, action.key) for action in retry.actions],
            [("repair_check", QUEUE_ONLY_CHECK)],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
