#!/usr/bin/env python3
import importlib.util
import json
import os
import sys
import tempfile
import unittest


def load_miner():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "codex-session-insight-miner.py")
    spec = importlib.util.spec_from_file_location("codex_session_insight_miner", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


miner = load_miner()


def write_session(session_dir, filename, lines):
    path = os.path.join(session_dir, filename)
    with open(path, "w") as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")
    return path


class TestClassify(unittest.TestCase):
    def test_worktree_cwd_parses_workflow_and_task(self):
        cwd = (
            "/home/invoker/.invoker/worktrees/abc/"
            "experiment-wf-1786788062899-48-fix-ci-2363032-required-fast-vitest-workspace-g0.t0.a-a88bbe6d1"
        )
        workflow_id, task_type = miner.classify(cwd)
        self.assertEqual(workflow_id, "wf-1786788062899-48")
        self.assertEqual(task_type, "fix-ci-2363032-required-fast-vitest-workspace")

    def test_scratch_cwd(self):
        workflow_id, task_type = miner.classify("/tmp/invoker-scratch-abc123")
        self.assertIsNone(workflow_id)
        self.assertEqual(task_type, "scratch")

    def test_merge_clone_cwd(self):
        cwd = "/home/invoker/.invoker/merge-clones/gate-__merge__wf-1788212196049-2-2nmCSk"
        workflow_id, task_type = miner.classify(cwd)
        self.assertEqual(workflow_id, "wf-1788212196049-2")
        self.assertEqual(task_type, "merge-clone")

    def test_unknown_cwd(self):
        workflow_id, task_type = miner.classify("/some/other/path")
        self.assertIsNone(workflow_id)
        self.assertEqual(task_type, "unknown")


class TestSummarize(unittest.TestCase):
    def test_extracts_tokens_model_and_prompt_type(self):
        session_dir = tempfile.mkdtemp()
        write_session(
            session_dir,
            "rollout-2026-08-31T20-00-00-abc123.jsonl",
            [
                {"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-abc123"}},
                {"type": "turn_context", "payload": {"model": "gpt-5.6-sol"}},
                {"type": "response_item", "payload": {"role": "user", "content": [{"text": "<recommended_plugins>"}]}},
                {
                    "type": "response_item",
                    "payload": {
                        "role": "user",
                        "content": [{"text": "Assume zero prior context. Investigate a production repair-filings finding: delete stale row."}],
                    },
                },
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {"total_token_usage": {"total_tokens": 12345}},
                        "rate_limits": {"primary": {"used_percent": 42.0}, "plan_type": "pro"},
                    },
                },
            ],
        )
        path = os.path.join(session_dir, "rollout-2026-08-31T20-00-00-abc123.jsonl")
        row = miner.summarize(path)
        self.assertEqual(row["task_type"], "scratch")
        self.assertEqual(row["model"], "gpt-5.6-sol")
        self.assertEqual(row["total_tokens"], 12345)
        self.assertEqual(row["prompt_type"], "repair-filing-delete")

    def test_missing_payload_info_does_not_crash(self):
        session_dir = tempfile.mkdtemp()
        write_session(
            session_dir,
            "rollout-2026-08-31T20-00-00-sparse.jsonl",
            [
                {"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-xyz"}},
                {"type": "event_msg", "payload": {"type": "token_count", "info": None}},
            ],
        )
        path = os.path.join(session_dir, "rollout-2026-08-31T20-00-00-sparse.jsonl")
        row = miner.summarize(path)
        self.assertEqual(row["task_type"], "scratch")
        self.assertIsNone(row["total_tokens"])


class TestAudit(unittest.TestCase):
    def test_filters_by_cutoff(self):
        session_dir = tempfile.mkdtemp()
        write_session(
            session_dir,
            "rollout-2026-08-31T06-00-00-early.jsonl",
            [{"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-early"}}],
        )
        write_session(
            session_dir,
            "rollout-2026-08-31T20-00-00-late.jsonl",
            [{"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-late"}}],
        )
        results = miner.audit(session_dir, cutoff="2026-08-31T07:00:00")
        files = [r["session_file"] for r in results]
        self.assertNotIn("rollout-2026-08-31T06-00-00-early.jsonl", files)
        self.assertIn("rollout-2026-08-31T20-00-00-late.jsonl", files)


class TestHtmlOutput(unittest.TestCase):
    def test_build_html_contains_summary(self):
        html = miner.build_html(
            [
                {"session_file": "x", "date": "2026-08-31", "task_type": "scratch", "model": "gpt-5.6-sol", "total_tokens": 12345, "prompt_type": "repair-filing-delete", "prompt_snippet": ""},
            ],
            "test",
            "2026-08-31T00:00:00Z",
        )
        self.assertIn("Measured tokens", html)
        self.assertIn("repair-filing-delete", html)


if __name__ == "__main__":
    unittest.main()
