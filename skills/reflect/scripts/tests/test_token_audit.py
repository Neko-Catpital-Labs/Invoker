#!/usr/bin/env python3
"""Unit tests for token_audit.py and top_sessions.py.

Run: python3 -m unittest discover -s skills/reflect/scripts/tests -v
(stdlib unittest only - no pytest in this environment)

Fixtures are small synthetic JSONL built inline, not real user transcripts -
these must stay portable and never depend on data outside this repo.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPTS_DIR)

import token_audit  # noqa: E402
import top_sessions  # noqa: E402


def write_jsonl(lines):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
    for d in lines:
        f.write(json.dumps(d) + "\n")
    f.close()
    return f.name


def claude_assistant_line(mid, uuid, content_blocks, usage, model="claude-sonnet-5"):
    return {
        "type": "assistant",
        "uuid": uuid,
        "message": {"id": mid, "model": model, "usage": usage, "content": content_blocks},
    }


class TestClaudeDedup(unittest.TestCase):
    """The core bug this session fixed: Claude Code writes one JSONL line per
    content block (thinking/text/tool_use), but every block sharing a
    message.id carries the SAME usage snapshot. Summing raw lines
    double/triple counts - verified against a real transcript where 299 raw
    lines were only 141 unique messages."""

    def test_three_lines_same_message_id_counted_once(self):
        usage = {"input_tokens": 5, "output_tokens": 100, "cache_read_input_tokens": 200, "cache_creation_input_tokens": 10}
        lines = [
            claude_assistant_line("msg_1", "u1", [{"type": "thinking", "thinking": "..."}], usage),
            claude_assistant_line("msg_1", "u2", [{"type": "text", "text": "hi"}], usage),
            claude_assistant_line("msg_1", "u3", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/a.py"}}], usage),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            out = buf.getvalue()
            self.assertIn("assistant turns: 1", out)
            self.assertIn("output=100", out)
            self.assertIn("cache_read=200", out)
        finally:
            os.unlink(path)

    def test_two_distinct_messages_both_counted(self):
        u1 = {"input_tokens": 1, "output_tokens": 50, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        u2 = {"input_tokens": 1, "output_tokens": 60, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("msg_1", "u1", [{"type": "text", "text": "a"}], u1),
            claude_assistant_line("msg_2", "u2", [{"type": "text", "text": "b"}], u2),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            out = buf.getvalue()
            self.assertIn("assistant turns: 2", out)
            self.assertIn("output=110", out)
        finally:
            os.unlink(path)


class TestRedundantReads(unittest.TestCase):
    def test_read_immediately_followed_by_edit_is_not_thrash(self):
        # Read-before-Edit is required by tool semantics, not redundant.
        u = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/a.py"}}], u),
            claude_assistant_line("m2", "u2", [{"type": "tool_use", "id": "t2", "name": "Edit", "input": {"file_path": "/a.py"}}], u),
            claude_assistant_line("m3", "u3", [{"type": "tool_use", "id": "t3", "name": "Read", "input": {"file_path": "/a.py"}}], u),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            self.assertIn("redundant re-reads (identical window): 0", buf.getvalue())
        finally:
            os.unlink(path)

    def test_read_twice_with_no_edit_is_thrash(self):
        u = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/a.py"}}], u),
            claude_assistant_line("m2", "u2", [{"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/a.py"}}], u),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            self.assertIn("redundant re-reads (identical window): 1", buf.getvalue())
        finally:
            os.unlink(path)

    def test_different_offset_windows_of_same_file_not_thrash(self):
        # Real bug found across 3 independent session reviews: comparing file_path
        # alone flagged normal windowed paging of a large file as "redundant".
        u = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/big.py", "offset": 1, "limit": 200}}], u),
            claude_assistant_line("m2", "u2", [{"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/big.py", "offset": 700, "limit": 90}}], u),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            self.assertIn("redundant re-reads (identical window): 0", buf.getvalue())
        finally:
            os.unlink(path)

    def test_identical_offset_window_read_twice_is_thrash(self):
        u = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {"file_path": "/big.py", "offset": 1, "limit": 200}}], u),
            claude_assistant_line("m2", "u2", [{"type": "tool_use", "id": "t2", "name": "Read", "input": {"file_path": "/big.py", "offset": 1, "limit": 200}}], u),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            self.assertIn("redundant re-reads (identical window): 1", buf.getvalue())
        finally:
            os.unlink(path)


class TestToolErrors(unittest.TestCase):
    def test_error_tool_result_is_flagged(self):
        u = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "false"}}], u),
            {
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": True, "content": "command failed"}]},
            },
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_claude(path)
            self.assertIn("tool errors: 1", buf.getvalue())
        finally:
            os.unlink(path)


class TestModelTierSavings(unittest.TestCase):
    def test_savings_uses_real_published_prices(self):
        # 1M output tokens: sonnet $15.00, haiku $5.00 -> $10 saved.
        actual, cheaper, saved = token_audit.model_tier_savings(1_000_000)
        self.assertAlmostEqual(actual, 15.00, places=2)
        self.assertAlmostEqual(cheaper, 5.00, places=2)
        self.assertAlmostEqual(saved, 10.00, places=2)

    def test_zero_tokens_zero_savings(self):
        actual, cheaper, saved = token_audit.model_tier_savings(0)
        self.assertEqual((actual, cheaper, saved), (0.0, 0.0, 0.0))


class TestCodexAudit(unittest.TestCase):
    def test_reads_token_count_events(self):
        lines = [
            {"type": "session_meta", "payload": {}},
            {
                "type": "event_msg",
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {"input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 10, "total_tokens": 110},
                        "last_token_usage": {"input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 10, "total_tokens": 110},
                    },
                },
            },
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_codex(path)
            out = buf.getvalue()
            self.assertIn("'total_tokens': 110", out)
        finally:
            os.unlink(path)


class TestOmpAudit(unittest.TestCase):
    def test_sums_usage_and_cost(self):
        lines = [
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "model": "gpt-5.5",
                    "usage": {"input": 10, "output": 5, "cacheRead": 20, "cacheWrite": 0, "totalTokens": 35, "cost": {"total": 0.01}},
                },
            },
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_omp(path)
            out = buf.getvalue()
            self.assertIn("total=35", out)
            self.assertIn("$0.0100", out)
        finally:
            os.unlink(path)


class TestTopSessionsScanFunctions(unittest.TestCase):
    """top_sessions.py has its own copy of the Claude dedup fix - test it
    independently so the two scripts can't silently drift apart."""

    def test_scan_claude_dedupes_by_message_id(self):
        usage = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 1, "cache_creation_input_tokens": 1}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "thinking"}], usage),
            claude_assistant_line("m1", "u2", [{"type": "text"}], usage),
        ]
        path = write_jsonl(lines)
        try:
            total = top_sessions.scan_claude(path)
            self.assertEqual(total, 4)  # 1+1+1+1, counted once not twice
        finally:
            os.unlink(path)

    def test_scan_codex_takes_final_cumulative_total(self):
        lines = [
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 100}}}},
            {"type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": {"total_tokens": 250}}}},
        ]
        path = write_jsonl(lines)
        try:
            self.assertEqual(top_sessions.scan_codex(path), 250)
        finally:
            os.unlink(path)

    def test_scan_omp_sums_tokens_and_cost(self):
        lines = [
            {"type": "message", "message": {"usage": {"totalTokens": 30, "cost": {"total": 0.02}}}},
            {"type": "message", "message": {"usage": {"totalTokens": 20, "cost": {"total": 0.01}}}},
        ]
        path = write_jsonl(lines)
        try:
            total, cost = top_sessions.scan_omp(path)
            self.assertEqual(total, 50)
            self.assertAlmostEqual(cost, 0.03, places=4)
        finally:
            os.unlink(path)


