"""Behavioural tests for ``mergify_admin_requeue_snapshot``.

Documentation-by-test for the loader. This layer takes the *raw* shapes GitHub's
`gh` CLI returns — issue comments, GraphQL PR detail, status-check rollups,
review threads — and folds them into the typed ``PrSnapshot`` the planner reads.

Most tests feed one realistic raw shape and pin what gets parsed out of it and
why. Subprocess coverage stays limited to GitHub CLI error classification.

Run:  python3 scripts/test_mergify_admin_requeue_snapshot.py
"""

from __future__ import annotations

import ast
import sys
import subprocess
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_model as m
import mergify_admin_requeue_snapshot as s


HEAD = "a" * 40

# A real Mergify "dequeued" comment: prose plus the hidden `-*- Mergify Payload
# -*-` blob. The loader only trusts comments authored by mergify[bot].
MERGIFY_DEQUEUE_COMMENT = {
    "user": {"login": "mergify[bot]"},
    "id": "c-9001",
    "updated_at": "2026-07-07T05:00:00Z",
    "html_url": "https://github.com/o/r/pull/4242#issuecomment-9001",
    "body": """\
## Merge Queue status

The pull request has been dequeued. Left the queue for head `%s`.

on draft #4242

### Failing checks

- [ ] [build (ubuntu-latest)](https://github.com/o/r/actions/runs/1/job/2)

### Waiting for

- all queue conditions to match

<!-- -*- Mergify Payload -*-
{"state": "dequeued", "queue_rule_name": "default"}
-*- Mergify Payload -*- -->
""" % HEAD,
}


# A real Mergify "waiting" status comment, posted after an `@mergifyio queue`
# command while its queue conditions are still being evaluated. Note the
# payload carries `"state": "waiting"` with a null queue_rule_name.
MERGIFY_WAITING_COMMENT = {
    "user": {"login": "mergify[bot]"},
    "id": "c-9002",
    "created_at": "2026-07-07T05:10:00Z",
    "updated_at": "2026-07-07T05:10:00Z",
    "html_url": "https://github.com/o/r/pull/4242#issuecomment-9002",
    "body": """\
<!---
DO NOT EDIT
-*- Mergify Payload -*-
{"version": 1, "state": "waiting", "queue_rule_name": null, "queued_at": null}
-*- Mergify Payload End -*-
-->

# Merge Queue Status

- \U0001f7e0 **Waiting for queue conditions**
- ⏳ Enter queue
- ⏳ Run checks
- ⏳ Merge

<details>
<summary><strong>Waiting for</strong></summary>

- [ ] `-conflict` [\U0001f4cc queue requirement]

</details>
""",
}


