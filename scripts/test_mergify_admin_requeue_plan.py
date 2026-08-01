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
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_model as m
import mergify_admin_requeue_plan as p


HEAD = "a" * 40
REQUIRED = {"build"}
QUEUE_ONLY_CHECK = "required-fast / Guardrails"
NOW = 2_000_000_000


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

    def _facts(self, stack, required_checks=REQUIRED, ledger=None, open_pr_numbers=(), open_pr_numbers_by_head=None, trunk="master"):
        ledger = ledger or self._ledger()
        return p.build_stack_facts(stack, required_checks, ledger, open_pr_numbers, open_pr_numbers_by_head or {}, trunk), ledger


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

    def test_merged_short_circuits(self):
        self.assertEqual(self._kinds(pr(state="MERGED")), {"merged"})

    def test_failed_required_check(self):
        self.assertEqual(self._kinds(pr(checks={"build": check("failure")})), {"failed_check"})

    def test_missing_required_check_only_on_bottom(self):
        # Missing check counts as a blocker only when the PR sits on trunk.
        self.assertEqual(self._kinds(pr(checks={})), {"missing_check"})
        self.assertEqual(self._kinds(pr(checks={}, base_ref_name="other")), set())

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



class ClassifyBottomTopology(unittest.TestCase):
    def test_open_trunk_root_is_current_bottom(self):
        stack = m.StackGroup("s", (pr(number=10),))
        topology = p.classify_bottom_topology(stack, "master", {})
        self.assertEqual(topology.kind, "current_bottom")
        self.assertEqual(topology.root.number, 10)
        self.assertEqual(topology.bottom.number, 10)
        self.assertEqual(topology.external_open_base_pr_numbers, ())

    def test_stale_root_with_outside_owner_is_external_open_base(self):
        stack = m.StackGroup(
            "s",
            (
                pr(number=10, base_ref_name="pr/babysit-prereq-split"),
                pr(number=11, base_ref_name="stack/a"),
            ),
        )
        topology = p.classify_bottom_topology(stack, "master", {"pr/babysit-prereq-split": (7001,)})
        self.assertEqual(topology.kind, "external_open_base")
        self.assertIsNone(topology.bottom)
        self.assertEqual(topology.external_open_base_pr_numbers, (7001,))

    def test_stale_root_with_no_outside_owner_is_stale_unowned_base(self):
        stack = m.StackGroup(
            "s",
            (
                pr(number=10, base_ref_name="pr/babysit-prereq-split"),
                pr(number=11, base_ref_name="stack/a"),
            ),
        )
        topology = p.classify_bottom_topology(stack, "master", {})
        self.assertEqual(topology.kind, "stale_unowned_base")
        self.assertIsNone(topology.bottom)
        self.assertEqual(topology.external_open_base_pr_numbers, ())

    def test_same_stack_parent_owner_is_not_treated_as_external(self):
        stack = m.StackGroup(
            "s",
            (
                pr(number=10, base_ref_name="stack/shared-parent", head_ref_name="stack/child"),
                pr(number=11, base_ref_name="stack/child", head_ref_name="stack/shared-parent"),
            ),
        )
        topology = p.classify_bottom_topology(stack, "master", {"stack/shared-parent": (11,)})
        self.assertEqual(topology.kind, "stale_unowned_base")
        self.assertIsNone(topology.bottom)
        self.assertEqual(topology.external_open_base_pr_numbers, ())


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
        actions = p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3, now=NOW)
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

    def _plan(self, stack_or_snapshot, ledger=None, required_checks=REQUIRED, open_pr_numbers=(), open_pr_numbers_by_head=None):
        ledger = ledger or self._ledger()
        stack = stack_or_snapshot if isinstance(stack_or_snapshot, m.StackGroup) else m.StackGroup("s", (stack_or_snapshot,))
        facts = p.build_stack_facts(stack, required_checks, ledger, open_pr_numbers, open_pr_numbers_by_head or {}, "master")
        return p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3, now=NOW)

    def test_pending_check_means_wait_do_nothing(self):
        self.assertEqual(self._plan(pr(checks={"build": check("pending")})), ())

    def test_merged_pr_is_terminal_noop(self):
        plan = p.plan_stack_execution(
            m.StackGroup("s", (pr(number=6108, state="MERGED", labels=frozenset({"admin-bypass"})),)),
            REQUIRED,
            self._ledger(),
            now_epoch=0,
            open_pr_numbers=set(),
            open_pr_numbers_by_head={},
        )
        self.assertEqual(plan.actions, ())
        self.assertEqual(plan.wait_reason, "terminal-merged")

    def test_conflict_triggers_claude_repair(self):
        actions = self._plan(pr(merge_state_status="DIRTY"))
        self.assertEqual((actions[0].kind, actions[0].pr_number), ("repair_conflict", 1))

    def test_repair_invalid_conflict_stops_retrying(self):
        ledger = self._ledger()
        ledger.record(
            "repair-invalid",
            6118,
            HEAD,
            "conflict",
            1,
            meta={"errors": ["requires a human to decide whether this stale duplicate stack is superseded"]},
        )
        snapshot = pr(
            number=6118,
            labels=frozenset({"admin-bypass"}),
            merge_state_status="DIRTY",
            mergeable="CONFLICTING",
            latest_mergify=event(state="queued", head=""),
        )
        plan = p.plan_stack_execution(
            m.StackGroup("s", (snapshot,)),
            REQUIRED,
            ledger,
            now_epoch=0,
            open_pr_numbers={6118},
            open_pr_numbers_by_head={},
        )
        self.assertEqual(plan.actions, ())
        self.assertEqual(plan.wait_reason, "blocked-needs-human")
        blockers = plan.summary["prs"][0]["blockers"]
        self.assertEqual(blockers[0]["kind"], "human_decision")
        self.assertIn("stale duplicate stack", blockers[0]["detail"])

    def test_clean_unaccepted_upper_stack_posts_exact_human_blocker_once(self):
        ledger = self._ledger()
        bottom = pr(
            number=6435,
            labels=frozenset({"admin-bypass"}),
            latest_mergify=event(state="dequeued", head="c" * 40, comment_id="old"),
        )
        upper = pr(
            number=6439,
            base_ref_name=bottom.head_ref_name,
            head_ref_name="stack/top",
            head_ref_oid="b" * 40,
            labels=frozenset(),
        )
        plan = p.plan_stack_execution(
            m.StackGroup("s", (bottom, upper)),
            REQUIRED,
            ledger,
            now_epoch=0,
            open_pr_numbers={6435, 6439},
            open_pr_numbers_by_head={bottom.head_ref_name: (6435,), upper.head_ref_name: (6439,)},
        )
        self.assertEqual([(action.kind, action.key, action.pr_number) for action in plan.actions], [("comment_blocked", "upper-stack-needs-acceptance", 6435)])
        self.assertIn("#6439", plan.actions[0].detail)
        self.assertIn("without `admin-bypass`", plan.actions[0].detail)

        ledger.record("comment-blocked", 6435, HEAD, "upper-stack-needs-acceptance", 1)
        repeated = p.plan_stack_execution(
            m.StackGroup("s", (bottom, upper)),
            REQUIRED,
            ledger,
            now_epoch=0,
            open_pr_numbers={6435, 6439},
            open_pr_numbers_by_head={bottom.head_ref_name: (6435,), upper.head_ref_name: (6439,)},
        )
        self.assertEqual(repeated.actions, ())
        self.assertEqual(repeated.wait_reason, "upper-stack-needs-acceptance")

    def test_failed_check_triggers_repair(self):
        actions = self._plan(pr(checks={"build": check("failure")}))
        self.assertEqual((actions[0].kind, actions[0].key), ("repair_check", "build"))

    def test_repair_invalid_bot_thread_suppresses_other_repairs_on_same_pr(self):
        ledger = self._ledger()
        ledger.record(
            "repair-invalid",
            6158,
            HEAD,
            "PRRT_kwDOSFkSDM6T97v9",
            1,
            meta={"errors": ['PR body Review Unit "routing" cannot ship with activation-surface files in the same PR. Split this into one Review Unit per PR.']},
        )
        snapshot = pr(
            number=6158,
            labels=frozenset({"admin-bypass"}),
            checks={"build": check("failure")},
            review_threads=(m.ReviewThread("PRRT_kwDOSFkSDM6T97v9", False, ("coderabbitai[bot]",)),),
        )
        plan = p.plan_stack_execution(
            m.StackGroup("s", (snapshot,)),
            REQUIRED,
            ledger,
            now_epoch=0,
            open_pr_numbers={6158},
            open_pr_numbers_by_head={},
        )
        self.assertEqual(plan.actions, ())
        self.assertEqual(plan.wait_reason, "blocked-needs-human")
        blockers = plan.summary["prs"][0]["blockers"]
        self.assertEqual(blockers[0]["kind"], "human_decision")
        self.assertEqual(blockers[1]["kind"], "failed_check")

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

    def test_headless_active_queue_event_waits_without_queued_label(self):
        snapshot = pr(labels=frozenset({"admin-bypass"}), latest_mergify=event(state="queued", head=""))
        plan = p.plan_stack_execution(
            m.StackGroup("s", (snapshot,)),
            REQUIRED,
            self._ledger(),
            now_epoch=0,
            open_pr_numbers={snapshot.number},
            open_pr_numbers_by_head={},
        )
        self.assertEqual(plan.actions, ())
        self.assertEqual(plan.wait_reason, "bottom-already-queued")

    def test_stale_active_queue_event_without_queued_label_requeues_current_head(self):
        snapshot = pr(labels=frozenset({"admin-bypass"}), latest_mergify=event(state="queued", head="b" * 40))
        actions = self._plan(snapshot)
        self.assertEqual((actions[0].kind, actions[0].detail), ("requeue", "eligible-when-ready"))

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

    def test_upper_conflict_does_not_block_clean_bottom_requeue(self):
        bottom = pr(number=10, head_ref_name="stack/bottom", labels=frozenset({"admin-bypass"}))
        upper = pr(
            number=11,
            base_ref_name="stack/bottom",
            head_ref_name="stack/upper",
            labels=frozenset({"admin-bypass"}),
            merge_state_status="DIRTY",
            mergeable="CONFLICTING",
        )

        actions = self._plan(m.StackGroup("s", (bottom, upper)))
        self.assertEqual((actions[0].kind, actions[0].pr_number), ("requeue", 10))

    def test_bottom_bot_thread_repairs_before_upper_conflict(self):
        bottom = pr(
            number=10,
            head_ref_name="stack/bottom",
            labels=frozenset({"admin-bypass"}),
            review_threads=(m.ReviewThread("PRRT_bot", False, ("coderabbitai[bot]",)),),
        )
        upper = pr(
            number=11,
            base_ref_name="stack/bottom",
            head_ref_name="stack/upper",
            labels=frozenset({"admin-bypass"}),
            merge_state_status="DIRTY",
            mergeable="CONFLICTING",
        )

        actions = self._plan(m.StackGroup("s", (bottom, upper)))
        self.assertEqual(
            [(action.kind, action.pr_number, action.key) for action in actions],
            [("repair_check", 10, "bot_review_thread:PRRT_bot")],
        )

    def test_clean_upper_pr_with_only_a_false_positive_base_signal_is_never_touched(self):
        # Regression coverage for #6536/#6579: the upper PR has zero blocker
        # signal of its own -- clean checks, no review threads -- and only
        # "looks" blocked because its base branch (the lower PR's head) is
        # still moving. The planner must target the lower PR only.
        bottom = pr(
            number=10,
            head_ref_name="stack/bottom",
            labels=frozenset({"admin-bypass"}),
            checks={"build": check("failure")},
        )
        upper = pr(
            number=11,
            base_ref_name="stack/bottom",
            head_ref_name="stack/upper",
            labels=frozenset({"admin-bypass"}),
        )

        facts, _ledger = self._facts(m.StackGroup("s", (bottom, upper)))
        self.assertEqual(facts.blockers_by_pr[11], ())

        actions = self._plan(m.StackGroup("s", (bottom, upper)))
        self.assertEqual(
            [(action.kind, action.pr_number, action.key) for action in actions],
            [("repair_check", 10, "build")],
        )
        self.assertTrue(all(action.pr_number != 11 for action in actions))

    def test_stale_root_base_retargets_root_pr(self):
        stack = m.StackGroup(
            "s",
            (
                pr(
                    number=5885,
                    base_ref_name="pr/babysit-prereq-split",
                    labels=frozenset({"admin-bypass"}),
                ),
                pr(
                    number=5886,
                    base_ref_name="stack/slack-routing",
                    labels=frozenset({"admin-bypass"}),
                ),
            ),
        )
        facts, ledger = self._facts(stack, open_pr_numbers_by_head={})
        self.assertEqual(facts.bottom_topology.kind, "stale_unowned_base")
        actions = p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3, now=NOW)
        self.assertEqual((actions[0].kind, actions[0].pr_number, actions[0].key), ("retarget_base", 5885, "master"))
        self.assertIn("`pr/babysit-prereq-split`", actions[0].detail)
        self.assertIn("`master`", actions[0].detail)

    def test_external_open_base_owner_blocks_instead_of_retargeting(self):
        stack = m.StackGroup(
            "s",
            (
                pr(
                    number=5885,
                    base_ref_name="pr/babysit-prereq-split",
                    labels=frozenset({"admin-bypass"}),
                ),
                pr(
                    number=5886,
                    base_ref_name="stack/slack-routing",
                    labels=frozenset({"admin-bypass"}),
                ),
            ),
        )
        facts, ledger = self._facts(stack, open_pr_numbers_by_head={"pr/babysit-prereq-split": (7001,)})
        self.assertEqual(facts.bottom_topology.kind, "external_open_base")
        actions = p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3, now=NOW)
        self.assertEqual((actions[0].kind, actions[0].pr_number, actions[0].key), ("comment_blocked", 5885, "external-open-base-pr"))
        self.assertIn("#7001", actions[0].detail)

    def test_stale_root_retarget_ignores_unrelated_stack(self):
        stale_stack = m.StackGroup(
            "stack-a",
            (
                pr(
                    number=5885,
                    base_ref_name="pr/babysit-prereq-split",
                    head_ref_name="stack/slack-routing-1",
                    labels=frozenset({"admin-bypass"}),
                ),
                pr(
                    number=5886,
                    base_ref_name="stack/slack-routing-1",
                    head_ref_name="stack/slack-routing-2",
                    labels=frozenset({"admin-bypass"}),
                ),
            ),
        )
        facts, ledger = self._facts(stale_stack, open_pr_numbers_by_head={})
        self.assertEqual(facts.bottom_topology.kind, "stale_unowned_base")
        actions = p.plan_actions_from_facts(facts, ledger, max_requeue_attempts=2, max_repair_attempts=3, now=NOW)
        self.assertEqual([(action.kind, action.pr_number) for action in actions], [("retarget_base", 5885)])

    def test_stale_root_failed_check_repairs_before_retarget(self):
        stack = m.StackGroup(
            "s",
            (
                pr(
                    number=5885,
                    base_ref_name="pr/babysit-prereq-split",
                    labels=frozenset({"admin-bypass"}),
                    checks={"build": check("failure")},
                ),
                pr(
                    number=5886,
                    base_ref_name="stack/slack-routing",
                    labels=frozenset({"admin-bypass"}),
                ),
            ),
        )
        facts, _ledger = self._facts(stack, open_pr_numbers_by_head={})
        self.assertEqual(facts.bottom_topology.kind, "stale_unowned_base")
        actions = p.plan_stack_actions(stack, REQUIRED, self._ledger(), now_epoch=0, open_pr_numbers_by_head={})
        self.assertEqual([(action.kind, action.key) for action in actions], [("repair_check", "build")])

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


