import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import scripts.mergify_admin_requeue as requeue
import scripts.mergify_admin_requeue_exec as exec_impl
import scripts.mergify_admin_requeue_headless_shell as headless_shell
import scripts.mergify_admin_requeue_workflow_fastpath as fastpath

from scripts.mergify_admin_requeue import (
    Action,
    Blocker,
    CheckContext,
    Ledger,
    MergifyQueueEvent,
    PrSnapshot,
    ReviewThread,
    StackGroup,
    classify_pr,
    group_stack_prs,
    REPO_ROOT,
    latest_contexts_by_required_check,
    load_mergify_rules,
    parse_mergify_queue_event,
    parse_stack_metadata,
    plan_stack_actions,
)
from scripts.mergify_admin_requeue_gh_executor import ADMIN_BYPASS_NUDGE_LEDGER_KIND, AdminBypassGhExecutor
from scripts.mergify_admin_requeue_model import LoadedStacks, RepairOutcome
from scripts.mergify_admin_requeue_loader import AdminBypassStackLoader
from scripts.mergify_admin_requeue_logger import AdminBypassLogger
from scripts.mergify_admin_requeue_repair_body import (
    NON_TRUNK_MANUAL_SPLIT_ERROR,
    PROOF_POLICY_LANE_ERROR,
    PROOF_TOOLING_POLICY_UNIT_ERROR,
)
from scripts.mergify_admin_requeue_repairer import AdminBypassRepairer
from scripts.pr_worker_safe_push import SafePushError

REQUIRED = {"PR Body", "quality / TypeScript Types"}
HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"
OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def check(name, state="success", sha=HEAD):
    return CheckContext(name, state, "https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2", sha, "2026-07-03T00:00:00Z")


def mergify(state="dequeued", comment_id="m1", sha=HEAD):
    return MergifyQueueEvent(comment_id, state, "admin-bypass", "2026-07-03T00:00:00Z", sha, (), (), "https://example.invalid/comment")


def pr(number, *, base="master", head=None, labels=None, checks=None, threads=(), latest=None, merge_state="CLEAN", mergeable="MERGEABLE", state="OPEN", draft=False, body=""):
    return PrSnapshot(
        number=number,
        title=f"PR {number}",
        body=body,
        url=f"https://github.com/Neko-Catpital-Labs/Invoker/pull/{number}",
        state=state,
        is_draft=draft,
        base_ref_name=base,
        head_ref_name=head or f"stack/{number}",
        head_ref_oid=HEAD,
        merge_state_status=merge_state,
        mergeable=mergeable,
        labels=frozenset(labels if labels is not None else {"admin-bypass", "dequeued"}),
        checks=checks if checks is not None else {name: check(name) for name in REQUIRED},
        review_threads=tuple(threads),
        latest_mergify=latest,
    )

PROOF_BODY = """## Summary

Worker proof slice.

## Review Claim

Show the failing proof-only slice.

## Review Lane

- proof

## Review Unit

- proof

## Safety Invariant

Proof-only body.

## Slice Rationale

Keep proof separate.

## Non-goals

- No product behavior change.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `pnpm test`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Data migration? No

</details>
"""


