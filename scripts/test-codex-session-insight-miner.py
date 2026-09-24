#!/usr/bin/env python3
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MINER_PATH = os.path.join(SCRIPT_DIR, "codex-session-insight-miner.py")
FIXTURES_DIR = os.path.join(SCRIPT_DIR, "fixtures", "codex-session-insight-miner")


def load_miner():
    spec = importlib.util.spec_from_file_location("codex_session_insight_miner", MINER_PATH)
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


class TestExtractExecCommand(unittest.TestCase):
    def test_function_call_exec_command(self):
        payload = {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "pnpm test"})}
        self.assertEqual(miner.extract_exec_command(payload), "pnpm test")

    def test_custom_tool_call_exec(self):
        payload = {
            "type": "custom_tool_call",
            "name": "exec",
            "input": 'const r = await tools.exec_command({cmd:"pytest -q","workdir":"/repo"});',
        }
        self.assertEqual(miner.extract_exec_command(payload), "pytest -q")

    def test_unrelated_payload_returns_empty(self):
        self.assertEqual(miner.extract_exec_command({"type": "message", "role": "assistant"}), "")


class TestSummarizeTypedSignals(unittest.TestCase):
    def test_repeated_exec_and_no_completion_signal_is_rework_without_completed(self):
        session_dir = tempfile.mkdtemp()
        rows = [
            {"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-abc"}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "rg -n foo ."})}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "rg -n foo ."})}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "rg -n foo ."})}},
        ]
        path = write_session(session_dir, "rollout-2026-09-01T10-00-00-rework.jsonl", rows)
        row = miner.summarize(path)
        self.assertEqual(row["rework_signal"], 3)
        self.assertEqual(row["proof_signal"], 0)
        self.assertIsNone(row["completed"])

    def test_task_complete_and_proof_command_are_typed_not_guessed(self):
        session_dir = tempfile.mkdtemp()
        rows = [
            {"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-def"}},
            {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "pnpm test"})}},
            {"type": "event_msg", "payload": {"type": "task_complete", "last_agent_message": "the tests pass now, all good"}},
        ]
        path = write_session(session_dir, "rollout-2026-09-01T10-00-00-proof.jsonl", rows)
        row = miner.summarize(path)
        self.assertEqual(row["proof_signal"], 1)
        self.assertTrue(row["completed"])

    def test_error_event_marks_not_completed(self):
        session_dir = tempfile.mkdtemp()
        rows = [
            {"type": "session_meta", "payload": {"cwd": "/tmp/invoker-scratch-ghi"}},
            {"type": "event_msg", "payload": {"type": "error", "message": "boom"}},
        ]
        path = write_session(session_dir, "rollout-2026-09-01T10-00-00-error.jsonl", rows)
        row = miner.summarize(path)
        self.assertFalse(row["completed"])


class TestAggregateByTaskClass(unittest.TestCase):
    def test_computes_median_p90_and_rates(self):
        rows = [
            {"task_type": "fix-ci-thing", "total_tokens": 100, "completed": True, "proof_signal": 1, "rework_signal": 0},
            {"task_type": "fix-ci-thing", "total_tokens": 200, "completed": False, "proof_signal": 0, "rework_signal": 4},
            {"task_type": "fix-ci-thing", "total_tokens": 300, "completed": None, "proof_signal": 0, "rework_signal": 0},
        ]
        out = miner.aggregate_by_task_class(rows)
        stats = out["fix-ci-thing"]
        self.assertEqual(stats["sessions"], 3)
        self.assertEqual(stats["token_median"], 200)
        self.assertAlmostEqual(stats["completion_rate"], 0.5)
        self.assertEqual(stats["completion_rate_sessions"], 2)
        self.assertAlmostEqual(stats["proof_rate"], 1 / 3)
        self.assertAlmostEqual(stats["rework_rate"], 1 / 3)

    def test_empty_group_returns_none_stats_not_zero(self):
        out = miner.aggregate_by_task_class([{"task_type": "empty-class"}])
        stats = out["empty-class"]
        self.assertIsNone(stats["token_median"])
        self.assertIsNone(stats["completion_rate"])
        self.assertEqual(stats["proof_rate"], 0.0)


class TestPairedReport(unittest.TestCase):
    def test_baseline_optimized_fixtures_show_expected_direction(self):
        baseline_rows = miner.audit(os.path.join(FIXTURES_DIR, "baseline"))
        optimized_rows = miner.audit(os.path.join(FIXTURES_DIR, "optimized"))
        self.assertEqual(len(baseline_rows), 2)
        self.assertEqual(len(optimized_rows), 2)

        report = miner.build_paired_report(baseline_rows, optimized_rows)
        self.assertIn("non_causal_notice", report)
        self.assertIn("not randomly assigned", report["non_causal_notice"])

        stats = report["by_task_class"]["fix-ci-thing"]
        self.assertLess(stats["optimized"]["token_median"], stats["baseline"]["token_median"])
        self.assertGreater(stats["optimized"]["proof_rate"], stats["baseline"]["proof_rate"])
        self.assertGreater(stats["optimized"]["completion_rate"], stats["baseline"]["completion_rate"])
        self.assertGreater(stats["baseline"]["rework_rate"], stats["optimized"]["rework_rate"])
        self.assertLess(stats["delta_token_median"], 0)

    def test_cli_paired_mode_matches_direct_call(self):
        result = subprocess.run(
            [
                sys.executable, MINER_PATH,
                "--baseline-session-dir", os.path.join(FIXTURES_DIR, "baseline"),
                "--optimized-session-dir", os.path.join(FIXTURES_DIR, "optimized"),
            ],
            capture_output=True, text=True, check=True,
        )
        report = json.loads(result.stdout)
        self.assertEqual(report["type"], "session-insight.paired-comparison")
        self.assertEqual(report["baseline_sessions"], 2)
        self.assertEqual(report["optimized_sessions"], 2)


if __name__ == "__main__":
    unittest.main()