class RepairCrashReason(PlannerTestCase):
    """A submitted repair whose own Invoker workflow crashed with the known
    SSH/OAuth infra signature (the coding agent never launched) must not be
    silently treated the same as a normal failed repair attempt: it should
    neither keep eating the retry cap nor resubmit forever waiting on the
    in-flight TTL, since no amount of waiting changes an infra crash."""

    def test_none_when_never_submitted(self):
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra") as crash_check:
            result = p.repair_crash_reason(self._ledger(), 1, HEAD, "repair-check", "build", "plan-name")
        self.assertIsNone(result)
        crash_check.assert_not_called()

    def test_none_when_already_settled(self):
        ledger = self._ledger()
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        ledger.record("repair-check-settled", 1, HEAD, "build", epoch=NOW - 50)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra") as crash_check:
            result = p.repair_crash_reason(ledger, 1, HEAD, "repair-check", "build", "plan-name")
        self.assertIsNone(result)
        crash_check.assert_not_called()

    def test_signature_returned_when_still_unsettled_and_workflow_crashed(self):
        ledger = self._ledger()
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=True) as crash_check:
            result = p.repair_crash_reason(ledger, 1, HEAD, "repair-check", "build", "plan-name")
        self.assertEqual(result, p.SSH_OAUTH_INFRA_SIGNATURE)
        crash_check.assert_called_once_with("plan-name")

    def test_none_when_unsettled_but_workflow_did_not_crash_on_infra(self):
        ledger = self._ledger()
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=False):
            result = p.repair_crash_reason(ledger, 1, HEAD, "repair-check", "build", "plan-name")
        self.assertIsNone(result)


