#!/usr/bin/env python3
"""Fixture-based tests for codex-session-audit.py.

Run: python3 scripts/test-codex-session-audit.py
(stdlib unittest only; fixtures are small synthetic JSONL, not real
Codex session data.)
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib.util

spec = importlib.util.spec_from_file_location(
    "codex_session_audit", os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex-session-audit.py")
)
codex_session_audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codex_session_audit)


def write_session(session_dir, filename, lines):
    path = os.path.join(session_dir, filename)
    with open(path, "w") as f:
        for d in lines:
            f.write(json.dumps(d) + "\n")
    return path


class TestFilenameTimestamp(unittest.TestCase):
    def test_parses_valid_rollout_filename(self):
        ts = codex_session_audit.filename_timestamp("rollout-2026-08-15T10-47-21-01a00508-8dd6.jsonl")
        self.assertEqual(ts, "2026-08-15T10:47:21")

    def test_non_rollout_filename_returns_none(self):
        self.assertIsNone(codex_session_audit.filename_timestamp("not-a-rollout-file.jsonl"))


class TestCwdParsing(unittest.TestCase):
    """Regression coverage for the actual bug hit mid-session: the original
    regex `experiment-(wf-\\d+-\\d+)-([a-z0-9-]+?)/g\\d+\\.t\\d+\\.a-`
    expected a `/` before the generation marker, but the real cwd has no
    slash there (task_type and the g<N>.t<N>.a- suffix are dash-joined in
    the same path segment) -- so it silently matched nothing and
    workflow_id/task_type came back None for every real session."""

    def test_task_type_with_dashes_and_no_slash_before_generation_marker(self):
        session_dir = tempfile.mkdtemp()
        cwd = (
            "/home/invoker/.invoker/worktrees/647faa73e90e/"
            "experiment-wf-1786788062899-48-fix-ci-2363032-required-fast-vitest-workspace-g0.t0.a-a88bbe6d1-19fe7a56"
        )
        write_session(session_dir, "rollout-2026-08-15T10-47-21-abc.jsonl", [
            {"type": "session_meta", "payload": {"cwd": cwd}},
        ])
        results = codex_session_audit.audit(session_dir)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["workflow_id"], "wf-1786788062899-48")
        self.assertEqual(results[0]["task_type"], "fix-ci-2363032-required-fast-vitest-workspace")

    def test_simple_task_type_still_parses(self):
        session_dir = tempfile.mkdtemp()
        cwd = "/home/invoker/.invoker/worktrees/abc/experiment-wf-123-4-repair-g0.t0.a-deadbeef"
        write_session(session_dir, "rollout-2026-08-15T08-00-00-xyz.jsonl", [
            {"type": "session_meta", "payload": {"cwd": cwd}},
        ])
        results = codex_session_audit.audit(session_dir)
        self.assertEqual(results[0]["workflow_id"], "wf-123-4")
        self.assertEqual(results[0]["task_type"], "repair")

    def test_unparseable_cwd_leaves_fields_none_not_crash(self):
        session_dir = tempfile.mkdtemp()
        write_session(session_dir, "rollout-2026-08-15T08-00-00-xyz.jsonl", [
            {"type": "session_meta", "payload": {"cwd": "/some/unrelated/path"}},
        ])
        results = codex_session_audit.audit(session_dir)
        self.assertIsNone(results[0]["workflow_id"])
        self.assertIsNone(results[0]["task_type"])


class TestTokenAndQuotaExtraction(unittest.TestCase):
    def test_extracts_tokens_and_rate_limits(self):
        session_dir = tempfile.mkdtemp()
        write_session(session_dir, "rollout-2026-08-15T09-00-00-xyz.jsonl", [
            {"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}},
            {
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {"total_token_usage": {"total_tokens": 12345}},
                    "rate_limits": {"primary": {"used_percent": 42.0, "resets_at": 1787201973}, "plan_type": "pro"},
                },
            },
        ])
        results = codex_session_audit.audit(session_dir)
        row = results[0]
        self.assertEqual(row["model"], "gpt-5.6-sol")
        self.assertEqual(row["total_tokens"], 12345)
        self.assertEqual(row["used_percent"], 42.0)
        self.assertEqual(row["resets_at"], 1787201973)
        self.assertEqual(row["plan_type"], "pro")

    def test_later_token_count_event_overwrites_earlier_one(self):
        session_dir = tempfile.mkdtemp()
        write_session(session_dir, "rollout-2026-08-15T09-00-00-xyz.jsonl", [
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 100}}, "rate_limits": {}}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 200}}, "rate_limits": {}}},
        ])
        results = codex_session_audit.audit(session_dir)
        self.assertEqual(results[0]["total_tokens"], 200)


class TestCutoffFiltering(unittest.TestCase):
    def test_sessions_before_cutoff_excluded(self):
        session_dir = tempfile.mkdtemp()
        write_session(session_dir, "rollout-2026-08-15T06-00-00-early.jsonl", [{"type": "session_meta", "payload": {"cwd": "/x"}}])
        write_session(session_dir, "rollout-2026-08-15T09-00-00-late.jsonl", [{"type": "session_meta", "payload": {"cwd": "/x"}}])
        results = codex_session_audit.audit(session_dir, cutoff="2026-08-15T07:39:16")
        files = [r["session_file"] for r in results]
        self.assertNotIn("rollout-2026-08-15T06-00-00-early.jsonl", files)
        self.assertIn("rollout-2026-08-15T09-00-00-late.jsonl", files)

    def test_no_cutoff_includes_everything(self):
        session_dir = tempfile.mkdtemp()
        write_session(session_dir, "rollout-2026-08-15T06-00-00-early.jsonl", [{"type": "session_meta", "payload": {"cwd": "/x"}}])
        results = codex_session_audit.audit(session_dir, cutoff=None)
        self.assertEqual(len(results), 1)


class TestMalformedInput(unittest.TestCase):
    def test_non_json_line_skipped_not_crash(self):
        session_dir = tempfile.mkdtemp()
        path = os.path.join(session_dir, "rollout-2026-08-15T09-00-00-bad.jsonl")
        with open(path, "w") as f:
            f.write("not json at all\n")
            f.write(json.dumps({"type": "session_meta", "payload": {"cwd": "/x"}}) + "\n")
        results = codex_session_audit.audit(session_dir)
        self.assertEqual(len(results), 1)

    def test_non_rollout_files_in_dir_are_ignored(self):
        session_dir = tempfile.mkdtemp()
        with open(os.path.join(session_dir, "not-a-session.txt"), "w") as f:
            f.write("irrelevant")
        results = codex_session_audit.audit(session_dir)
        self.assertEqual(results, [])


if __name__ == "__main__":
    unittest.main()
