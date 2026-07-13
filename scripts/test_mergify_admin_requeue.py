import os
import subprocess
import tempfile
import unittest
from pathlib import Path
import scripts.mergify_admin_requeue as requeue

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

REQUIRED = {"PR Body", "quality / TypeScript Types"}
HEAD = "c2532d229dbed2fd57419698c48d973001c78e9e"
OLD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


def check(name, state="success", sha=HEAD):
    return CheckContext(name, state, "https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/1/job/2", sha, "2026-07-03T00:00:00Z")


def mergify(state="dequeued", comment_id="m1", sha=HEAD):
    return MergifyQueueEvent(comment_id, state, "admin-bypass", "2026-07-03T00:00:00Z", sha, (), (), "https://example.invalid/comment")


def pr(number, *, base="master", head=None, labels=None, checks=None, threads=(), latest=None, merge_state="CLEAN", mergeable="MERGEABLE", state="OPEN", draft=False):
    return PrSnapshot(
        number=number,
        title=f"PR {number}",
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


class MergifyAdminRequeueTests(unittest.TestCase):
    def ledger(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        return Ledger(Path(tmp.name) / "ledger.jsonl")

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

    def test_upper_stack_blocker_stops_bottom_requeue(self):
        failed = {"PR Body": check("PR Body", "failure"), "quality / TypeScript Types": check("quality / TypeScript Types")}
        stack = StackGroup("s", (pr(2604, head="stack/a", latest=mergify()), pr(2605, base="stack/a", checks=failed)))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("repair_check", 2605)])
        thread_stack = StackGroup("s", (pr(2604, head="stack/a", latest=mergify()), pr(2605, base="stack/a", threads=(ReviewThread("t1", False, ("alice",)),))))
        actions = plan_stack_actions(thread_stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number, a.detail) for a in actions], [("comment_blocked", 2605, "human-review-thread")])

    def test_missing_admin_bypass_label_on_current_bottom_adds_label_first(self):
        stack = StackGroup("s", (pr(2604, labels={"dequeued"}, latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("add_admin_bypass_label", 2604)])

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
        self.assertEqual([(a.kind, a.detail) for a in actions], [("comment_blocked", "human-review-thread")])

    def test_bot_thread_repairs_then_resolves(self):
        stack = StackGroup("s", (pr(2608, threads=(ReviewThread("tbot", False, ("coderabbitai[bot]",)),), latest=mergify()),))
        actions = plan_stack_actions(stack, REQUIRED, self.ledger(), 1)
        self.assertEqual([(a.kind, a.key) for a in actions], [("repair_check", "bot_review_thread:tbot")])
        ledger = self.ledger()
        ledger.record("repair-bot-thread", 2608, OLD, "tbot", 1)
        actions = plan_stack_actions(stack, REQUIRED, ledger, 2)
        self.assertEqual([(a.kind, a.key) for a in actions], [("resolve_bot_threads", "tbot")])

    def test_conflict_uses_rebase_recreate_cap(self):
        stack = StackGroup("s", (pr(2609, merge_state="DIRTY", latest=mergify()),))
        ledger = self.ledger()
        actions = plan_stack_actions(stack, REQUIRED, ledger, 1)
        self.assertEqual([(a.kind, a.pr_number) for a in actions], [("rebase_recreate", 2609)])
        for epoch in range(3):
            ledger.record("conflict-repair", 2609, HEAD, "conflict:2609", epoch)
        actions = plan_stack_actions(stack, REQUIRED, ledger, 4)
        self.assertEqual([(a.kind, a.key) for a in actions], [("comment_blocked", "capped")])

    def test_resolve_workflow_turns_command_failure_into_runtime_error(self):
        original_run = requeue.subprocess.run
        try:
            requeue.subprocess.run = lambda *args, **kwargs: (_ for _ in ()).throw(
                subprocess.CalledProcessError(1, ["./run.sh"], stderr="missing workflow")
            )
            with self.assertRaisesRegex(RuntimeError, "missing workflow"):
                requeue._resolve_workflow(2647)
        finally:
            requeue.subprocess.run = original_run


    def test_rebase_recreate_without_local_workflow_records_and_caps(self):
        class FakeGh:
            def __init__(self):
                self.comments = []

            def comment(self, repo, pr_number, body):
                self.comments.append((repo, pr_number, body))

        ledger = self.ledger()
        item = pr(2647, merge_state="DIRTY", latest=mergify())
        action = Action("rebase_recreate", 2647, "conflict:2647", "GitHub reports merge conflict")
        fake = FakeGh()
        repairs = []
        original_resolve = requeue._resolve_workflow
        original_repair = requeue._repair_conflict
        try:
            requeue._resolve_workflow = lambda pr_number: (_ for _ in ()).throw(RuntimeError(f"no local workflow for PR #{pr_number}"))
            requeue._repair_conflict = lambda repo, pr, reason: repairs.append((repo, pr.number, reason))
            for epoch in range(3):
                requeue._execute_action(action, "Neko-Catpital-Labs/Invoker", fake, ledger, {2647: item}, epoch)
        finally:
            requeue._resolve_workflow = original_resolve
            requeue._repair_conflict = original_repair
        self.assertEqual(ledger.count("conflict-repair", 2647, HEAD, "conflict:2647"), 3)
        self.assertEqual([repair[1] for repair in repairs], [2647, 2647, 2647])
        self.assertEqual(fake.comments, [])
        actions = plan_stack_actions(StackGroup("s", (item,)), REQUIRED, ledger, 4)
        self.assertEqual([(a.kind, a.key) for a in actions], [("comment_blocked", "capped")])

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
        requeue._execute_action(action, "Neko-Catpital-Labs/Invoker", fake, ledger, {2647: item}, 1)
        requeue._execute_action(action, "Neko-Catpital-Labs/Invoker", fake, ledger, {2647: item}, 2)
        self.assertEqual(len(fake.comments), 1)



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
        self.assertEqual([(a.kind, a.pr_number, a.detail) for a in actions], [("comment_blocked", 2999, "closed")])


if __name__ == "__main__":
    unittest.main()