class MergifyAdminRequeueTests(unittest.TestCase):
    def ledger(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Ledger(Path(tmp.name) / "ledger.jsonl")

    def executor(self, gh, ledger, repo="owner/repo"):
        return AdminBypassGhExecutor(gh, ledger, AdminBypassLogger(), repo)

    def repairer(self, gh, ledger, repo="owner/repo"):
        logger = AdminBypassLogger()
        executor = AdminBypassGhExecutor(gh, ledger, logger, repo)
        return AdminBypassRepairer(gh, executor, logger, ledger, repo)

    def test_loads_admin_bypass_rule_from_mergify_yml(self):
        trunk, labels, required = load_mergify_rules(Path(".mergify.yml"))
        self.assertEqual(trunk, "master")
        self.assertIn("admin-bypass", labels)
        self.assertEqual(required, frozenset({
            "build-artifacts",
            "quality / Dependency Cruise",
            "PR Body",
            "quality / TypeScript Types",
            "required-fast / Guardrails",
            "required-fast / Submit Workflow Chain",
            "UI Vitest",
        }))

    def test_loads_admin_bypass_rule_from_any_working_directory(self):
        cwd = os.getcwd()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                os.chdir(tmp)
                trunk, labels, required = load_mergify_rules(REPO_ROOT / ".mergify.yml")
            finally:
                os.chdir(cwd)
        self.assertEqual(trunk, "master")
        self.assertIn("admin-bypass", labels)
        self.assertIn("PR Body", required)


    def test_latest_contexts_ignores_old_sha_and_mergify_self_checks(self):
        raw = [
            {"__typename": "CheckRun", "name": "PR Body", "conclusion": "FAILURE", "status": "COMPLETED", "detailsUrl": "old", "completedAt": "2026-07-02T00:00:00Z", "checkSuite": {"commit": {"oid": OLD}}},
            {"__typename": "CheckRun", "name": "PR Body", "conclusion": "SUCCESS", "status": "COMPLETED", "detailsUrl": "new", "completedAt": "2026-07-03T00:00:00Z", "checkSuite": {"commit": {"oid": HEAD}}},
            {"__typename": "CheckRun", "name": "Rule: autoqueue admin-bypass PRs to master", "conclusion": "FAILURE", "status": "COMPLETED", "detailsUrl": "bad", "completedAt": "2026-07-03T00:00:00Z", "checkSuite": {"commit": {"oid": HEAD}}},
        ]
        latest = latest_contexts_by_required_check(raw, HEAD, {"PR Body", "Rule: autoqueue admin-bypass PRs to master"})
        self.assertEqual(set(latest), {"PR Body"})
        self.assertEqual(latest["PR Body"].state, "success")
        self.assertEqual(latest["PR Body"].details_url, "new")

    def test_parses_latest_mergify_dequeued_event(self):
        comment = {
            "id": 123,
            "user": {"login": "mergify[bot]"},
            "updated_at": "2026-07-03T00:00:00Z",
            "html_url": "https://github.invalid/comment/123",
            "body": """
Left the queue `admin-bypass` at `c2532d229dbed2fd57419698c48d973001c78e9e`.
-*- Mergify Payload -*-
{"state":"dequeued","queue_rule_name":"admin-bypass"}

Waiting for
- PR Body

Failing checks
- quality / TypeScript Types
""",
        }
        event = parse_mergify_queue_event(comment)
        self.assertIsNotNone(event)
        self.assertEqual(event.state, "dequeued")
        self.assertEqual(event.queue_rule_name, "admin-bypass")
        self.assertEqual(event.failing_checks, ("quality / TypeScript Types",))
        self.assertEqual(event.waiting_for, ("PR Body",))
        self.assertEqual(event.head_sha, HEAD)

    def test_stack_metadata_orders_bottom_to_top(self):
        comments = [{"created_at": "2026-07-03T00:00:00Z", "body": '<!-- mergify-stack-data: {"stack_id":"s1","pull_numbers_bottom_to_top":[2604,2605,2601]} -->'}]
        self.assertEqual(parse_stack_metadata(comments), ("s1", (2604, 2605, 2601)))

    def test_whole_stack_requeues_only_current_bottom(self):
        stack = StackGroup("s", (pr(2604, head="stack/a", latest=mergify()), pr(2605, base="stack/a", head="stack/b"), pr(2601, base="stack/b")))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("requeue", 2604)])

    def test_labeled_upper_stack_member_allows_unlabeled_bottom_nudge(self):
        snapshots = [
            pr(2605, base="stack/a", head="stack/b", labels={"admin-bypass", "dequeued"}),
            pr(2604, head="stack/a", labels={"dequeued"}, latest=mergify()),
        ]
        meta = {2604: ("s", (2604, 2605)), 2605: ("s", (2604, 2605))}
        groups = group_stack_prs(snapshots, meta, "master")
        self.assertEqual([tuple(item.number for item in group.prs) for group in groups], [(2604, 2605)])
        actions = plan_stack_actions(groups[0], REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("comment_admin_bypass_nudge", 2604)])

    def test_upper_stack_blocker_does_not_stop_bottom_requeue(self):
        failed = {"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2604, head="stack/a", latest=mergify()), pr(2605, base="stack/a", checks=failed)))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("requeue", 2604)])
        thread_stack = StackGroup("s", (pr(2604, head="stack/a", latest=mergify()), pr(2605, base="stack/a", threads=(ReviewThread("t1", False, ("alice",)),))))
        actions = plan_stack_actions(thread_stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("requeue", 2604)])
    def test_unaccepted_upper_failed_check_repairs_upper_before_bottom(self):
        failed = {"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup(
            "s",
            (
                pr(2604, head="stack/a", latest=mergify()),
                pr(2605, base="stack/a", labels={"dequeued"}, checks=failed),
            ),
        )
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("repair_check", 2605, "PR Body")])

    def test_unaccepted_upper_without_blockers_posts_exact_blocker_instead_of_requeueing_bottom(self):
        stack = StackGroup(
            "s",
            (
                pr(2604, head="stack/a", latest=mergify()),
                pr(2605, base="stack/a", labels={"dequeued"}),
            ),
        )
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("comment_blocked", 2604, "upper-stack-needs-acceptance")])
        self.assertIn("#2605", actions[0].detail)
        self.assertIn("without `admin-bypass`", actions[0].detail)

    def test_missing_admin_bypass_label_on_current_bottom_nudges_human_first(self):
        stack = StackGroup("s", (pr(2604, labels={"dequeued"}, latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("comment_admin_bypass_nudge", 2604)])

    def test_dequeued_green_same_sha_requeues_once(self):
        stack = StackGroup("s", (pr(2605, latest=mergify(sha=HEAD)),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("requeue", 2605, "m1")])

    def test_requeue_same_dequeue_event_hits_cap(self):
        ledger = self.ledger()
        ledger.record("requeue", 2605, HEAD, "m1", 1)
        ledger.record("requeue", 2605, HEAD, "m1", 2)
        stack = StackGroup("s", (pr(2605, latest=mergify(comment_id="m1")),))
        actions = plan_stack_actions(stack, REQUIRED, ledger, 3)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("comment_blocked", 2605, "capped")])

    def test_failed_check_repairs_before_requeue(self):
        checks = {"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2606, checks=checks, latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("repair_check", 2606, "PR Body")])

    def test_failed_check_at_cap_gets_one_more_attempt_until_evaluated(self):
        checks = {"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2606, checks=checks, latest=mergify()),))
        ledger = self.ledger()
        for epoch in range(3):
            ledger.record("repair-check", 2606, HEAD, "PR Body", epoch)
        actions = plan_stack_actions(stack, REQUIRED, ledger, 4)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("repair_check", 2606, "PR Body")])
        ledger.record("repair-evaluated", 2606, HEAD, "PR Body", 4)
        actions = plan_stack_actions(stack, REQUIRED, ledger, 5)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("comment_blocked", 2606, "capped")])

    def test_pending_check_waits(self):
        checks = {"PR Body": check("PR Body", "pending"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2606, checks=checks, latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual(actions, ())

    def test_merge_hold_removed_only_when_sole_blocker(self):
        stack = StackGroup("s", (pr(2606, labels={"admin-bypass", "merge-hold", "dequeued"}, latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("remove_merge_hold", 2606)])
        checks = {"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2606, labels={"admin-bypass", "merge-hold", "dequeued"}, checks=checks, latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.key) for a in actions], [("repair_check", "PR Body")])

    def test_human_review_thread_blocks(self):
        stack = StackGroup("s", (pr(2607, threads=(ReviewThread("t1", False, ("alice",)),), latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.detail) for a in actions], [("comment_blocked", "unresolved human review thread t1")])

    def test_bot_thread_repairs_then_resolves(self):
        stack = StackGroup("s", (pr(2608, threads=(ReviewThread("tbot", False, ("coderabbitai[bot]",)),), latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.key) for a in actions], [("repair_check", "bot_review_thread:tbot")])
        ledger = self.ledger()
        ledger.record("repair-bot-thread", 2608, OLD, "tbot", 1)
        actions = plan_stack_actions(stack, REQUIRED, ledger, 2)
        self.assertEqual([(a.kind, a.key) for a in actions], [("resolve_bot_threads", "tbot")])

    def test_outdated_bot_thread_resolves_without_repair(self):
        stack = StackGroup("s", (pr(2608, threads=(ReviewThread("tbot", False, ("coderabbitai[bot]",), True),), latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.key) for a in actions], [("resolve_bot_threads", "tbot")])

    def test_conflict_uses_claude_repair_cap(self):
        stack = StackGroup("s", (pr(2609, merge_state="DIRTY", latest=mergify()),))
        ledger = self.ledger()
        actions = plan_stack_actions(stack, REQUIRED, ledger, 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("repair_conflict", 2609)])
        for epoch in range(3):
            ledger.record("conflict-repair", 2609, HEAD, "conflict:2609", epoch)
        actions = plan_stack_actions(stack, REQUIRED, ledger, 4)
        self.assertEqual([(a.kind, a.key) for a in actions], [("comment_blocked", "capped")])

    def test_conflict_repair_records_and_caps_without_invoker(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        ledger = self.ledger()
        item = pr(2647, merge_state="DIRTY", latest=mergify())
        prompts = []
        repairer = self.repairer(FakeGh(), ledger, "Neko-Catpital-Labs/Invoker")
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head"):
            with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", return_value=HEAD):
                with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                    with mock.patch.object(repairer, "run_claude_repair", side_effect=lambda _work_root, prompt: prompts.append(prompt)):
                        for epoch in range(3):
                            repairer.repair_conflict(item, "GitHub reports merge conflict", epoch)
        self.assertEqual(ledger.count("conflict-repair", 2647, HEAD, "conflict:2647"), 3)
        self.assertEqual(len(prompts), 3)
        self.assertIn("commit locally. Do not push.", prompts[0])
        actions = plan_stack_actions(StackGroup("s", (item,)), REQUIRED, ledger, 4)
        self.assertEqual([(a.kind, a.key) for a in actions], [("comment_blocked", "capped")])

    def test_repair_conflict_pushes_on_successful_resolution(self):
        item = pr(2660, merge_state="DIRTY", latest=mergify())
        ledger = self.ledger()
        repairer = self.repairer(object(), ledger)
        new_head = "b" * 40
        rev_parse = iter([HEAD, new_head])
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head"):
            with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", side_effect=lambda _work_root, *args: next(rev_parse) if args == ("rev-parse", "HEAD") else ""):
                with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                    with mock.patch.object(repairer, "run_claude_repair"):
                        with mock.patch.object(repairer, "push_branch", return_value=new_head) as push_branch:
                            result = repairer.repair_conflict(item, "GitHub reports merge conflict", 1)
        self.assertEqual(result.status, "pushed")
        self.assertEqual(result.start_head, HEAD)
        self.assertEqual(result.end_head, new_head)
        push_branch.assert_called_once_with(mock.ANY, item.head_ref_name, expected_head=item.head_ref_oid)
        self.assertEqual(ledger.count("conflict-repair", item.number, item.head_ref_oid, f"conflict:{item.number}"), 1)

    def test_repair_conflict_returns_stale_head_without_raising(self):
        item = pr(2661, merge_state="DIRTY", latest=mergify())
        ledger = self.ledger()
        repairer = self.repairer(object(), ledger)
        new_head = "c" * 40
        rev_parse = iter([HEAD, new_head])
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head"):
            with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", side_effect=lambda _work_root, *args: next(rev_parse) if args == ("rev-parse", "HEAD") else ""):
                with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                    with mock.patch.object(repairer, "run_claude_repair"):
                        with mock.patch.object(repairer, "push_branch", side_effect=SafePushError("stale-head: refs/heads/x is deadbeef; expected " + HEAD)):
                            result = repairer.repair_conflict(item, "GitHub reports merge conflict", 1)
        self.assertEqual(result.status, "stale_head")
        self.assertIn("stale-head", result.errors[0])
        self.assertEqual(ledger.count("conflict-repair", item.number, item.head_ref_oid, f"conflict:{item.number}"), 1)

    def test_repair_check_ledger_row_written_before_run_claude_repair_raises(self):
        item = pr(2662, latest=mergify())
        ledger = self.ledger()
        repairer = self.repairer(object(), ledger)
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head"):
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/pr-body.log"):
                with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", return_value=HEAD):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                        with mock.patch.object(repairer, "run_claude_repair", side_effect=subprocess.CalledProcessError(1, ["claude"])):
                            with self.assertRaises(subprocess.CalledProcessError):
                                repairer.repair_check(item, "PR Body", 1)
        self.assertEqual(ledger.count("repair-check", item.number, item.head_ref_oid, "PR Body"), 1)

    def test_claude_repair_uses_claude_cli(self):
        repairer = self.repairer(object(), self.ledger())
        with mock.patch("scripts.mergify_admin_requeue_repairer.subprocess.run") as run:
            repairer.run_claude_repair(Path("/tmp/work"), "repair this")
        run.assert_called_once_with(
            ["claude", "-p", "repair this", "--dangerously-skip-permissions"],
            cwd="/tmp/work",
            check=True,
            text=True,
        )

    def test_candidate_stack_includes_unlabeled_upper_prs(self):
        def raw(number, base, head, labels):
            return {
                "number": number,
                "title": f"PR {number}",
                "body": "",
                "url": f"https://example.invalid/{number}",
                "state": "OPEN",
                "isDraft": False,
                "baseRefName": base,
                "headRefName": head,
                "headRefOid": HEAD,
                "mergeStateStatus": "CLEAN",
                "mergeable": "MERGEABLE",
                "labels": {"nodes": [{"name": label} for label in labels]},
                "reviewThreads": {"pageInfo": {"hasNextPage": False}, "nodes": []},
                "statusCheckRollup": {"contexts": {"nodes": []}},
            }

        bottom = raw(1, "master", "stack/one", {"admin-bypass"})
        upper = raw(2, "stack/one", "stack/two", set())

        class FakeGh:
            def list_candidate_prs(self, repo, author, pr_numbers):
                return [bottom]

            def list_open_prs(self, repo):
                return [bottom, upper]

            def issue_comments(self, repo, number):
                return []

        loaded = AdminBypassStackLoader(FakeGh()).load("owner/repo", None, [], REQUIRED, "master")
        self.assertEqual(len(loaded.stacks), 1)
        self.assertEqual([item.number for item in loaded.stacks[0].prs], [1, 2])

    def test_repair_check_logs_work_context(self):
        stderr = io.StringIO()
        item = pr(2647, latest=mergify())
        repairer = self.repairer(object(), self.ledger())
        git_rev_parse = iter([HEAD, HEAD])
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head") as checkout:
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/pr-body.log"):
                with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", side_effect=lambda _work_root, *args: next(git_rev_parse) if args == ("rev-parse", "HEAD") else ""):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                        with mock.patch.object(repairer, "run_claude_repair") as repair:
                            with mock.patch("scripts.mergify_admin_requeue_repairer.validate_current_pr_body", return_value={"valid": True, "errors": []}):
                                with redirect_stderr(stderr):
                                    result = repairer.repair_check(item, "PR Body")
        checkout.assert_called_once()
        repair.assert_called_once()
        self.assertEqual(result.status, "noop")
        self.assertIn("Commit locally if needed, do not push.", repair.call_args.args[1])
        log = stderr.getvalue()
        self.assertIn('"event": "admin-bypass-repair-check-start"', log)
        self.assertIn('"check_name": "PR Body"', log)
        self.assertIn('"log_path": "/tmp/pr-body.log"', log)
        self.assertIn('"pr_number": 2647', log)


    def test_repair_check_noop_invalid_non_trunk_blocks_human_split(self):
        item = pr(
            5803,
            base="stack/base",
            body="## Summary\n\nMixed slice.\n",
            checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")},
        )
        repairer = self.repairer(object(), self.ledger())
        git_rev_parse = iter([HEAD, HEAD])
        validation = {
            "valid": False,
            "errors": [
                "PR body mentions multiple review units (validation-policy, routing); split into one conceptual unit per diff/task.",
                "Review lane behavior cannot ship with policy, proof files in the same PR. Split behavior or cleanup from docs, policy, repro, and benchmark slices.",
                'PR body Review Unit \"routing\" cannot ship with tooling-policy, proof files in the same PR. Split this into one Review Unit per PR.',
            ],
            "reviewLane": "behavior",
            "reviewUnit": "routing",
            "reviewUnits": ["routing", "tooling-policy", "proof"],
            "scopeKinds": ["product", "policy"],
        }
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head"):
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/pr-body.log"):
                with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", side_effect=lambda _work_root, *args: next(git_rev_parse) if args == ("rev-parse", "HEAD") else ""):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                        with mock.patch.object(repairer, "run_claude_repair"):
                            with mock.patch("scripts.mergify_admin_requeue_repairer.validate_current_pr_body", return_value=validation):
                                result = repairer.repair_check(item, "PR Body")
        self.assertEqual(result.status, "blocked_invalid")
        self.assertIn(NON_TRUNK_MANUAL_SPLIT_ERROR, result.errors)

    def test_plan_stack_actions_stop_retrying_after_repair_invalid(self):
        ledger = self.ledger()
        ledger.record("repair-invalid", 2606, HEAD, "PR Body", 1, meta={"errors": ["human stack split required"]})
        stack = StackGroup("s", (pr(2606, labels={"admin-bypass"}, checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}),))
        actions = plan_stack_actions(stack, REQUIRED, ledger, 2)
        self.assertEqual(actions, ())
    def test_queue_only_repair_uses_mergify_job_log_and_returns_noop(self):
        stderr = io.StringIO()
        latest = MergifyQueueEvent(
            "m5811",
            "dequeued",
            "admin-bypass",
            "2026-07-03T06:13:00Z",
            HEAD,
            (),
            ("required-fast / Guardrails",),
            "https://github.com/Neko-Catpital-Labs/Invoker/pull/5811#issuecomment-1",
            5854,
            (("required-fast / Guardrails", ("https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",)),),
        )
        item = pr(5811, labels={"admin-bypass", "dequeued"}, checks={}, latest=latest)
        repairer = self.repairer(object(), self.ledger())
        git_rev_parse = iter([HEAD, HEAD])
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head") as checkout:
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/guardrails.log"):
                with mock.patch.object(repairer, "job_log_has_evidence", return_value=True):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", side_effect=lambda _work_root, *args: next(git_rev_parse) if args == ("rev-parse", "HEAD") else ""):
                        with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", return_value=()):
                            with mock.patch.object(repairer, "run_claude_repair") as repair:
                                with redirect_stderr(stderr):
                                    result = repairer.repair_check(item, "required-fast / Guardrails")
        checkout.assert_called_once()
        repair.assert_called_once()
        self.assertEqual(result.status, "queue_only_noop")
        self.assertIn("Queue draft PR: #5854", repair.call_args.args[1])
        self.assertIn("Job log path: /tmp/guardrails.log", repair.call_args.args[1])

    def test_queue_only_repair_empty_job_log_returns_noop_without_claude(self):
        latest = MergifyQueueEvent(
            "m5811",
            "dequeued",
            "admin-bypass",
            "2026-07-03T06:13:00Z",
            HEAD,
            (),
            ("required-fast / Guardrails",),
            "https://github.com/Neko-Catpital-Labs/Invoker/pull/5811#issuecomment-1",
            5854,
            (("required-fast / Guardrails", ("https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",)),),
        )
        item = pr(5811, labels={"dequeued"}, checks={}, latest=latest)
        repairer = self.repairer(object(), self.ledger())
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head") as checkout:
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/guardrails.log"):
                with mock.patch.object(repairer, "job_log_has_evidence", return_value=False):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", return_value=HEAD):
                        with mock.patch.object(repairer, "run_claude_repair") as repair:
                            result = repairer.repair_check(item, "required-fast / Guardrails")
        checkout.assert_called_once()
        repair.assert_not_called()
        self.assertEqual(result.status, "queue_only_noop")

    def test_pr_body_valid_local_repair_returns_noop_without_claude(self):
        item = pr(5810, checks={"PR Body": check("PR Body", "failure")}, body=PROOF_BODY)
        repairer = self.repairer(object(), self.ledger())
        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head") as checkout:
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/pr-body.log") as download:
                with mock.patch.object(repairer, "job_log_is_empty", return_value=True):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", return_value=HEAD):
                        with mock.patch("scripts.mergify_admin_requeue_repairer.validate_current_pr_body", return_value={"valid": True}):
                            with mock.patch.object(repairer, "run_claude_repair") as repair:
                                result = repairer.repair_check(item, "PR Body")
        checkout.assert_called_once()
        download.assert_called_once()
        repair.assert_not_called()
        self.assertEqual(result.status, "noop")
    def test_run_cycle_logs_selected_bottom_repair_context(self):
        args = requeue.parse_args(["--once", "--dry-run", "--repo", "owner/repo", "--state-file", str(self.ledger().path)])
        stack = StackGroup("s", (pr(2606, checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}, latest=mergify()),))
        stderr = io.StringIO()
        stdout = io.StringIO()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=object()):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(stack,), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(args)
        self.assertFalse(should_poll)
        log = stderr.getvalue()
        self.assertIn('"event": "admin-bypass-stack"', log)
        self.assertIn('"event": "admin-bypass-stack-actions"', log)
        self.assertIn('"kind": "repair_check"', log)
        self.assertIn('"failed_check"', log)
        self.assertIn('"pr_number": 2606', log)

    def test_run_cycle_blocks_once_for_unaccepted_upper_stack(self):
        args = requeue.parse_args(["--once", "--dry-run", "--repo", "owner/repo", "--state-file", str(self.ledger().path)])
        stack = StackGroup("s", (pr(2604, head="stack/a", latest=mergify()), pr(2605, base="stack/a", labels={"dequeued"})))
        stderr = io.StringIO()
        stdout = io.StringIO()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=object()):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(stack,), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(args)
        self.assertFalse(should_poll)
        self.assertIn(
            "BLOCK PR #2604 PR #2604 is ready to land, but upper stack PR(s) #2605 are open without `admin-bypass`",
            stdout.getvalue(),
        )
        log = stderr.getvalue()
        self.assertIn('"event": "admin-bypass-stack-actions"', log)
        self.assertIn('"kind": "comment_blocked"', log)
        self.assertIn('"key": "upper-stack-needs-acceptance"', log)
        self.assertIn('"upper_stack_needs_acceptance": true', log)

    def test_run_cycle_repairs_only_lower_pr_when_upper_has_no_own_blocker(self):
        # Regression coverage for #6536/#6579: a clean-looking upper PR must
        # never be touched while its base (the lower PR) is still unconverged.
        args = requeue.parse_args(["--once", "--repo", "owner/repo", "--state-file", str(self.ledger().path)])
        lower = pr(6536, head="stack/lower", checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}, latest=mergify())
        upper = pr(6579, base="stack/lower", head="stack/upper")
        stack = StackGroup("s", (lower, upper))
        outcome = RepairOutcome(status="noop", check_name="PR Body", start_head=HEAD, end_head=HEAD)
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=object()):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(stack,), open_pr_numbers_by_head={})):
                    with mock.patch.object(exec_impl, "resolve_workflow_for_pr", return_value=None):
                        with mock.patch.object(AdminBypassRepairer, "repair_check", return_value=outcome) as repair_check:
                            exec_impl.run_cycle(args)
        self.assertEqual(repair_check.call_count, 1)
        called_prs = [call.args[0].number for call in repair_check.call_args_list]
        self.assertEqual(called_prs, [6536])
        self.assertNotIn(6579, called_prs)

    def test_run_cycle_prefers_fast_path_workflow_mutation_over_repairer(self):
        args = requeue.parse_args(["--once", "--repo", "owner/repo", "--state-file", str(self.ledger().path)])
        stack = StackGroup("s", (pr(2670, checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}, latest=mergify()),))
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=object()):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(stack,), open_pr_numbers_by_head={})):
                    with mock.patch.object(exec_impl, "resolve_workflow_for_pr", return_value="wf-1-1") as resolve:
                        with mock.patch.object(exec_impl, "submit_repair_review_gate_ci") as submit:
                            with mock.patch.object(AdminBypassRepairer, "repair_check") as repair_check:
                                should_poll = exec_impl.run_cycle(args)
        self.assertTrue(resolve.called)
        submit.assert_called_once_with(2670)
        repair_check.assert_not_called()
        self.assertTrue(should_poll)

    def test_run_cycle_repairer_exception_does_not_abort_other_stacks(self):
        ledger = self.ledger()
        args = requeue.parse_args(["--once", "--repo", "owner/repo", "--state-file", str(ledger.path)])
        broken = pr(6601, checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}, latest=mergify())
        healthy = pr(6602, latest=None)
        stacks = (StackGroup("s1", (broken,)), StackGroup("s2", (healthy,)))

        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        fake_gh = FakeGh()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=fake_gh):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=stacks, open_pr_numbers_by_head={})):
                    with mock.patch.object(exec_impl, "resolve_workflow_for_pr", return_value=None):
                        with mock.patch.object(AdminBypassRepairer, "repair_check", side_effect=subprocess.CalledProcessError(1, ["claude"])) as repair_check:
                            should_poll = exec_impl.run_cycle(args)
        self.assertEqual(repair_check.call_count, 1)
        self.assertEqual(fake_gh.comments, [("owner/repo", 6602, "@mergifyio queue")])
        self.assertTrue(should_poll)

    def test_repair_check_splits_tooling_policy_prerequisite(self):
        class FakeGh:
            def __init__(self):
                self.created = []
                self.label_edits = []
                self.comments = []

            def create_pr(self, repo, title, body, head, base):
                self.created.append((repo, title, body, head, base))
                return {"number": 5801}

            def edit_label(self, repo, pr_number, *, add=None, remove=None):
                self.label_edits.append((repo, pr_number, add, remove))

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        item = pr(
            5800,
            latest=mergify(),
            body=PROOF_BODY,
            checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")},
        )
        ledger = self.ledger()
        fake = FakeGh()
        repairer = self.repairer(fake, ledger)
        rev_parse = iter([HEAD, "b" * 40])
        git_commands = []

        def fake_git_output(_work_root, *args):
            git_commands.append(args)
            if args == ("rev-parse", "HEAD"):
                return next(rev_parse)
            return ""

        def fake_git_lines(_work_root, *args):
            if args == ("status", "--porcelain"):
                return ()
            if args == ("rev-list", "--reverse", f"{HEAD}..{'b' * 40}"):
                return ("commit-a",)
            return ()

        validator_results = iter([
            {
                "valid": False,
                "errors": [
                    PROOF_POLICY_LANE_ERROR,
                    PROOF_TOOLING_POLICY_UNIT_ERROR,
                ],
                "reviewLane": "proof",
                "reviewUnit": "proof",
                "reviewUnits": ["tooling-policy"],
                "scopeKinds": ["policy"],
            },
            {
                "valid": True,
                "errors": [],
                "reviewLane": "policy",
                "reviewUnit": "tooling-policy",
                "reviewUnits": ["tooling-policy"],
                "scopeKinds": ["policy"],
            },
        ])

        with mock.patch("scripts.mergify_admin_requeue_repairer.checkout_pr_head"):
            with mock.patch.object(repairer.executor, "download_job_log", return_value="/tmp/pr-body.log"):
                with mock.patch.object(repairer, "run_claude_repair"):
                    with mock.patch("scripts.mergify_admin_requeue_repairer.git_output", side_effect=fake_git_output):
                        with mock.patch("scripts.mergify_admin_requeue_repairer.git_lines", side_effect=fake_git_lines):
                            with mock.patch("scripts.mergify_admin_requeue_repair_body.git_output", side_effect=fake_git_output):
                                with mock.patch("scripts.mergify_admin_requeue_repair_body.validate_local_pr_body", side_effect=lambda *_args: next(validator_results)):
                                    with mock.patch("scripts.mergify_admin_requeue_repair_body.safe_push", return_value="pushed-sha") as safe_push_mock:
                                        result = repairer.repair_check(item, "PR Body", 123)

        self.assertEqual(result.status, "prereq_created")
        safe_push_mock.assert_called_once_with(branch="stack/pr-babysit-prereq-5800-c2532d2", expect_missing=True, cwd=mock.ANY)
        self.assertEqual(fake.created[0][0], "owner/repo")
        self.assertIn("[PR babysit] Tooling-policy repair prerequisite for #5800: PR Body", fake.created[0][1])
        self.assertEqual(fake.label_edits, [("owner/repo", 5801, "admin-bypass", None)])
        latest = ledger.latest("repair-prereq-created", 5800, HEAD, "PR Body")
        self.assertIsNotNone(latest)
        self.assertEqual(latest["meta"]["prNumber"], 5801)
        self.assertIn(("checkout", "-B", "stack/pr-babysit-prereq-5800-c2532d2", "origin/master"), git_commands)
        self.assertIn(("checkout", "-B", item.head_ref_name, HEAD), git_commands)
        self.assertIn(("reset", "--hard", HEAD), git_commands)
        self.assertEqual(fake.comments, [])

    def test_run_cycle_waits_while_prerequisite_pr_is_open(self):
        ledger = self.ledger()
        args = requeue.parse_args(["--once", "--dry-run", "--repo", "owner/repo", "--state-file", str(ledger.path)])
        ledger.record("repair-prereq-created", 2604, HEAD, "PR Body", 1, meta={"prNumber": 2999, "branch": "stack/pr-babysit-prereq-2604-c2532d2"})
        original = StackGroup("orig", (pr(2604, latest=mergify(), checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}),))
        prereq = StackGroup("prereq", (pr(2999, latest=mergify(state="queued")),))
        stderr = io.StringIO()
        stdout = io.StringIO()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=object()):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(original, prereq), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(args)
        self.assertTrue(should_poll)
        self.assertNotIn("repair-check PR #2604", stdout.getvalue())
        log = stderr.getvalue()
        self.assertIn('"event": "admin-bypass-repair-prereq-wait"', log)
        self.assertIn('"reason": "repair-prereq-open"', log)

    def test_run_cycle_requeues_once_after_prerequisite_pr_closes(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        ledger = self.ledger()
        ledger.record("repair-prereq-created", 2604, HEAD, "PR Body", 1, meta={"prNumber": 2999, "branch": "stack/pr-babysit-prereq-2604-c2532d2"})
        stack = StackGroup("orig", (pr(2604, latest=mergify(), checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}),))
        stderr = io.StringIO()
        stdout = io.StringIO()
        fake_gh = FakeGh()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=fake_gh):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(stack,), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(requeue.parse_args(["--once", "--repo", "owner/repo", "--state-file", str(ledger.path)]))
        self.assertTrue(should_poll)
        self.assertIn(("owner/repo", 2604, "@mergifyio queue"), fake_gh.comments)
        refreshed = Ledger(ledger.path)
        self.assertEqual(refreshed.count("repair-prereq-requeue", 2604, HEAD, "PR Body"), 1)
        self.assertIn("requeue PR #2604", stdout.getvalue())
        self.assertIn("eligible-after-dequeue", stdout.getvalue())

    def test_run_cycle_restores_label_then_requeues_after_queue_only_noop(self):
        class FakeGh:
            def __init__(self):
                self.comments = []
                self.label_edits = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

            def edit_label(self, repo, pr_number, *, add=None, remove=None):
                self.label_edits.append((repo, pr_number, add, remove))

        ledger = self.ledger()
        ledger.record("queue-only-noop", 5811, HEAD, "required-fast / Guardrails", 1)
        latest = MergifyQueueEvent(
            "m5811",
            "dequeued",
            "admin-bypass",
            "2026-07-03T06:13:00Z",
            HEAD,
            (),
            ("required-fast / Guardrails",),
            "https://github.com/Neko-Catpital-Labs/Invoker/pull/5811#issuecomment-1",
            5854,
            (("required-fast / Guardrails", ("https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2",)),),
        )
        fake_gh = FakeGh()
        stderr = io.StringIO()
        stdout = io.StringIO()
        first_stack = StackGroup("orig", (pr(5811, labels={"dequeued"}, checks={}, latest=latest),))
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), {"required-fast / Guardrails"})):
            with mock.patch.object(exec_impl, "GhClient", return_value=fake_gh):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(first_stack,), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(requeue.parse_args(["--once", "--repo", "owner/repo", "--state-file", str(ledger.path)]))
        self.assertTrue(should_poll)
        self.assertEqual(fake_gh.label_edits, [("owner/repo", 5811, "admin-bypass", None)])
        self.assertNotIn("BLOCK PR #5811 missing-check", stdout.getvalue())

        second_stack = StackGroup("orig", (pr(5811, labels={"admin-bypass", "dequeued"}, checks={}, latest=latest),))
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), {"required-fast / Guardrails"})):
            with mock.patch.object(exec_impl, "GhClient", return_value=fake_gh):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(second_stack,), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(requeue.parse_args(["--once", "--repo", "owner/repo", "--state-file", str(ledger.path)]))
        self.assertTrue(should_poll)
        self.assertIn(("owner/repo", 5811, "@mergifyio queue"), fake_gh.comments)
        refreshed = Ledger(ledger.path)
        self.assertEqual(refreshed.count("queue-only-requeue", 5811, HEAD, "required-fast / Guardrails"), 1)

    def test_run_cycle_stops_suppressing_after_prereq_requeue(self):
        ledger = self.ledger()
        args = requeue.parse_args(["--once", "--dry-run", "--repo", "owner/repo", "--state-file", str(ledger.path)])
        ledger.record("repair-prereq-created", 2604, HEAD, "PR Body", 1, meta={"prNumber": 2999, "branch": "stack/pr-babysit-prereq-2604-c2532d2"})
        ledger.record("repair-prereq-requeue", 2604, HEAD, "PR Body", 2)
        stack = StackGroup("orig", (pr(2604, latest=mergify(), checks={"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}),))
        stderr = io.StringIO()
        stdout = io.StringIO()
        with mock.patch.object(exec_impl, "load_mergify_rules", return_value=("master", frozenset({"admin-bypass"}), REQUIRED)):
            with mock.patch.object(exec_impl, "GhClient", return_value=object()):
                with mock.patch.object(AdminBypassStackLoader, "load", return_value=LoadedStacks(stacks=(stack,), open_pr_numbers_by_head={})):
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        should_poll = exec_impl.run_cycle(args)
        self.assertFalse(should_poll)
        self.assertIn('DRY-RUN repair-check PR #2604 check="PR Body"', stdout.getvalue())
        self.assertNotIn("requeue PR #2604", stdout.getvalue())

    def test_loop_rescans_after_action_then_stops(self):
        args = requeue.parse_args(["--loop", "--poll-seconds", "0"])
        with mock.patch.object(exec_impl, "run_cycle", side_effect=[True, False]) as cycle:
            with mock.patch.object(exec_impl.time, "sleep") as sleep:
                self.assertEqual(requeue.run_loop(args), 0)
        self.assertEqual(cycle.call_count, 2)
        sleep.assert_called_once_with(0.0)

    def test_capped_comment_records_once(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        ledger = self.ledger()
        item = pr(2647, merge_state="DIRTY", latest=mergify())
        action = Action("comment_blocked", 2647, "capped", "GitHub reports merge conflict. The retry cap was reached for current head " + HEAD + ".")
        fake = FakeGh()
        executor = self.executor(fake, ledger, "Neko-Catpital-Labs/Invoker")
        executor.execute(action, item, 1)
        executor.execute(action, item, 2)
        self.assertEqual(len(fake.comments), 1)

    def test_retarget_base_executes_once_and_records_ledger(self):
        class FakeGh:
            def __init__(self):
                self.retargets = []

            def retarget_base(self, repo, pr_number, base):
                self.retargets.append((repo, pr_number, base))

        ledger = self.ledger()
        item = pr(5811, base="pr/babysit-prereq-split", labels={"admin-bypass"}, latest=mergify())
        action = Action("retarget_base", 5811, "master", "retarget stack root from `pr/babysit-prereq-split` to `master`")
        fake = FakeGh()
        executor = self.executor(fake, ledger, "owner/repo")
        executor.execute(action, item, 1)
        self.assertEqual(fake.retargets, [("owner/repo", 5811, "master")])
        self.assertEqual(ledger.count("retarget-base", 5811, HEAD, "pr/babysit-prereq-split->master"), 1)

    def test_human_blocker_comment_records_once(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

            def issue_comments(self, repo, pr_number):
                return [{"body": body} for _repo, _pr_number, body in self.comments]

        ledger = self.ledger()
        item = pr(2647)
        action = Action("comment_blocked", 2647, "no-current-bottom", "no current bottom on master: lowest open stack PR #2647 is based on `feature/base`, not `master`; land or retarget that base before babysitting can queue this stack")
        fake = FakeGh()
        executor = self.executor(fake, ledger, "Neko-Catpital-Labs/Invoker")
        executor.execute(action, item, 1)
        executor.execute(action, item, 2)
        self.assertEqual(len(fake.comments), 1)
        self.assertIn("lowest open stack PR #2647", fake.comments[0][2])
        self.assertEqual(ledger.count("comment-blocked", 2647, HEAD, "no-current-bottom"), 1)

    def test_no_current_bottom_upgrades_legacy_generic_comment_once(self):
        class FakeGh:
            def __init__(self):
                self.comments = [{
                    "body": "Mergify repair stopped: no current bottom on master",
                }]

            def comment(self, repo, pr_number, body):
                self.comments.append({"body": body})

            def issue_comments(self, repo, pr_number):
                return list(self.comments)

        ledger = self.ledger()
        ledger.record("comment-blocked", 2647, HEAD, "no-current-bottom", 1)
        item = pr(2647)
        detail = "no current bottom on master: lowest open stack PR #2647 is based on `feature/base`, not `master`; land or retarget that base before babysitting can queue this stack"
        action = Action("comment_blocked", 2647, "no-current-bottom", detail)
        fake = FakeGh()
        executor = self.executor(fake, ledger, "Neko-Catpital-Labs/Invoker")
        executor.execute(action, item, 2)
        executor.execute(action, item, 3)
        self.assertEqual([comment["body"] for comment in fake.comments].count(f"Mergify repair stopped: {detail}"), 1)
        self.assertEqual(ledger.count("comment-blocked", 2647, HEAD, "no-current-bottom:exact"), 1)

    def test_human_block_comment_records_once_then_waits(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        ledger = self.ledger()
        item = pr(5885, threads=(ReviewThread("PRRT_kwDOSFkSDM6T5EJA", False, ("reviewer",)),), latest=mergify())
        stack = StackGroup("s", (item,))
        actions = plan_stack_actions(stack, REQUIRED, ledger, 1)
        self.assertEqual(
            [(a.kind, a.key, a.detail) for a in actions],
            [("comment_blocked", "PRRT_kwDOSFkSDM6T5EJA", "unresolved human review thread PRRT_kwDOSFkSDM6T5EJA")],
        )
        fake = FakeGh()
        executor = self.executor(fake, ledger, "Neko-Catpital-Labs/Invoker")
        executor.execute(actions[0], item, 1)
        executor.execute(actions[0], item, 2)
        self.assertEqual(len(fake.comments), 1)
        self.assertIn("unresolved human review thread PRRT_kwDOSFkSDM6T5EJA", fake.comments[0][2])
        self.assertEqual(ledger.count("comment-blocked", 5885, HEAD, "PRRT_kwDOSFkSDM6T5EJA"), 1)
        self.assertEqual(plan_stack_actions(stack, REQUIRED, ledger, 3), ())

    def test_missing_admin_bypass_nudge_comments_once_without_label_edit(self):
        class FakeGh:
            def __init__(self):
                self.comments = []
                self.label_edits = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

            def edit_label(self, repo, pr_number, *, add=None, remove=None):
                self.label_edits.append((repo, pr_number, add, remove))

        action = Action("comment_admin_bypass_nudge", 2647, "admin-bypass", "missing admin-bypass label")
        ledger = self.ledger()
        item = pr(2647, labels={"dequeued"}, latest=mergify())
        fake = FakeGh()
        executor = self.executor(fake, ledger, "Neko-Catpital-Labs/Invoker")
        executor.execute(action, item, 1)
        executor.execute(action, item, 2)
        self.assertEqual(len(fake.comments), 1)
        self.assertIn("tag this PR with `admin-bypass`", fake.comments[0][2])
        self.assertEqual(fake.label_edits, [])
        self.assertEqual(ledger.count(ADMIN_BYPASS_NUDGE_LEDGER_KIND, 2647, HEAD, "admin-bypass"), 1)

    def test_stale_direct_mutation_skips_comment_and_ledger(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def pr_detail(self, repo, number):
                return {"number": number, "state": "OPEN", "headRefOid": OLD}

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

            def issue_comments(self, repo, pr_number):
                return []

        action = Action("comment_blocked", 2647, "human-thread", "unresolved human review thread")
        ledger = self.ledger()
        item = pr(2647, latest=mergify())
        fake = FakeGh()
        executor = self.executor(fake, ledger, "owner/repo")
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            performed = executor.execute(action, item, 1)
        self.assertFalse(performed)
        self.assertEqual(fake.comments, [])
        self.assertEqual(ledger.count("comment-blocked", 2647, HEAD, "human-thread"), 0)
        self.assertIn('"event": "admin-bypass-stale-head-skip"', stderr.getvalue())

    def test_restore_admin_bypass_label_edits_once_per_head(self):
        class FakeGh:
            def __init__(self):
                self.label_edits = []

            def edit_label(self, repo, pr_number, *, add=None, remove=None):
                self.label_edits.append((repo, pr_number, add, remove))

        action = Action("restore_admin_bypass_label", 5811, "required-fast / Guardrails", "restore admin-bypass label after queue-only noop")
        ledger = self.ledger()
        item = pr(5811, labels={"dequeued"}, latest=mergify())
        fake = FakeGh()
        executor = self.executor(fake, ledger, "owner/repo")
        executor.execute(action, item, 1)
        executor.execute(action, item, 2)
        self.assertEqual(fake.label_edits, [("owner/repo", 5811, "admin-bypass", None)])
        self.assertEqual(ledger.count("restore-admin-bypass-label", 5811, HEAD, "admin-bypass"), 1)

    def test_mergify_queue_failure_repairs_even_when_current_required_check_is_missing(self):
        latest = MergifyQueueEvent(
            "m2969",
            "dequeued",
            "admin-bypass",
            "2026-07-03T06:13:00Z",
            HEAD,
            ("e2e-proof / aggregate",),
            ("PR Body",),
            "https://github.com/Neko-Catpital-Labs/Invoker/pull/2969#issuecomment-4872966494",
            2985,
            (("PR Body", ("https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/28641642476/job/84938961337",)),),
            (("optional / Visual Proof Validate", "success"), ("PR Body", "success")),
        )
        checks = {"PR Body": check("PR Body"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2969, checks=checks, latest=latest),))
        actions = plan_stack_actions(stack, REQUIRED | {"optional / Visual Proof Validate"}, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.key, a.detail) for a in actions], [("repair_check", 2969, "PR Body", "Mergify queue check failed: PR Body")])

    def test_mergify_reason_failure_repairs_without_failing_checks_section(self):
        comment = {
            "id": "m1814",
            "user": {"login": "mergify"},
            "updated_at": "2026-07-03T00:58:00Z",
            "body": """
-*- Mergify Payload -*-
{"state":"dequeued","queue_rule_name":"admin-bypass"}

- ❌ **Checks failed** · on draft #2967
- 🚫 **Left the queue** — `2026-07-03 00:58 UTC` · at `c2532d229dbed2fd57419698c48d973001c78e9e`

## Reason

The merge conditions cannot be satisfied due to failing checks

- `e2e-proof / aggregate`
""",
        }
        event = parse_mergify_queue_event(comment)
        self.assertIsNotNone(event)
        self.assertEqual(event.failing_checks, ("e2e-proof / aggregate",))
        stack = StackGroup("s", (pr(1814, latest=event),))
        actions = plan_stack_actions(stack, REQUIRED | {"e2e-proof / aggregate"}, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.key) for a in actions], [("repair_check", 1814, "e2e-proof / aggregate")])

    def test_closed_pr_never_requeues_even_when_manually_requested(self):
        stack = StackGroup("s", (pr(2999, state="CLOSED", latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.detail) for a in actions], [("comment_blocked", 2999, "state=CLOSED")])


class WorkflowFastpathTests(unittest.TestCase):
    def test_resolve_workflow_for_pr_sources_headless_lib_and_parses_workflow_id(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout='{"workflowId": "wf-1-1"}\n', stderr="")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed) as run:
            result = fastpath.resolve_workflow_for_pr(6579)
        self.assertEqual(result, "wf-1-1")
        args = run.call_args.args[0]
        self.assertEqual(args[0], "bash")
        self.assertEqual(args[1], "-c")
        self.assertIn("headless-lib.sh", " ".join(str(part) for part in args))
        self.assertNotIn("cron-pr-lib.sh", " ".join(str(part) for part in args))
        self.assertIn("headless_query query review-gate", args[2])
        self.assertIn("6579", args)

    def test_resolve_workflow_for_pr_returns_none_on_genuine_miss(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="{}\n", stderr="")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed):
            result = fastpath.resolve_workflow_for_pr(6579)
        self.assertIsNone(result)

    def test_resolve_workflow_for_pr_raises_on_lookup_failure(self):
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                fastpath.resolve_workflow_for_pr(6579)

    def test_submit_rebase_recreate_command_shape(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed) as run:
            fastpath.submit_rebase_recreate("wf-1-1")
        args = run.call_args.args[0]
        self.assertEqual(args[0], "bash")
        self.assertEqual(args[1], "-c")
        self.assertIn("headless-lib.sh", " ".join(str(part) for part in args))
        self.assertNotIn("cron-pr-lib.sh", " ".join(str(part) for part in args))
        self.assertIn("headless_mutation --no-track rebase-recreate", args[2])
        self.assertIn("wf-1-1", args)

    def test_submit_rebase_recreate_raises_on_failure(self):
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                fastpath.submit_rebase_recreate("wf-1-1")

    def test_submit_repair_review_gate_ci_command_shape(self):
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed) as run:
            fastpath.submit_repair_review_gate_ci(6579)
        args = run.call_args.args[0]
        self.assertEqual(args[0], "bash")
        self.assertEqual(args[1], "-c")
        self.assertIn("headless-lib.sh", " ".join(str(part) for part in args))
        self.assertNotIn("cron-pr-lib.sh", " ".join(str(part) for part in args))
        self.assertIn("headless_mutation --no-track repair-review-gate-ci", args[2])
        self.assertIn("6579", args)

    def test_submit_repair_review_gate_ci_raises_on_failure(self):
        completed = subprocess.CompletedProcess(args=[], returncode=1, stdout="", stderr="boom")
        with mock.patch.object(headless_shell.subprocess, "run", return_value=completed):
            with self.assertRaises(RuntimeError):
                fastpath.submit_repair_review_gate_ci(6579)


if __name__ == "__main__":
    unittest.main()
