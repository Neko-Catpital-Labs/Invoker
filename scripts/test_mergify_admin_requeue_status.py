"""Behavioural tests for ``mergify_admin_requeue --status``.

``--status`` is the read-only digest a babysit session uses instead of
re-deriving merge-queue state with repeated ``gh`` calls. The cron worker
already appends every decision to the ledger, so the digest is a pure fold of
that append-only JSONL down to the latest row per (repo, PR, kind, key).

Two properties carry the feature and are pinned below:

  1. It folds correctly -- latest epoch wins, per PR, per kind, per key.
  2. It is strictly read-only -- no subprocess, no GitHub, no ledger write.

Run:  python3 -m unittest scripts.test_mergify_admin_requeue_status
"""

from __future__ import annotations

import io
import json
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


def row(pr: int, kind: str, key: str, epoch: int, **extra: object) -> str:
    payload: dict[str, object] = {"kind": kind, "pr": pr, "headSha": "sha-" + str(epoch), "key": key, "epoch": epoch}
    payload.update(extra)
    return json.dumps(payload, sort_keys=True)


# A realistic slice of the worker's ledger: PR #3221 had a repair dispatched,
# acknowledged, then settled; PR #3222 was only requeued. The two `repair-check`
# rows for the same (pr, key) are exactly the fold this digest exists to do.
FIXTURE_ROWS = [
    row(3221, "repair-check", "quality / CI", 1000, meta={"planName": "repair-3221", "dispatchState": "pending"}),
    row(3221, "repair-check", "quality / CI", 2000, meta={"planName": "repair-3221", "dispatchState": "acknowledged"}),
    row(3222, "requeue", "flaky", 1500),
    row(3221, "repair-check-settled", "quality / CI", 3000, meta={"workflowStatus": "completed", "outcomeClass": "success"}),
]


class StatusDigestTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = Path(self.tmp.name) / "state.jsonl"

    def write_ledger(self, lines: list[str]) -> Path:
        self.state_file.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        return self.state_file

    def run_status(self, *extra: str) -> tuple[int, str, str]:
        argv = ["--status", "--state-file", str(self.state_file), *extra]
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = requeue.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_folds_to_the_latest_row_per_pr_kind_and_key(self):
        self.write_ledger(FIXTURE_ROWS)
        code, stdout, _ = self.run_status()
        self.assertEqual(code, 0)
        self.assertIn("rows=4 prs=2", stdout)
        self.assertIn("repair-check state=acknowledged key='quality / CI'", stdout)
        self.assertNotIn("state=pending", stdout)
        self.assertIn("repair-check-settled state=success key='quality / CI'", stdout)

    def test_groups_entries_under_their_own_pr_header(self):
        self.write_ledger(FIXTURE_ROWS)
        _, stdout, _ = self.run_status()
        lines = stdout.splitlines()
        self.assertEqual(lines[1], "PR #3221")
        self.assertEqual(
            [line.split()[0] for line in lines[2:4]],
            ["repair-check", "repair-check-settled"],
        )
        self.assertEqual(lines[4], "PR #3222")
        self.assertIn("requeue state=- key='flaky'", lines[5])

    def test_same_pr_number_in_two_repos_does_not_collapse(self):
        self.write_ledger([
            row(7, "requeue", "flaky", 100, repo="owner/invoker"),
            row(7, "requeue", "flaky", 200, repo="owner/catstack"),
        ])
        _, stdout, _ = self.run_status()
        self.assertIn("PR #7 (owner/catstack)", stdout)
        self.assertIn("PR #7 (owner/invoker)", stdout)
        self.assertIn("prs=2", stdout)

    def test_pr_filter_limits_the_digest(self):
        self.write_ledger(FIXTURE_ROWS)
        _, stdout, _ = self.run_status("--pr", "3222")
        self.assertIn("PR #3222", stdout)
        self.assertNotIn("PR #3221", stdout)

    def test_json_emits_one_object_per_pr(self):
        self.write_ledger(FIXTURE_ROWS)
        code, stdout, _ = self.run_status("--json")
        self.assertEqual(code, 0)
        objects = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([obj["pr"] for obj in objects], [3221, 3222])
        first = objects[0]["entries"]
        self.assertEqual([entry["kind"] for entry in first], ["repair-check", "repair-check-settled"])
        self.assertEqual(first[0]["state"], "acknowledged")
        self.assertEqual(first[0]["meta"]["planName"], "repair-3221")
        self.assertEqual(first[1]["epoch"], 3000)
        self.assertEqual(first[1]["recordedAt"], "1970-01-01T00:50:00Z")
        self.assertEqual(objects[0]["stateFile"], str(self.state_file))

    def test_missing_state_file_reports_an_empty_digest_without_creating_it(self):
        code, stdout, stderr = self.run_status()
        self.assertEqual(code, 0)
        self.assertIn("rows=0 prs=0", stdout)
        self.assertIn("no recorded state", stdout)
        self.assertEqual(stderr, "")
        self.assertFalse(self.state_file.exists())

    def test_malformed_rows_are_reported_not_silently_dropped(self):
        self.write_ledger([
            "not json at all",
            json.dumps([1, 2, 3]),
            json.dumps({"kind": "requeue", "key": "flaky", "epoch": 10}),
            json.dumps({"kind": "requeue", "pr": "not-a-number", "key": "flaky", "epoch": 11}),
            row(3221, "requeue", "flaky", 12),
        ])
        code, stdout, stderr = self.run_status()
        self.assertEqual(code, 0)
        self.assertIn("unreadable=4", stdout)
        self.assertIn("PR #3221", stdout)
        self.assertIn("unusable pr field None", stderr)
        self.assertIn("unusable pr field 'not-a-number'", stderr)
        self.assertIn("2 line(s)", stderr)

    def test_unusable_epoch_is_reported_and_the_row_is_still_shown(self):
        self.write_ledger([json.dumps({"kind": "requeue", "pr": 9, "key": "flaky", "epoch": "later"})])
        _, stdout, stderr = self.run_status()
        self.assertIn("unreadable=1", stdout)
        self.assertIn("unusable epoch 'later'", stderr)
        self.assertIn("requeue state=- key='flaky'", stdout)

    def test_state_prefers_outcome_then_workflow_status_then_dispatch_state(self):
        self.assertEqual(exec_impl.status_state({"outcomeClass": "infra", "dispatchState": "not-acknowledged"}), "infra")
        self.assertEqual(exec_impl.status_state({"workflowStatus": "running", "dispatchState": "acknowledged"}), "running")
        self.assertEqual(exec_impl.status_state({"dispatchState": "pending"}), "pending")
        self.assertEqual(exec_impl.status_state({}), "-")
        self.assertEqual(exec_impl.status_state(None), "-")


class StatusIsReadOnlyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state_file = Path(self.tmp.name) / "state.jsonl"
        self.state_file.write_text("".join(line + "\n" for line in FIXTURE_ROWS), encoding="utf-8")

    def test_status_runs_no_subprocess_and_leaves_the_ledger_byte_identical(self):
        before_bytes = self.state_file.read_bytes()
        before_stat = self.state_file.stat()
        boom = AssertionError("--status must not spawn a subprocess")
        with mock.patch.object(subprocess, "run", side_effect=boom), \
             mock.patch.object(subprocess, "Popen", side_effect=boom), \
             mock.patch.object(subprocess, "check_output", side_effect=boom), \
             mock.patch.object(os, "system", side_effect=boom), \
             redirect_stdout(io.StringIO()) as stdout:
            code = requeue.main(["--status", "--state-file", str(self.state_file)])
        self.assertEqual(code, 0)
        self.assertIn("PR #3221", stdout.getvalue())
        self.assertEqual(self.state_file.read_bytes(), before_bytes)
        self.assertEqual(self.state_file.stat().st_mtime_ns, before_stat.st_mtime_ns)

    def test_status_never_reaches_the_github_or_worker_entry_points(self):
        guards = {
            name: mock.patch.object(exec_impl, name, side_effect=AssertionError(f"--status must not call {name}"))
            for name in ("run_once", "run_loop", "run_report", "run_cron_target_repos")
        }
        with mock.patch.object(exec_impl, "GhClient", side_effect=AssertionError("--status must not build a GhClient")):
            for guard in guards.values():
                self.addCleanup(guard.stop)
                guard.start()
            with redirect_stdout(io.StringIO()):
                code = requeue.main(["--status", "--state-file", str(self.state_file)])
        self.assertEqual(code, 0)

    def test_status_does_not_create_a_state_file_that_was_absent(self):
        absent = Path(self.tmp.name) / "nested" / "absent.jsonl"
        with redirect_stdout(io.StringIO()):
            code = requeue.main(["--status", "--state-file", str(absent)])
        self.assertEqual(code, 0)
        self.assertFalse(absent.exists())
        self.assertFalse(absent.parent.exists())


class StatusFlagWiringTest(unittest.TestCase):
    def test_status_is_a_mode_and_defaults_off(self):
        args = requeue.parse_args(["--once"])
        self.assertFalse(args.status)
        self.assertTrue(args.once)
        args = requeue.parse_args(["--status"])
        self.assertTrue(args.status)
        self.assertFalse(args.once)
        self.assertFalse(args.loop)
        self.assertFalse(args.report)

    def test_status_cannot_be_combined_with_another_mode(self):
        with redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                requeue.parse_args(["--status", "--once"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