class ParseMergifyQueueEvent(unittest.TestCase):
    def test_ignores_comments_not_from_mergify(self):
        # Only Mergify's own comments describe the queue; a human/bot comment
        # that happens to look similar must be ignored.
        self.assertIsNone(
            s.parse_mergify_queue_event({"user": {"login": "coderabbitai[bot]"},
                                         "body": "Left the queue `%s`" % HEAD})
        )

    def test_ignores_mergify_comment_without_payload_marker(self):
        self.assertIsNone(
            s.parse_mergify_queue_event({"user": {"login": "mergify[bot]"},
                                         "body": "some chatter, no payload"})
        )

    def test_parses_dequeue_comment_into_event(self):
        event = s.parse_mergify_queue_event(MERGIFY_DEQUEUE_COMMENT)
        assert event is not None
        self.assertEqual(event.state, "dequeued")
        self.assertEqual(event.queue_rule_name, "default")
        self.assertEqual(event.head_sha, HEAD)          # from "Left the queue ... `sha`"
        self.assertEqual(event.queue_pr_number, 4242)   # from "on draft #4242"
        self.assertEqual(event.failing_checks, ("build (ubuntu-latest)",))
        self.assertEqual(event.comment_id, "c-9001")
        self.assertEqual(event.queued_at, "2026-07-07T05:00:00Z")

    def test_parses_waiting_command_comment_into_event(self):
        # Incident 2026-08-04 (PR #7420): a pending `queue` command reports
        # `state: "waiting"` with no queue rule; it must not parse as
        # "unknown" or the planner cannot tell a command is in flight.
        event = s.parse_mergify_queue_event(MERGIFY_WAITING_COMMENT)
        assert event is not None
        self.assertEqual(event.state, "waiting")
        self.assertEqual(event.queue_rule_name, "")
        self.assertEqual(event.head_sha, "")

    def test_edited_stale_dequeue_comment_does_not_outrank_newer_waiting_comment(self):
        # Incident 2026-08-04 (PR #7420): Mergify edited the old "dequeued"
        # status comment one second after posting the new "waiting" comment,
        # so ordering by updated_at resurfaced the stale dequeue event and the
        # planner kept requeueing into the retry cap. Creation order is the
        # command order; in-place edits must not promote an old event.
        stale_dequeue = dict(MERGIFY_DEQUEUE_COMMENT)
        stale_dequeue["created_at"] = "2026-07-07T05:00:00Z"
        stale_dequeue["updated_at"] = "2026-07-07T05:10:01Z"
        detail = {"number": 4242, "headRefOid": HEAD, "state": "OPEN"}
        snap = s.snapshot_from_detail(detail, [stale_dequeue, MERGIFY_WAITING_COMMENT], required_checks=[])
        assert snap.latest_mergify is not None
        self.assertEqual(snap.latest_mergify.state, "waiting")


class GhCommandFailures(unittest.TestCase):
    def test_graphql_rate_limit_becomes_controlled_runtime_error(self):
        error = subprocess.CalledProcessError(
            1,
            ["gh", "api", "graphql"],
            stderr='{"errors":[{"type":"RATE_LIMIT","code":"graphql_rate_limit","message":"API rate limit already exceeded"}]}',
        )
        with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, "GitHub API rate limit exceeded"):
                s.run_logged(["gh", "api", "graphql"])


class GhCommandTransientRetry(unittest.TestCase):
    # Incident 2026-08-12: gh's GraphQL calls intermittently fail with 502/504
    # gateway errors and stream resets; run_logged previously raised on the
    # first failure, killing the whole babysitting cycle for a blip that
    # would have succeeded on the very next attempt.
    def test_retries_transient_gateway_error_then_succeeds(self):
        transient = subprocess.CalledProcessError(
            1, ["gh", "pr", "list"], stderr="HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)",
        )
        success = subprocess.CompletedProcess(["gh", "pr", "list"], 0, stdout="[]", stderr="")
        with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=[transient, success]) as run_mock:
            with mock.patch("mergify_admin_requeue_snapshot.time.sleep"):
                out = s.run_logged(["gh", "pr", "list"])
        self.assertEqual(out, "[]")
        self.assertEqual(run_mock.call_count, 2)

    def test_retries_stream_reset_then_succeeds(self):
        transient = subprocess.CalledProcessError(
            1, ["gh", "pr", "list"], stderr="stream error: stream ID 1; CANCEL; received from peer",
        )
        success = subprocess.CompletedProcess(["gh", "pr", "list"], 0, stdout="[]", stderr="")
        with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=[transient, success]):
            with mock.patch("mergify_admin_requeue_snapshot.time.sleep"):
                out = s.run_logged(["gh", "pr", "list"])
        self.assertEqual(out, "[]")

    def test_exhausts_retries_and_raises_last_error(self):
        transient = subprocess.CalledProcessError(
            1, ["gh", "pr", "list"], stderr="HTTP 504: gateway timeout",
        )
        with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=transient) as run_mock:
            with mock.patch("mergify_admin_requeue_snapshot.time.sleep"):
                with self.assertRaises(subprocess.CalledProcessError):
                    s.run_logged(["gh", "pr", "list"])
        self.assertEqual(run_mock.call_count, 3)

    def test_non_transient_error_does_not_retry(self):
        hard_error = subprocess.CalledProcessError(1, ["gh", "pr", "list"], stderr="HTTP 404: Not Found")
        with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=hard_error) as run_mock:
            with self.assertRaises(subprocess.CalledProcessError):
                s.run_logged(["gh", "pr", "list"])
        self.assertEqual(run_mock.call_count, 1)

    def test_hang_times_out_and_is_retried(self):
        timeout_exc = subprocess.TimeoutExpired(["gh", "pr", "list"], 90)
        success = subprocess.CompletedProcess(["gh", "pr", "list"], 0, stdout="[]", stderr="")
        with mock.patch("mergify_admin_requeue_snapshot.subprocess.run", side_effect=[timeout_exc, success]):
            with mock.patch("mergify_admin_requeue_snapshot.time.sleep"):
                out = s.run_logged(["gh", "pr", "list"])
        self.assertEqual(out, "[]")