class InfraCrashDoesNotCountAgainstCap(PlannerTestCase):
    """An attempt whose own Invoker workflow crashed with the known SSH/OAuth
    infra signature never gave the coding agent a chance to touch the PR, so
    it must not spend retry-cap budget a real attempt would have used --
    and, since there is nothing left to wait out, a fresh attempt is
    resubmitted immediately rather than waiting on the in-flight TTL. This
    module only adjusts what counts; it never decides to stop, alert, or
    otherwise act on the crash itself -- that is the autofix worker's job
    (packages/execution-engine/src/auto-fix-recovery.ts), not this planner's."""

    def test_plan_direct_repairs_failed_check_resubmits_instead_of_blocking(self):
        ledger = self._ledger()
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        snapshot = pr(labels=frozenset({"admin-bypass"}), checks={"build": check("failure")})
        facts, _ = self._facts(m.StackGroup("s", (snapshot,)), ledger=ledger)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=True):
            action = p.plan_direct_repairs(facts, ledger, max_repair_attempts=3, now=NOW)
        # A fresh repair is submitted -- the crashed attempt is excluded from
        # the cap and does not block on the in-flight TTL either.
        self.assertEqual(action.kind, "repair_check")
        self.assertEqual(action.key, "build")

    def test_plan_direct_repairs_conflict_resubmits_instead_of_blocking(self):
        ledger = self._ledger()
        key = "conflict:1"
        ledger.record("conflict-repair", 1, HEAD, key, epoch=NOW - 100)
        snapshot = pr(labels=frozenset({"admin-bypass"}), merge_state_status="DIRTY", mergeable="CONFLICTING")
        facts, _ = self._facts(m.StackGroup("s", (snapshot,)), ledger=ledger)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=True):
            action = p.plan_direct_repairs(facts, ledger, max_repair_attempts=3, now=NOW)
        self.assertEqual((action.kind, action.key), ("repair_conflict", key))

    def test_plan_bot_thread_repairs_resubmits_instead_of_blocking(self):
        ledger = self._ledger()
        ledger.record("repair-bot-thread", 10, HEAD, "PRRT_bot", epoch=NOW - 100)
        snapshot = pr(
            number=10,
            labels=frozenset({"admin-bypass"}),
            review_threads=(m.ReviewThread("PRRT_bot", False, ("coderabbitai[bot]",)),),
        )
        facts, _ = self._facts(m.StackGroup("s", (snapshot,)), ledger=ledger)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=True):
            action = p.plan_bot_thread_repairs(facts, ledger, max_repair_attempts=3, now=NOW)
        self.assertEqual((action.kind, action.key), ("repair_check", "bot_review_thread:PRRT_bot"))

    def test_mergify_failed_check_actions_resubmits_instead_of_blocking(self):
        ledger = self._ledger()
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        snapshot = pr(
            labels=frozenset({"admin-bypass"}),
            latest_mergify=event(state="dequeued", failing=("build",)),
        )
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=True):
            actions = p.mergify_failed_check_actions(snapshot, ledger, max_repair_attempts=3, now=NOW)
        self.assertEqual(len(actions), 1)
        self.assertEqual((actions[0].kind, actions[0].key), ("repair_check", "build"))

    def test_cap_still_applies_once_genuine_non_infra_attempts_reach_it(self):
        # Three genuinely-attempted (not infra-crashed) repairs plus one more
        # that crashed on infra: the cap must still fire on the three real
        # attempts, since only the infra-crashed one is excluded.
        ledger = self._ledger()
        for i, epoch in enumerate((NOW - 400, NOW - 300, NOW - 200)):
            ledger.record("repair-check", 1, HEAD, "build", epoch=epoch)
            ledger.record("repair-check-settled", 1, HEAD, "build", epoch=epoch + 1)
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        snapshot = pr(labels=frozenset({"admin-bypass"}), checks={"build": check("failure")})
        facts, _ = self._facts(m.StackGroup("s", (snapshot,)), ledger=ledger)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=True):
            action = p.plan_direct_repairs(facts, ledger, max_repair_attempts=3, now=NOW)
        self.assertEqual((action.kind, action.key), ("comment_blocked", "capped"))

    def test_real_infra_crash_does_not_block_a_genuinely_still_running_attempt(self):
        # Regression guard: repair_task_crashed_on_infra is only consulted
        # when the submission is not settled; if it returns False (a real
        # workflow genuinely still running, or one that failed for an
        # unrelated reason), normal repair_in_flight/TTL behavior must still
        # apply unchanged.
        ledger = self._ledger()
        ledger.record("repair-check", 1, HEAD, "build", epoch=NOW - 100)
        snapshot = pr(labels=frozenset({"admin-bypass"}), checks={"build": check("failure")})
        facts, _ = self._facts(m.StackGroup("s", (snapshot,)), ledger=ledger)
        with unittest.mock.patch.object(p, "repair_task_crashed_on_infra", return_value=False):
            action = p.plan_direct_repairs(facts, ledger, max_repair_attempts=3, now=NOW)
        self.assertIsNone(action)


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
            open_pr_numbers_by_head={},
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
            open_pr_numbers_by_head={},
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
            open_pr_numbers_by_head={},
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
            open_pr_numbers_by_head={},
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
            open_pr_numbers_by_head={},
        )
        self.assertEqual(
            [(action.kind, action.key) for action in retry.actions],
            [("repair_check", QUEUE_ONLY_CHECK)],
        )

    def test_repair_invalid_queue_failure_stops_retrying(self):
        ledger = self._ledger()
        ledger.record(
            "repair-invalid",
            5873,
            HEAD,
            "UI Vitest",
            1,
            meta={
                "errors": [
                    "merge-queue run failed outside the PR head: fix queue CI runner/tooling outside this PR and requeue."
                ],
            },
        )
        snapshot = pr(
            number=5873,
            labels=frozenset({"admin-bypass", "dequeued"}),
            checks={"build": check("success"), "UI Vitest": check("success", "UI Vitest")},
            latest_mergify=event(failing=("UI Vitest",)),
        )
        plan = p.plan_stack_execution(
            m.StackGroup("s", (snapshot,)),
            {"build"},
            ledger,
            now_epoch=0,
            open_pr_numbers={5873},
            open_pr_numbers_by_head={},
        )
        self.assertEqual(plan.actions, ())
        self.assertEqual(plan.wait_reason, "blocked-needs-human")
        blockers = plan.summary["prs"][0]["blockers"]
        self.assertEqual(blockers[0]["kind"], "human_decision")
        self.assertIn("outside the PR head", blockers[0]["detail"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