def omp_assistant_line(content_blocks, usage=None):
    msg = {"role": "assistant", "content": content_blocks}
    if usage is not None:
        msg["usage"] = usage
    return {"type": "message", "message": msg}


def omp_tool_result_line(call_id, tool_name, is_error=False):
    return {
        "type": "message",
        "message": {"role": "toolResult", "toolCallId": call_id, "toolName": tool_name, "isError": is_error, "content": []},
    }


class TestOmpThrashDetection(unittest.TestCase):
    """Verified against a real OMP session before writing: `read`/`write` name
    the file in arguments.path; `edit` embeds it in an apple-patch header
    inside arguments.input (`[/path/to/file.ts#anchor]`)."""

    def test_read_twice_no_edit_is_redundant(self):
        lines = [
            omp_assistant_line([{"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "/a.ts"}}]),
            omp_assistant_line([{"type": "toolCall", "id": "c2", "name": "read", "arguments": {"path": "/a.ts"}}]),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_omp(path)
            self.assertIn("redundant re-reads: 1", buf.getvalue())
        finally:
            os.unlink(path)

    def test_write_between_reads_clears_redundant_flag(self):
        lines = [
            omp_assistant_line([{"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "/a.ts"}}]),
            omp_assistant_line([{"type": "toolCall", "id": "c2", "name": "write", "arguments": {"path": "/a.ts", "content": "x"}}]),
            omp_assistant_line([{"type": "toolCall", "id": "c3", "name": "read", "arguments": {"path": "/a.ts"}}]),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_omp(path)
            self.assertIn("redundant re-reads: 0", buf.getvalue())
        finally:
            os.unlink(path)

    def test_edit_path_extracted_from_patch_header(self):
        edit_input = "*** Begin Patch\n[/src/main.ts#E1]\ninsert after block 1:\n+x\n"
        lines = [
            omp_assistant_line([{"type": "toolCall", "id": "c1", "name": "read", "arguments": {"path": "/src/main.ts"}}]),
            omp_assistant_line([{"type": "toolCall", "id": "c2", "name": "edit", "arguments": {"input": edit_input}}]),
            omp_assistant_line([{"type": "toolCall", "id": "c3", "name": "read", "arguments": {"path": "/src/main.ts"}}]),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_omp(path)
            # the edit's path was correctly parsed from the patch header, so the
            # second read is NOT flagged as redundant (an edit happened in between)
            self.assertIn("redundant re-reads: 0", buf.getvalue())
        finally:
            os.unlink(path)

    def test_is_error_tool_result_counted(self):
        lines = [
            omp_assistant_line([{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "false"}}]),
            omp_tool_result_line("c1", "bash", is_error=True),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_omp(path)
            self.assertIn("tool errors: 1", buf.getvalue())
        finally:
            os.unlink(path)

    def test_non_error_tool_result_not_counted(self):
        lines = [
            omp_assistant_line([{"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "true"}}]),
            omp_tool_result_line("c1", "bash", is_error=False),
        ]
        path = write_jsonl(lines)
        try:
            buf = io.StringIO()
            with redirect_stdout(buf):
                token_audit.audit_omp(path)
            self.assertIn("tool errors: 0", buf.getvalue())
        finally:
            os.unlink(path)


class TestParseTopBlock(unittest.TestCase):
    def test_parses_rows_from_own_output_format(self):
        text = (
            "scanning 3 claude, 0 codex, 0 omp files\n"
            "done in 1s, 3 sessions with usage data\n"
            "\n=== TOP 12 SESSIONS OVERALL (by total tokens) ===\n"
            "     1,500,000  [claude]  /a/one.jsonl\n"
            "       500,000  [omp]  /a/two.jsonl  ($1.23 OMP-reported)\n"
            "\n=== TOP 3 CLAUDE SESSIONS ===\n"
            "     1,500,000  /a/one.jsonl\n"
        )
        rows = top_sessions.parse_top_block(text)
        self.assertEqual(rows, [
            (1_500_000, "claude", "/a/one.jsonl"),
            (500_000, "omp", "/a/two.jsonl"),
        ])

    def test_empty_text_returns_no_rows(self):
        self.assertEqual(top_sessions.parse_top_block(""), [])


class TestMergeCrossMachine(unittest.TestCase):
    def test_dedupes_two_targets_sharing_one_hostname(self):
        # Real bug found in production: two SSH config entries (remote_1,
        # remote_2) resolved to the identical physical host.
        remote_text = (
            "HOSTNAME=box-a\n"
            "=== TOP 4 SESSIONS OVERALL (by total tokens) ===\n"
            "       900,000  [claude]  /home/invoker/x.jsonl\n"
        )
        remote_outputs = {
            "remote_1": remote_text,
            "remote_2": remote_text,  # same HOSTNAME line -> must be deduped
        }
        local_text = (
            "=== TOP 4 SESSIONS OVERALL (by total tokens) ===\n"
            "     2,000,000  [claude]  /Users/me/a.jsonl\n"
        )
        merged = top_sessions.merge_cross_machine(local_text, remote_outputs)
        targets = [r["target"] for r in merged]
        self.assertEqual(targets.count("remote_1"), 1)
        self.assertEqual(targets.count("remote_2"), 0)
        self.assertEqual(len(merged), 2)

    def test_merged_list_sorted_descending_by_tokens(self):
        remote_outputs = {
            "remote_1": (
                "HOSTNAME=box-a\n"
                "=== TOP 4 SESSIONS OVERALL (by total tokens) ===\n"
                "       900,000  [claude]  /home/invoker/x.jsonl\n"
            ),
        }
        local_text = (
            "=== TOP 4 SESSIONS OVERALL (by total tokens) ===\n"
            "     2,000,000  [claude]  /Users/me/a.jsonl\n"
            "       100,000  [claude]  /Users/me/b.jsonl\n"
        )
        merged = top_sessions.merge_cross_machine(local_text, remote_outputs)
        self.assertEqual([r["tokens"] for r in merged], [2_000_000, 900_000, 100_000])
        self.assertEqual(merged[0]["target"], "local")
        self.assertEqual(merged[1]["hostname"], "box-a")


class TestRunAudits(unittest.TestCase):
    def test_runs_claude_and_omp_audits_and_returns_text_per_path(self):
        u = {"input_tokens": 1, "output_tokens": 5, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        claude_path = write_jsonl([claude_assistant_line("m1", "u1", [{"type": "text", "text": "hi"}], u)])
        omp_path = write_jsonl([
            {"type": "message", "message": {"role": "assistant", "usage": {"input": 1, "output": 2, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 3, "cost": {"total": 0.001}}}},
        ])
        try:
            results = top_sessions.run_audits([("claude", claude_path), ("omp", omp_path)])
            self.assertIn("output=5", results[claude_path])
            self.assertIn("total=3", results[omp_path])
        finally:
            os.unlink(claude_path)
            os.unlink(omp_path)

    def test_writes_ranked_files_when_out_dir_given(self):
        u = {"input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        path = write_jsonl([claude_assistant_line("m1", "u1", [{"type": "text", "text": "hi"}], u)])
        out_dir = tempfile.mkdtemp()
        try:
            top_sessions.run_audits([("claude", path)], out_dir=out_dir)
            written = os.path.join(out_dir, "rank0_claude.txt")
            self.assertTrue(os.path.exists(written))
            with open(written) as f:
                self.assertIn("assistant turns: 1", f.read())
        finally:
            os.unlink(path)
            for f in os.listdir(out_dir):
                os.unlink(os.path.join(out_dir, f))
            os.rmdir(out_dir)

    def test_unknown_kind_reported_as_error_not_raised(self):
        results = top_sessions.run_audits([("bogus", "/nonexistent.jsonl")])
        self.assertIn("ERROR", results["/nonexistent.jsonl"])


if __name__ == "__main__":
    unittest.main()