class ParseStackMetadata(unittest.TestCase):
    def test_newest_comment_with_marker_wins(self):
        old = {"updated_at": "2026-07-01T00:00:00Z",
               "body": '<!-- mergify-stack-data: {"stack_id":"old","pull_numbers_bottom_to_top":[1,2]} -->'}
        new = {"updated_at": "2026-07-07T00:00:00Z",
               "body": '<!-- mergify-stack-data: {"stack_id":"new","pull_numbers_bottom_to_top":[10,11,12]} -->'}
        self.assertEqual(s.parse_stack_metadata([old, new]), ("new", (10, 11, 12)))

    def test_no_marker_returns_none(self):
        self.assertIsNone(s.parse_stack_metadata([{"body": "nothing here"}]))


class LabelsFromNodes(unittest.TestCase):
    def test_graphql_nodes_shape(self):
        self.assertEqual(
            s.labels_from_nodes({"nodes": [{"name": "admin-bypass"}, {"name": "x"}]}),
            frozenset({"admin-bypass", "x"}),
        )

    def test_plain_list_and_strings(self):
        self.assertEqual(s.labels_from_nodes([{"name": "y"}]), frozenset({"y"}))
        self.assertEqual(s.labels_from_nodes(["z"]), frozenset({"z"}))

    def test_missing_is_empty(self):
        self.assertEqual(s.labels_from_nodes(None), frozenset())


class ReviewThreadsParsing(unittest.TestCase):
    def test_collects_thread_id_resolution_and_authors(self):
        value = {
            "pageInfo": {"hasNextPage": False},
            "nodes": [
                {"id": "t1", "isResolved": False,
                 "isOutdated": True,
                 "comments": {"nodes": [{"author": {"login": "coderabbitai[bot]"}}]}},
                {"id": "t2", "isResolved": True, "comments": {"nodes": []}},
            ],
        }
        self.assertEqual(
            s.review_threads(value),
            (m.ReviewThread("t1", False, ("coderabbitai[bot]",), True),
             m.ReviewThread("t2", True, ())),
        )

    def test_pagination_is_flagged_conservatively(self):
        # If threads paginate, we can't be sure they're all resolved, so the
        # loader emits a sentinel unresolved-by-a-human thread to stay safe.
        threads = s.review_threads({"pageInfo": {"hasNextPage": True}})
        self.assertEqual(len(threads), 1)
        self.assertFalse(threads[0].is_resolved)


class RawContexts(unittest.TestCase):
    def test_digs_through_status_check_rollup(self):
        pr = {"statusCheckRollup": {"contexts": {"nodes": [{"name": "build"}]}}}
        self.assertEqual(s.raw_contexts(pr), [{"name": "build"}])

    def test_missing_rollup_is_empty(self):
        self.assertEqual(s.raw_contexts({}), [])


