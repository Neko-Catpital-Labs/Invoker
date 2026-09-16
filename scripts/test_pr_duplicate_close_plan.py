"""Behavioural tests for ``pr_duplicate_close_plan``.

Documentation-by-test for the pure policy layer: classification (landed) and
grouping (duplicate) are plain functions over already-fetched state, so these
tests construct that state directly and never shell out to `gh`/`git`.

Run:  python3 scripts/test_pr_duplicate_close_plan.py
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_model as m
import pr_duplicate_close_model as dm
import pr_duplicate_close_plan as p


def candidate(**kw):
    base = dict(
        number=1,
        title="t",
        url="u",
        state="OPEN",
        is_draft=False,
        head_ref_name="branch-1",
        base_ref_name="master",
        head_ref_oid="a" * 40,
    )
    base.update(kw)
    return dm.CandidatePr(**base)


def facts(**kw):
    base = dict(
        merge_base_sha="base" * 10,
        is_ancestor=False,
        is_empty_diff=False,
        all_commits_equivalent=False,
    )
    base.update(kw)
    return dm.GitFacts(**base)


class DuplicateCloseTestCase(unittest.TestCase):
    def _ledger(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(d, ignore_errors=True))
        return m.Ledger(Path(d) / "ledger.jsonl")


class ClassifyLanded(DuplicateCloseTestCase):
    def test_no_facts_is_not_landed(self):
        self.assertIsNone(p.classify_landed(candidate(), None))

    def test_no_signal_is_not_landed(self):
        self.assertIsNone(p.classify_landed(candidate(), facts()))

    def test_ancestor_signal_wins_priority(self):
        action = p.classify_landed(candidate(), facts(is_ancestor=True, is_empty_diff=True))
        self.assertEqual(action.kind, dm.CLOSE_LANDED)
        self.assertEqual(action.reason, dm.LANDED_ANCESTOR)

    def test_empty_diff_signal_alone(self):
        action = p.classify_landed(candidate(), facts(is_empty_diff=True))
        self.assertEqual(action.reason, dm.LANDED_EMPTY_DIFF)

    def test_patch_equivalent_signal_alone(self):
        action = p.classify_landed(candidate(), facts(all_commits_equivalent=True))
        self.assertEqual(action.reason, dm.LANDED_PATCH_EQUIVALENT)

    def test_rebase_equivalent_signal_alone(self):
        action = p.classify_landed(candidate(), facts(is_rebase_equivalent=True))
        self.assertEqual(action.reason, dm.LANDED_REBASE_EQUIVALENT)

    def test_landed_action_carries_expected_head(self):
        pr = candidate(number=42, head_ref_oid="deadbeef")
        action = p.classify_landed(pr, facts(is_ancestor=True))
        self.assertEqual(action.pr_number, 42)
        self.assertEqual(action.expected_head_oid, "deadbeef")
        self.assertIsNone(action.kept_pr_number)


class GroupDuplicates(unittest.TestCase):
    def test_two_prs_same_branch_keeps_newest(self):
        prs = [candidate(number=5, head_ref_name="stack/x"), candidate(number=9, head_ref_name="stack/x")]
        groups = p.group_duplicates(prs, {})
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].reason, dm.DUPLICATE_SAME_BRANCH)
        self.assertEqual(groups[0].kept_pr_number, 9)
        self.assertEqual(groups[0].closed_pr_numbers, (5,))

    def test_three_prs_same_branch_closes_all_but_newest(self):
        prs = [candidate(number=n, head_ref_name="stack/x") for n in (3, 7, 5)]
        groups = p.group_duplicates(prs, {})
        self.assertEqual(groups[0].kept_pr_number, 7)
        self.assertEqual(sorted(groups[0].closed_pr_numbers), [3, 5])

    def test_single_pr_on_a_branch_is_not_a_duplicate(self):
        prs = [candidate(number=1, head_ref_name="solo")]
        self.assertEqual(p.group_duplicates(prs, {}), ())

    def test_empty_head_ref_name_never_groups(self):
        prs = [candidate(number=1, head_ref_name=""), candidate(number=2, head_ref_name="")]
        self.assertEqual(p.group_duplicates(prs, {}), ())

    def test_same_patch_id_on_different_branches_groups(self):
        prs = [
            candidate(number=11, head_ref_name="a"),
            candidate(number=12, head_ref_name="b"),
        ]
        groups = p.group_duplicates(prs, {11: "pid-1", 12: "pid-1"})
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].reason, dm.DUPLICATE_SAME_DIFF)
        self.assertEqual(groups[0].kept_pr_number, 12)
        self.assertEqual(groups[0].closed_pr_numbers, (11,))

    def test_missing_patch_id_never_groups(self):
        prs = [candidate(number=1, head_ref_name="a"), candidate(number=2, head_ref_name="b")]
        self.assertEqual(p.group_duplicates(prs, {1: None, 2: None}), ())

    def test_branch_group_excludes_members_from_diff_grouping(self):
        # #1/#2 share a branch (grouped first); #2/#3 also share a patch-id,
        # but #2 is already covered by the branch group, so it can't also
        # anchor a diff group with #3 (that would double-close it).
        prs = [
            candidate(number=1, head_ref_name="stack/x"),
            candidate(number=2, head_ref_name="stack/x"),
            candidate(number=3, head_ref_name="stack/y"),
        ]
        groups = p.group_duplicates(prs, {2: "pid-1", 3: "pid-1"})
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].reason, dm.DUPLICATE_SAME_BRANCH)


class PlanCloseActions(DuplicateCloseTestCase):
    def test_landed_pr_is_closed_and_excluded_from_duplicate_grouping(self):
        # #1 and #2 share a branch (would normally duplicate-close #1), but #1
        # is also independently landed — it must be closed once, for the
        # landed reason, never counted as a duplicate too.
        prs = [
            candidate(number=1, head_ref_name="stack/x", head_ref_oid="h1"),
            candidate(number=2, head_ref_name="stack/x", head_ref_oid="h2"),
        ]
        facts_by_pr = {1: facts(is_ancestor=True)}
        actions = p.plan_close_actions(prs, facts_by_pr, {}, self._ledger())
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, dm.CLOSE_LANDED)
        self.assertEqual(actions[0].pr_number, 1)

    def test_draft_prs_are_never_planned(self):
        prs = [candidate(number=1, is_draft=True, head_ref_oid="h1")]
        actions = p.plan_close_actions(prs, {1: facts(is_ancestor=True)}, {}, self._ledger())
        self.assertEqual(actions, ())

    def test_closed_prs_are_never_planned(self):
        prs = [candidate(number=1, state="CLOSED", head_ref_oid="h1")]
        actions = p.plan_close_actions(prs, {1: facts(is_ancestor=True)}, {}, self._ledger())
        self.assertEqual(actions, ())

    def test_duplicate_group_produces_one_action_per_closed_pr(self):
        prs = [
            candidate(number=5, head_ref_name="stack/x", head_ref_oid="h5"),
            candidate(number=9, head_ref_name="stack/x", head_ref_oid="h9"),
        ]
        actions = p.plan_close_actions(prs, {}, {}, self._ledger())
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, dm.CLOSE_DUPLICATE)
        self.assertEqual(actions[0].pr_number, 5)
        self.assertEqual(actions[0].kept_pr_number, 9)

    def test_already_submitted_landed_action_is_not_replanned(self):
        prs = [candidate(number=1, head_ref_oid="h1")]
        ledger = self._ledger()
        ledger.record(dm.LEDGER_KIND_SUBMIT, 1, "h1", dm.ledger_key(dm.LANDED_ANCESTOR, None))
        actions = p.plan_close_actions(prs, {1: facts(is_ancestor=True)}, {}, ledger)
        self.assertEqual(actions, ())

    def test_already_submitted_duplicate_action_is_not_replanned(self):
        prs = [
            candidate(number=5, head_ref_name="stack/x", head_ref_oid="h5"),
            candidate(number=9, head_ref_name="stack/x", head_ref_oid="h9"),
        ]
        ledger = self._ledger()
        ledger.record(dm.LEDGER_KIND_SUBMIT, 5, "h5", dm.ledger_key(dm.DUPLICATE_SAME_BRANCH, 9))
        actions = p.plan_close_actions(prs, {}, {}, ledger)
        self.assertEqual(actions, ())

    def test_a_new_head_oid_gets_a_fresh_ledger_key_and_replans(self):
        # A different head_ref_oid means a genuinely new PR state (e.g. it was
        # pushed to again after an earlier submission for the old head) —
        # the ledger key is scoped by head_sha, so this must plan again.
        prs = [candidate(number=1, head_ref_oid="h1-new")]
        ledger = self._ledger()
        ledger.record(dm.LEDGER_KIND_SUBMIT, 1, "h1-old", dm.ledger_key(dm.LANDED_ANCESTOR, None))
        actions = p.plan_close_actions(prs, {1: facts(is_ancestor=True)}, {}, ledger)
        self.assertEqual(len(actions), 1)


class PlanFlagProbableDuplicates(DuplicateCloseTestCase):
    # Reproduces the #11153-vs-#10820 shape: an open PR whose title exactly
    # matches an already-merged PR's title, but the git-level content
    # genuinely conflicts (a modify/modify rename, not add/add) so none of
    # the safe landed/rebase-equivalent signals fire. is_rebase_equivalent
    # only ever handles add/add — this is the residual gap it leaves.

    def test_title_collision_with_conflict_is_flagged(self):
        pr = candidate(number=11153, title="No-Mergify observed CI repair (2) Repair failed observed checks", head_ref_oid="bfc6")
        actions = p.plan_flag_probable_duplicates(
            [pr], {11153: facts(has_conflict=True)},
            {"No-Mergify observed CI repair (2) Repair failed observed checks": 10820},
            self._ledger(),
        )
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0].kind, dm.FLAG_DUPLICATE)
        self.assertEqual(actions[0].pr_number, 11153)
        self.assertEqual(actions[0].kept_pr_number, 10820)
        self.assertEqual(actions[0].reason, dm.DUPLICATE_TITLE_COLLISION_MERGED)

    def test_no_title_collision_is_not_flagged(self):
        pr = candidate(number=1, title="Unrelated title", head_ref_oid="h1")
        actions = p.plan_flag_probable_duplicates(
            [pr], {1: facts(has_conflict=True)}, {"Something else": 999}, self._ledger(),
        )
        self.assertEqual(actions, ())

    def test_no_conflict_is_not_flagged(self):
        # A title collision with no actual git conflict isn't this signal's
        # job — could be a legitimate re-run of the same generated title.
        pr = candidate(number=1, title="dup title", head_ref_oid="h1")
        actions = p.plan_flag_probable_duplicates(
            [pr], {1: facts(has_conflict=False)}, {"dup title": 999}, self._ledger(),
        )
        self.assertEqual(actions, ())

    def test_already_caught_by_a_safe_signal_is_not_flagged(self):
        # is_rebase_equivalent (or any other safe signal) already closes this
        # via the normal landed path — flagging it too would be redundant.
        pr = candidate(number=1, title="dup title", head_ref_oid="h1")
        actions = p.plan_flag_probable_duplicates(
            [pr], {1: facts(has_conflict=True, is_rebase_equivalent=True)}, {"dup title": 999}, self._ledger(),
        )
        self.assertEqual(actions, ())

    def test_title_collision_with_itself_is_not_flagged(self):
        pr = candidate(number=999, title="dup title", head_ref_oid="h1")
        actions = p.plan_flag_probable_duplicates(
            [pr], {999: facts(has_conflict=True)}, {"dup title": 999}, self._ledger(),
        )
        self.assertEqual(actions, ())

    def test_already_flagged_is_not_replanned(self):
        pr = candidate(number=1, title="dup title", head_ref_oid="h1")
        ledger = self._ledger()
        ledger.record(dm.LEDGER_KIND_SUBMIT, 1, "h1", dm.ledger_key(dm.DUPLICATE_TITLE_COLLISION_MERGED, 999))
        actions = p.plan_flag_probable_duplicates(
            [pr], {1: facts(has_conflict=True)}, {"dup title": 999}, ledger,
        )
        self.assertEqual(actions, ())

    def test_draft_pr_is_not_flagged(self):
        pr = candidate(number=1, title="dup title", is_draft=True, head_ref_oid="h1")
        actions = p.plan_flag_probable_duplicates(
            [pr], {1: facts(has_conflict=True)}, {"dup title": 999}, self._ledger(),
        )
        self.assertEqual(actions, ())


if __name__ == "__main__":
    unittest.main()
