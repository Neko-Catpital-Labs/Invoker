#!/usr/bin/env python3
"""Unit tests for subagent_cost.py.

Run: python3 -m unittest discover -s skills/reflect/scripts/tests -v
(stdlib unittest only - no pytest in this environment)

Fixtures are small synthetic JSONL built inline, not real user transcripts.
"""
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPTS_DIR)

import subagent_cost  # noqa: E402


def claude_assistant_line(mid, uuid, content_blocks, usage, model="claude-sonnet-5", timestamp=None):
    d = {
        "type": "assistant",
        "uuid": uuid,
        "message": {"id": mid, "model": model, "usage": usage, "content": content_blocks},
    }
    if timestamp:
        d["timestamp"] = timestamp
    return d


def write_agent_transcript(subagents_dir, agent_id, lines, description=None):
    path = os.path.join(subagents_dir, f"agent-{agent_id}.jsonl")
    with open(path, "w") as f:
        for d in lines:
            f.write(json.dumps(d) + "\n")
    if description is not None:
        meta_path = os.path.join(subagents_dir, f"agent-{agent_id}.meta.json")
        with open(meta_path, "w") as f:
            json.dump({"description": description}, f)
    return path


class TestResolveSubagentsDir(unittest.TestCase):
    def test_accepts_session_jsonl_path(self):
        result = subagent_cost.resolve_subagents_dir("/x/y/session-abc.jsonl")
        self.assertEqual(result, "/x/y/session-abc/subagents")

    def test_accepts_session_dir_directly(self):
        result = subagent_cost.resolve_subagents_dir("/x/y/session-abc")
        self.assertEqual(result, "/x/y/session-abc/subagents")


class TestSumSubagentCost(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.session_dir = os.path.join(self.root, "session-abc")
        self.subagents_dir = os.path.join(self.session_dir, "subagents")
        os.makedirs(self.subagents_dir)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_missing_subagents_dir_returns_none(self):
        empty_session_dir = os.path.join(self.root, "no-subagents-here")
        os.makedirs(empty_session_dir)
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = subagent_cost.sum_subagent_cost(empty_session_dir)
        self.assertIsNone(result)
        self.assertIn("No subagents/ directory found", buf.getvalue())

    def test_empty_subagents_dir_returns_none(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = subagent_cost.sum_subagent_cost(self.session_dir)
        self.assertIsNone(result)
        self.assertIn("no agent-*.jsonl files", buf.getvalue())

    def test_sums_tokens_across_multiple_agent_transcripts(self):
        usage_a = {"input_tokens": 1, "output_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        usage_b = {"input_tokens": 1, "output_tokens": 900, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        write_agent_transcript(
            self.subagents_dir, "aaa",
            [claude_assistant_line("m1", "u1", [{"type": "text", "text": "x"}], usage_a)],
            description="Agent A",
        )
        write_agent_transcript(
            self.subagents_dir, "bbb",
            [claude_assistant_line("m2", "u2", [{"type": "text", "text": "y"}], usage_b)],
            description="Agent B",
        )
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = subagent_cost.sum_subagent_cost(self.session_dir)
        self.assertEqual(result, 1002)  # 101 + 901
        out = buf.getvalue()
        self.assertIn("GRAND TOTAL: 1,002 tokens across 2 subagent(s)", out)
        self.assertIn("Agent A", out)
        self.assertIn("Agent B", out)

    def test_dedupes_by_message_id_reusing_audit_claude_logic(self):
        # Same correctness property token_audit.py's own tests guard: three
        # content blocks sharing one message.id must count usage once, not
        # three times. If subagent_cost.py ever stops routing through
        # audit_claude(), this regresses silently.
        usage = {"input_tokens": 5, "output_tokens": 100, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        lines = [
            claude_assistant_line("m1", "u1", [{"type": "thinking", "thinking": "..."}], usage),
            claude_assistant_line("m1", "u2", [{"type": "text", "text": "hi"}], usage),
            claude_assistant_line("m1", "u3", [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}], usage),
        ]
        write_agent_transcript(self.subagents_dir, "ccc", lines, description="Dedup check")
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = subagent_cost.sum_subagent_cost(self.session_dir)
        self.assertEqual(result, 105)  # 5 + 100, once, not x3

    def test_missing_meta_json_does_not_crash(self):
        usage = {"input_tokens": 1, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        write_agent_transcript(
            self.subagents_dir, "nodesc",
            [claude_assistant_line("m1", "u1", [{"type": "text", "text": "x"}], usage)],
            description=None,
        )
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = subagent_cost.sum_subagent_cost(self.session_dir)
        self.assertEqual(result, 11)
        self.assertIn("(no meta.json description)", buf.getvalue())

    def test_reproduces_the_bug_this_script_prevents(self):
        """The exact incident this tool exists to stop: a top-level session
        file sharing a UUID-shaped name with this session's own scratch
        directory, but with no real relationship, must never be silently
        summed in. sum_subagent_cost only ever reads <dir>/subagents/*.jsonl
        - a same-named-but-unrelated file sitting elsewhere is invisible to
        it by construction. This test proves that invisibility, not just
        assert it."""
        unrelated_file = os.path.join(self.root, "unrelated-huge-session.jsonl")
        huge_usage = {"input_tokens": 1, "output_tokens": 999_999, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        with open(unrelated_file, "w") as f:
            f.write(json.dumps(claude_assistant_line("m1", "u1", [{"type": "text", "text": "x"}], huge_usage)) + "\n")

        usage = {"input_tokens": 1, "output_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
        write_agent_transcript(
            self.subagents_dir, "real",
            [claude_assistant_line("m1", "u1", [{"type": "text", "text": "x"}], usage)],
            description="Real subagent",
        )
        buf = io.StringIO()
        with redirect_stdout(buf):
            result = subagent_cost.sum_subagent_cost(self.session_dir)
        self.assertEqual(result, 11)  # NOT 1,000,010 - the unrelated file is never touched


if __name__ == "__main__":
    unittest.main()