class GroupStackPrs(unittest.TestCase):
    def _pr(self, number, base, head, state="OPEN"):
        return m.PrSnapshot(
            number=number, title="t", body="", url="u", state=state, is_draft=False,
            base_ref_name=base, head_ref_name=head, head_ref_oid=HEAD,
            merge_state_status="BLOCKED", mergeable="MERGEABLE",
            labels=frozenset(), checks={}, review_threads=(), latest_mergify=None,
        )

    def test_groups_by_declared_stack_metadata(self):
        prs = [self._pr(10, "master", "b10"), self._pr(11, "b10", "b11"), self._pr(12, "b11", "b12")]
        meta = {n: ("declared", (10, 11, 12)) for n in (10, 11, 12)}
        groups = s.group_stack_prs(prs, meta, trunk="master")
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].stack_id, "declared")
        self.assertEqual(tuple(pr.number for pr in groups[0].prs), (10, 11, 12))

    def test_falls_back_to_branch_chain_when_no_metadata(self):
        # No stack comment: reconstruct the chain from base->head links.
        prs = [self._pr(1, "master", "brA"), self._pr(2, "brA", "brB")]
        groups = s.group_stack_prs(prs, {}, trunk="master")
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0].stack_id, "branch:1")
        self.assertEqual(tuple(pr.number for pr in groups[0].prs), (1, 2))


class SnapshotFromDetail(unittest.TestCase):
    """End-to-end: raw `gh` PR detail + comments -> one typed PrSnapshot."""

    def test_builds_full_snapshot(self):
        detail = {
            "number": 3221, "title": "Add model", "body": "## Summary\n\nBody.\n", "url": "https://x/3221",
            "state": "OPEN", "isDraft": False,
            "baseRefName": "master", "headRefName": "stack/x", "headRefOid": HEAD,
            "mergeStateStatus": "BLOCKED", "mergeable": "MERGEABLE",
            "labels": {"nodes": [{"name": "admin-bypass"}]},
            "statusCheckRollup": {"contexts": {"nodes": [
                {"name": "build", "status": "COMPLETED", "conclusion": "FAILURE",
                 "checkSuite": {"commit": {"oid": HEAD}}, "completedAt": "2026-01-02T00:00:00Z"},
                {"__typename": "StatusContext", "context": "lint", "state": "SUCCESS",
                 "commit": {"oid": HEAD}},
            ]}},
            "reviewThreads": {"pageInfo": {"hasNextPage": False},
                              "nodes": [{"id": "t1", "isResolved": True, "comments": {"nodes": []}}]},
        }
        snap = s.snapshot_from_detail(detail, [MERGIFY_DEQUEUE_COMMENT], required_checks=["build", "lint"])
        self.assertEqual(snap.number, 3221)
        self.assertEqual(snap.state, "OPEN")
        self.assertEqual(snap.base_ref_name, "master")
        self.assertEqual(snap.labels, frozenset({"admin-bypass"}))
        # only required checks, on the current head, flattened from both shapes:
        self.assertEqual(set(snap.checks), {"build", "lint"})
        self.assertEqual(snap.checks["build"].state, "failure")
        self.assertEqual(snap.checks["lint"].state, "success")
        self.assertEqual(snap.review_threads, (m.ReviewThread("t1", True, ()),))
        # the Mergify comment is attached as the latest queue event:
        assert snap.latest_mergify is not None
        self.assertEqual(snap.latest_mergify.state, "dequeued")
        self.assertEqual(snap.latest_mergify.head_sha, HEAD)


class GhClientCandidateDiscovery(unittest.TestCase):
    def test_label_seed_expands_stack_metadata_to_unlabeled_bottom(self):
        bottom = {
            "number": 100,
            "title": "bottom",
            "labels": {"nodes": [{"name": "dequeued"}]},
        }
        upper = {
            "number": 101,
            "title": "upper",
            "labels": {"nodes": [{"name": "admin-bypass"}]},
        }
        comments = {
            101: [{
                "created_at": "2026-07-19T00:00:00Z",
                "body": '<!-- mergify-stack-data: {"stack_id":"s","pull_numbers_bottom_to_top":[100,101]} -->',
            }],
        }

        class FakeGh(s.GhClient):
            def __init__(self):
                self.list_args = []
                self.detail_calls = []
                self.comment_calls = []

            def _run_json(self, args):
                self.list_args = list(args)
                return [upper]

            def pr_detail(self, repo, number):
                self.detail_calls.append((repo, number))
                return bottom if number == 100 else upper

            def issue_comments(self, repo, number):
                self.comment_calls.append((repo, number))
                return comments.get(number, [])

        client = FakeGh()
        found = client.list_candidate_prs("Neko-Catpital-Labs/Invoker", "EdbertChan", [])

        self.assertIn("--label", client.list_args)
        self.assertIn("admin-bypass", client.list_args)
        self.assertEqual([pr["number"] for pr in found], [101, 100])
        self.assertEqual(client.detail_calls, [("Neko-Catpital-Labs/Invoker", 100)])
        self.assertEqual(client.comment_calls, [("Neko-Catpital-Labs/Invoker", 101)])


class GhClientLabelEdit(unittest.TestCase):
    def test_candidate_scan_omits_author_by_default(self):
        client = s.GhClient()
        with mock.patch.object(client, "_run_json", return_value=[]) as run_json:
            client.list_candidate_prs("Neko-Catpital-Labs/Invoker", None, [])

        args = run_json.call_args.args[0]
        self.assertIn("--label", args)
        self.assertNotIn("--author", args)

    def test_candidate_scan_includes_explicit_author(self):
        client = s.GhClient()
        with mock.patch.object(client, "_run_json", return_value=[]) as run_json:
            client.list_candidate_prs("Neko-Catpital-Labs/Invoker", "EdbertChan", [])

        args = run_json.call_args.args[0]
        self.assertEqual(args[args.index("--author") + 1], "EdbertChan")

    def test_list_open_prs_has_no_label_filter(self):
        client = s.GhClient()
        with mock.patch.object(client, "_run_json", return_value=[]) as run_json:
            client.list_open_prs("Neko-Catpital-Labs/Invoker")

        args = run_json.call_args.args[0]
        self.assertNotIn("--label", args)
        fields = args[args.index("--json") + 1]
        self.assertNotIn("statusCheckRollup", fields)
        self.assertIn("headRefName", fields)

    def test_list_open_prs_omits_author_by_default(self):
        client = s.GhClient()
        with mock.patch.object(client, "_run_json", return_value=[]) as run_json:
            client.list_open_prs("Neko-Catpital-Labs/Invoker")

        args = run_json.call_args.args[0]
        self.assertNotIn("--author", args)

    def test_list_open_prs_includes_explicit_author(self):
        client = s.GhClient()
        with mock.patch.object(client, "_run_json", return_value=[]) as run_json:
            client.list_open_prs("Neko-Catpital-Labs/Invoker", "EdbertChan")

        args = run_json.call_args.args[0]
        self.assertEqual(args[args.index("--author") + 1], "EdbertChan")

    def test_add_label_uses_rest_issue_labels_endpoint(self):
        client = s.GhClient()
        with mock.patch("mergify_admin_requeue_snapshot.run_logged") as run:
            client.edit_label("Neko-Catpital-Labs/Invoker", 4157, add="admin-bypass")

        run.assert_called_once_with(
            [
                "gh",
                "api",
                "--method",
                "POST",
                "repos/Neko-Catpital-Labs/Invoker/issues/4157/labels",
                "-f",
                "labels[]=admin-bypass",
            ]
        )

    def test_remove_label_uses_rest_issue_labels_endpoint(self):
        client = s.GhClient()
        with mock.patch("mergify_admin_requeue_snapshot.run_logged") as run:
            client.edit_label("Neko-Catpital-Labs/Invoker", 4157, remove="merge-hold")

        run.assert_called_once_with(
            [
                "gh",
                "api",
                "--method",
                "DELETE",
                "repos/Neko-Catpital-Labs/Invoker/issues/4157/labels/merge-hold",
            ]
        )

class GhRetryBudgetRespectsWorkerTickTimeout(unittest.TestCase):
    # The pr-admin-bypass-land worker (packages/execution-engine/src/workers/
    # pr-maintenance-workers.ts) force-kills the whole script if a tick runs
    # past its 240s timeout. A run makes 100+ gh calls for ~50 admin-bypass
    # PRs. If run_logged's own per-call retry budget were allowed to approach
    # that 240s ceiling, a single stuck call could alone burn the worker's
    # entire tick budget -- worse than having no retries at all, since the
    # old behavior at least failed fast. This keeps the two budgets honest
    # relative to each other without needing a cross-language test harness.
    WORKER_TICK_TIMEOUT_SECONDS = 240  # pr-maintenance-workers.ts DEFAULT_PR_MAINTENANCE_WORKER_TICK_TIMEOUT_MS
    MAX_SAFE_FRACTION = 1 / 3  # leave headroom for the other 100+ calls in one tick

    def test_worst_case_single_call_retry_budget_leaves_room_for_the_rest_of_the_tick(self):
        budget = s.GH_CALL_WORST_CASE_SECONDS
        ceiling = self.WORKER_TICK_TIMEOUT_SECONDS * self.MAX_SAFE_FRACTION
        self.assertLess(
            budget, ceiling,
            f"one stuck gh call could burn {budget}s, more than {self.MAX_SAFE_FRACTION:.0%} of the worker's "
            f"{self.WORKER_TICK_TIMEOUT_SECONDS}s tick timeout -- tighten GH_COMMAND_TIMEOUT_SECONDS, "
            "GH_RETRY_MAX_ATTEMPTS, or GH_RETRY_BACKOFF_SECONDS",
        )


class GhCallsGoThroughRunLogged(unittest.TestCase):
    # Incident 2026-08-12: multiple `gh` CLI call sites across this script
    # family bypassed run_logged and had zero retry/timeout protection, so
    # any transient GitHub API 5xx or hang crashed the whole babysitting
    # cycle. Five prior PRs (#3224, #5127, #5721, #5483, #5866) fixed
    # planner/babysitting *logic* but never noticed this gap. This guard
    # keeps any future `gh` call in this file family routed through
    # run_logged, so it inherits retry protection automatically instead of
    # needing a human to remember.
    def test_no_gh_subprocess_call_bypasses_run_logged(self):
        root = Path(__file__).resolve().parent
        offenders: list[str] = []
        for path in sorted(root.glob("mergify_admin_requeue*.py")):
            if path.name.startswith("test_"):
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            offenders.extend(self._raw_gh_subprocess_calls(tree, path.name))
        self.assertEqual(
            offenders, [],
            "raw subprocess.run(['gh', ...]) call(s) bypassing run_logged (add via run_logged() instead): "
            + ", ".join(offenders),
        )

    @staticmethod
    def _raw_gh_subprocess_calls(tree: ast.AST, filename: str) -> list[str]:
        found: list[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or node.name == "run_logged":
                continue
            for call in ast.walk(node):
                if not (
                    isinstance(call, ast.Call)
                    and isinstance(call.func, ast.Attribute)
                    and call.func.attr == "run"
                    and isinstance(call.func.value, ast.Name)
                    and call.func.value.id == "subprocess"
                ):
                    continue
                if not call.args or not isinstance(call.args[0], ast.List) or not call.args[0].elts:
                    continue
                first = call.args[0].elts[0]
                if isinstance(first, ast.Constant) and first.value == "gh":
                    found.append(f"{filename}:{node.name}:{call.lineno}")
        return found


if __name__ == "__main__":
    unittest.main(verbosity=2)
