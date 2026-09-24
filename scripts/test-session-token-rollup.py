#!/usr/bin/env python3
"""Fixture-based tests for session-token-rollup.py.

Run: python3 scripts/test-session-token-rollup.py
(stdlib unittest only; fixtures under scripts/fixtures/session-token-rollup
are small synthetic Claude/Codex/OMP logs, not real session data.)

Every fixture message body carries the marker SECRET-TEXT-9f3 so the safety
invariant -- only numbers and session ids leave a machine -- is checked by
asserting the marker never reaches collect or merge output. The expected
token numbers below are hand-computed from the fixtures; see each test's
docstring for the arithmetic.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "session-token-rollup.py")
FIXTURES = os.path.join(HERE, "fixtures", "session-token-rollup")
CLAUDE_ROOT = os.path.join(FIXTURES, "claude", "projects")
CLAUDE_ROOT_USAGE = os.path.join(FIXTURES, "claude-root-usage", "projects")
CODEX_ROOT = os.path.join(FIXTURES, "codex", "sessions")
OMP_ROOT = os.path.join(FIXTURES, "omp", "sessions")
MARKER = "SECRET-TEXT-9f3"
SINCE = "2026-09-01"

SESSION_A = "aaaa1111-1111-1111-1111-111111111111"
SESSION_FORK = "cccc3333-3333-3333-3333-333333333333"
SESSION_WORKER = "dddd4444-4444-4444-4444-444444444444"
SESSION_BAD_LINE = "eeee5555-5555-5555-5555-555555555555"
SESSION_ROOT_USAGE = "ffff6666-6666-6666-6666-666666666666"
SESSION_CODEX = "019f0000-1111-2222-3333-444455556666"
SESSION_OMP = "019f9999-aaaa-bbbb-cccc-ddddeeeeffff"
SESSION_PRE_WINDOW = "9999aaaa-0000-0000-0000-000000000000"


def run_script(args, check=True):
    proc = subprocess.run(
        [sys.executable, SCRIPT] + args,
        capture_output=True,
        text=True,
    )
    if check and proc.returncode != 0:
        raise AssertionError(
            "session-token-rollup.py {} exited {}\nstdout:\n{}\nstderr:\n{}".format(
                args, proc.returncode, proc.stdout, proc.stderr
            )
        )
    return proc


def run_collect(host="mac", now="2026-09-23T00:00:00Z", extra_claude_roots=(), session_limit=None, since=SINCE, check=True):
    args = [
        "collect",
        "--since", since,
        "--host", host,
        "--now", now,
        "--claude-root", CLAUDE_ROOT,
        "--codex-root", CODEX_ROOT,
        "--omp-root", OMP_ROOT,
    ]
    for root in extra_claude_roots:
        args += ["--claude-root", root]
    if session_limit is not None:
        args += ["--sessions", str(session_limit)]
    proc = run_script(args, check=check)
    if not check and proc.returncode != 0:
        return proc, None
    return proc, json.loads(proc.stdout)


def claude_root_with_pre_window_session():
    """A root whose only log is a 50900-token turn from before --since."""
    tmp = tempfile.mkdtemp()
    project = os.path.join(tmp, "-home-user-ancient")
    os.makedirs(project)
    row = {
        "type": "assistant",
        "sessionId": SESSION_PRE_WINDOW,
        "timestamp": "2026-01-02T10:00:00.000Z",
        "requestId": "req_old",
        "message": {
            "id": "msg_old",
            "model": "claude-opus-5",
            "usage": {"input_tokens": 50000, "output_tokens": 900},
        },
    }
    with open(os.path.join(project, SESSION_PRE_WINDOW + ".jsonl"), "w") as handle:
        handle.write(json.dumps(row) + "\n")
    return tmp


def sessions_by_id(report):
    return {row["session_id"]: row for row in report["sessions"]}


class TestFixturesCarryTheMarker(unittest.TestCase):
    def test_every_fixture_log_contains_the_marker(self):
        found = []
        for root, _dirs, names in os.walk(FIXTURES):
            for name in names:
                if not name.endswith(".jsonl"):
                    continue
                path = os.path.join(root, name)
                with open(path, errors="replace") as handle:
                    if MARKER in handle.read():
                        found.append(path)
        self.assertEqual(len(found), 8, "expected 8 marker-bearing fixture logs, got {}".format(found))


class TestCollectLeaksNothing(unittest.TestCase):
    def test_marker_absent_from_collect_stdout_and_stderr(self):
        proc, _report = run_collect()
        self.assertNotIn(MARKER, proc.stdout)
        self.assertNotIn(MARKER, proc.stderr)

    def test_no_fixture_message_text_reaches_the_report(self):
        proc, _report = run_collect()
        for phrase in ("please fix", "duplicate stream row", "grep -r", "reminder body", "instructions mentioning"):
            self.assertNotIn(phrase, proc.stdout)


class TestClaudeCollection(unittest.TestCase):
    """Session aaaa1111 bills msg_1 (100/300/200/50) once despite the duplicate
    stream row, plus msg_2 (10/30/20/5), plus its subagent msg_s1 (1000/0/0/100).
    The <synthetic> row and the 2026-08-01 row (before --since) are excluded."""

    def setUp(self):
        _proc, self.report = run_collect()
        self.sessions = sessions_by_id(self.report)

    def test_parent_session_totals_include_subagent_and_dedupe_by_message_id(self):
        row = self.sessions[SESSION_A]
        self.assertEqual(row["tool"], "claude")
        self.assertEqual(row["origin"], "interactive")
        self.assertEqual(row["model"], "claude-opus-5")
        self.assertEqual(row["input"], 1110)
        self.assertEqual(row["cache_read"], 330)
        self.assertEqual(row["cache_write"], 220)
        self.assertEqual(row["output"], 155)
        self.assertEqual(row["total"], 1815)
        self.assertEqual(row["turns"], 3)

    def test_peak_context_compactions_and_notifications(self):
        row = self.sessions[SESSION_A]
        self.assertEqual(row["peak_context"], 1000)
        self.assertEqual(row["compactions"], 1)
        self.assertEqual(row["notification_turns"], 1)
        self.assertEqual(row["first_timestamp"], "2026-09-20T10:00:00.000Z")
        self.assertEqual(row["last_timestamp"], "2026-09-20T11:31:00.000Z")

    def test_subagent_file_is_not_its_own_session(self):
        self.assertNotIn("bbbb2222-2222-2222-2222-222222222222", self.sessions)

    def test_fork_counted_on_parent_and_copied_rows_not_double_billed(self):
        parent = self.sessions[SESSION_A]
        self.assertEqual(parent["fork_count"], 1)
        self.assertEqual(parent["median_fork_start_context"], 500005)
        fork = self.sessions[SESSION_FORK]
        self.assertEqual(fork["input"], 5)
        self.assertEqual(fork["cache_read"], 500000)
        self.assertEqual(fork["output"], 10)
        self.assertEqual(fork["total"], 500015)
        self.assertEqual(fork["turns"], 1)
        self.assertEqual(fork["fork_count"], 0)
        self.assertIsNone(fork["median_fork_start_context"])

    def test_worker_origin_from_project_path(self):
        row = self.sessions[SESSION_WORKER]
        self.assertEqual(row["origin"], "worker")
        self.assertEqual(row["total"], 10)
        self.assertEqual(row["peak_context"], 6)


class TestForkOfAFork(unittest.TestCase):
    """Root R is forked into C, and C is forked again into G. G's log copies
    both R's and C's rows, so a fork must attach to the session it was actually
    forked from: R sees only C (start context 1002) and C sees only G (start
    context 5004). G's own copied rows are never billed to R or C."""

    ROOT = "11110000-0000-0000-0000-000000000001"
    CHILD = "22220000-0000-0000-0000-000000000002"
    GRANDCHILD = "33330000-0000-0000-0000-000000000003"

    def row(self, session_id, message_id, input_tokens, cache_read, output_tokens):
        return {
            "type": "assistant",
            "sessionId": session_id,
            "timestamp": "2026-09-20T10:00:00.000Z",
            "requestId": "req_" + message_id,
            "cwd": "/home/user/forks",
            "message": {
                "id": message_id,
                "role": "assistant",
                "model": "claude-opus-5",
                "content": [{"type": "text", "text": MARKER}],
                "usage": {
                    "input_tokens": input_tokens,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": cache_read,
                    "output_tokens": output_tokens,
                },
            },
        }

    def collect(self):
        tmp = tempfile.mkdtemp()
        project = os.path.join(tmp, "claude", "projects", "-home-user-forks")
        empty = os.path.join(tmp, "empty")
        os.makedirs(project)
        os.makedirs(empty)
        root_row = self.row(self.ROOT, "msg_r", 10, 0, 1)
        child_row = self.row(self.CHILD, "msg_c", 2, 1000, 3)
        logs = {
            self.ROOT: [root_row],
            self.CHILD: [root_row, child_row],
            self.GRANDCHILD: [root_row, child_row, self.row(self.GRANDCHILD, "msg_g", 4, 5000, 5)],
        }
        for session_id, rows in logs.items():
            with open(os.path.join(project, session_id + ".jsonl"), "w") as handle:
                for row in rows:
                    handle.write(json.dumps(row) + "\n")
        proc = run_script([
            "collect", "--since", SINCE, "--host", "mac", "--now", "2026-09-23T00:00:00Z",
            "--claude-root", os.path.join(tmp, "claude", "projects"),
            "--codex-root", empty, "--omp-root", empty,
        ])
        return proc, json.loads(proc.stdout)

    def setUp(self):
        self.proc, self.report = self.collect()
        self.sessions = sessions_by_id(self.report)

    def test_root_counts_only_its_direct_fork(self):
        row = self.sessions[self.ROOT]
        self.assertEqual(row["fork_count"], 1)
        self.assertEqual(row["median_fork_start_context"], 1002)

    def test_intermediate_fork_owns_the_fork_of_a_fork(self):
        row = self.sessions[self.CHILD]
        self.assertEqual(row["fork_count"], 1)
        self.assertEqual(row["median_fork_start_context"], 5004)

    def test_deepest_fork_has_no_forks_of_its_own(self):
        row = self.sessions[self.GRANDCHILD]
        self.assertEqual(row["fork_count"], 0)
        self.assertIsNone(row["median_fork_start_context"])

    def test_copied_rows_are_billed_once_to_their_own_session(self):
        self.assertEqual(self.sessions[self.ROOT]["total"], 11)
        self.assertEqual(self.sessions[self.CHILD]["total"], 1005)
        self.assertEqual(self.sessions[self.GRANDCHILD]["total"], 5009)
        self.assertEqual(self.report["errors"]["forks_without_parent"], 0)

    def test_no_message_text_leaks(self):
        self.assertNotIn(MARKER, self.proc.stdout)


class TestForkOutsideTheWindow(unittest.TestCase):
    """Parent P is forked twice: IN bills a turn inside --since, OLD's own
    turns are all older than --since. Only IN is a fork of P for this window,
    so fork_count is 1 and the median is IN's start context (2001), not the
    1000 the excluded fork would pull it down to."""

    PARENT = "44440000-0000-0000-0000-000000000004"
    IN_WINDOW_FORK = "55550000-0000-0000-0000-000000000005"
    OLD_FORK = "66660000-0000-0000-0000-000000000006"

    def row(self, session_id, message_id, timestamp, input_tokens, cache_read, output_tokens):
        return {
            "type": "assistant",
            "sessionId": session_id,
            "timestamp": timestamp,
            "requestId": "req_" + message_id,
            "cwd": "/home/user/forks",
            "message": {
                "id": message_id,
                "role": "assistant",
                "model": "claude-opus-5",
                "content": [{"type": "text", "text": MARKER}],
                "usage": {
                    "input_tokens": input_tokens,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": cache_read,
                    "output_tokens": output_tokens,
                },
            },
        }

    def collect(self):
        tmp = tempfile.mkdtemp()
        project = os.path.join(tmp, "claude", "projects", "-home-user-forks")
        empty = os.path.join(tmp, "empty")
        os.makedirs(project)
        os.makedirs(empty)
        parent_row = self.row(self.PARENT, "msg_p", "2026-09-20T10:00:00.000Z", 10, 0, 1)
        logs = {
            self.PARENT: [parent_row],
            self.IN_WINDOW_FORK: [
                parent_row,
                self.row(self.IN_WINDOW_FORK, "msg_in", "2026-09-20T11:00:00.000Z", 1, 2000, 3),
            ],
            self.OLD_FORK: [
                parent_row,
                self.row(self.OLD_FORK, "msg_old", "2026-08-01T09:00:00.000Z", 1000, 0, 7),
            ],
        }
        for session_id, rows in logs.items():
            with open(os.path.join(project, session_id + ".jsonl"), "w") as handle:
                for row in rows:
                    handle.write(json.dumps(row) + "\n")
        proc = run_script([
            "collect", "--since", SINCE, "--host", "mac", "--now", "2026-09-23T00:00:00Z",
            "--claude-root", os.path.join(tmp, "claude", "projects"),
            "--codex-root", empty, "--omp-root", empty,
        ])
        return proc, json.loads(proc.stdout)

    def setUp(self):
        self.proc, self.report = self.collect()
        self.sessions = sessions_by_id(self.report)

    def test_parent_counts_only_the_fork_with_an_in_window_turn(self):
        row = self.sessions[self.PARENT]
        self.assertEqual(row["fork_count"], 1)
        self.assertEqual(row["median_fork_start_context"], 2001)

    def test_fork_with_no_in_window_turn_is_not_reported_at_all(self):
        self.assertIn(self.IN_WINDOW_FORK, self.sessions)
        self.assertNotIn(self.OLD_FORK, self.sessions)
        self.assertEqual(self.report["errors"]["forks_without_parent"], 0)

    def test_no_message_text_leaks(self):
        self.assertNotIn(MARKER, self.proc.stdout)


class TestClaudeRootLevelUsage(unittest.TestCase):
    """Legacy Claude logs keep usage/model on the entry root instead of under
    message. Session ffff6666 bills the root-shape row (40/30/20/5) once despite
    the duplicate stream row sharing requestId, plus the two rows that carry no
    message id and no requestId (1/3/2/4 each), for 42/36/24/13. The root-level
    <synthetic> row is excluded."""

    def setUp(self):
        _proc, self.report = run_collect(extra_claude_roots=[CLAUDE_ROOT_USAGE])
        self.sessions = sessions_by_id(self.report)

    def test_root_level_usage_and_model_are_billed(self):
        row = self.sessions[SESSION_ROOT_USAGE]
        self.assertEqual(row["tool"], "claude")
        self.assertEqual(row["model"], "claude-opus-5")
        self.assertEqual(row["input"], 42)
        self.assertEqual(row["cache_read"], 36)
        self.assertEqual(row["cache_write"], 24)
        self.assertEqual(row["output"], 13)
        self.assertEqual(row["total"], 115)
        self.assertEqual(row["turns"], 3)
        self.assertEqual(row["peak_context"], 90)

    def test_root_shape_rows_reach_day_totals(self):
        totals = self.report["totals_by_tool_origin_model_day"]
        self.assertEqual(
            totals["claude|interactive|claude-opus-5|2026-09-20"],
            {"input": 1153, "cache_read": 366, "cache_write": 244, "output": 169, "total": 1932, "turns": 7},
        )

    def test_root_shape_log_leaks_no_message_text(self):
        proc, _report = run_collect(extra_claude_roots=[CLAUDE_ROOT_USAGE])
        self.assertNotIn(MARKER, proc.stdout)
        self.assertNotIn(MARKER, proc.stderr)
        self.assertNotIn("legacy root-shape log", proc.stdout)


class TestCodexCollection(unittest.TestCase):
    """total_token_usage runs 1000/400/100 -> 3000/1400/250 -> 500/100/20.
    Uncached input deltas are 600 + 1000 + 400 = 2000, cached 400 + 1000 + 100
    = 1500, output 100 + 150 + 20 = 270; the third event is a decrease, so it
    starts a new baseline and counts as one compaction."""

    def test_positive_deltas_and_baseline_restart(self):
        _proc, report = run_collect()
        row = sessions_by_id(report)[SESSION_CODEX]
        self.assertEqual(row["tool"], "codex")
        self.assertEqual(row["origin"], "worker")
        self.assertEqual(row["model"], "gpt-5.6-sol")
        self.assertEqual(row["input"], 2000)
        self.assertEqual(row["cache_read"], 1500)
        self.assertEqual(row["cache_write"], 0)
        self.assertEqual(row["output"], 270)
        self.assertEqual(row["total"], 3770)
        self.assertEqual(row["turns"], 3)
        self.assertEqual(row["compactions"], 1)
        self.assertEqual(row["peak_context"], 2000)


class TestCodexMidSessionModelSwitch(unittest.TestCase):
    """A rollout whose first token_count precedes any turn_context, then switches
    model mid-session. Cumulative totals are 100/0/10 -> 300/100/30 -> 600/300/60,
    so the deltas are 100/0/10, 100/100/20 and 100/200/30. The first two turns
    belong to gpt-5.6-sol and the third to gpt-5.7-alto; the pre-turn_context
    turn falls back to the first model seen, not the last."""

    SESSION = "019f1111-2222-3333-4444-555566667777"

    def collect(self):
        tmp = tempfile.mkdtemp()
        codex_root = os.path.join(tmp, "codex", "sessions", "2026", "09", "20")
        empty = os.path.join(tmp, "empty")
        os.makedirs(codex_root)
        os.makedirs(empty)
        rows = [
            {"type": "session_meta", "timestamp": "2026-09-20T09:00:00.000Z",
             "payload": {"cwd": "/Users/dev/code", "instructions": MARKER}},
            {"type": "event_msg", "timestamp": "2026-09-20T09:01:00.000Z",
             "payload": {"type": "token_count", "info": {
                 "total_token_usage": {"input_tokens": 100, "cached_input_tokens": 0,
                                       "output_tokens": 10, "total_tokens": 110},
                 "last_token_usage": {"input_tokens": 100}}}},
            {"type": "turn_context", "timestamp": "2026-09-20T09:01:30.000Z",
             "payload": {"cwd": "/Users/dev/code", "model": "gpt-5.6-sol"}},
            {"type": "event_msg", "timestamp": "2026-09-20T09:02:00.000Z",
             "payload": {"type": "token_count", "info": {
                 "total_token_usage": {"input_tokens": 300, "cached_input_tokens": 100,
                                       "output_tokens": 30, "total_tokens": 430},
                 "last_token_usage": {"input_tokens": 200}}}},
            {"type": "turn_context", "timestamp": "2026-09-20T09:02:30.000Z",
             "payload": {"cwd": "/Users/dev/code", "model": "gpt-5.7-alto"}},
            {"type": "response_item", "timestamp": "2026-09-20T09:02:45.000Z",
             "payload": {"type": "message", "content": [{"type": "text", "text": MARKER}]}},
            {"type": "event_msg", "timestamp": "2026-09-20T09:03:00.000Z",
             "payload": {"type": "token_count", "info": {
                 "total_token_usage": {"input_tokens": 600, "cached_input_tokens": 300,
                                       "output_tokens": 60, "total_tokens": 960},
                 "last_token_usage": {"input_tokens": 300}}}},
        ]
        name = "rollout-2026-09-20T09-00-00-{}.jsonl".format(self.SESSION)
        with open(os.path.join(codex_root, name), "w") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")
        proc = run_script([
            "collect", "--since", SINCE, "--host", "mac", "--now", "2026-09-23T00:00:00Z",
            "--claude-root", empty, "--codex-root", os.path.join(tmp, "codex", "sessions"),
            "--omp-root", empty,
        ])
        return proc, json.loads(proc.stdout)

    def test_each_turn_bills_the_model_in_effect(self):
        _proc, report = self.collect()
        totals = report["totals_by_tool_origin_model_day"]
        self.assertEqual(
            totals["codex|interactive|gpt-5.6-sol|2026-09-20"],
            {"input": 200, "cache_read": 100, "cache_write": 0, "output": 30, "total": 330, "turns": 2},
        )
        self.assertEqual(
            totals["codex|interactive|gpt-5.7-alto|2026-09-20"],
            {"input": 100, "cache_read": 200, "cache_write": 0, "output": 30, "total": 330, "turns": 1},
        )

    def test_session_row_still_sums_every_turn(self):
        _proc, report = self.collect()
        row = sessions_by_id(report)[self.SESSION]
        self.assertEqual(row["total"], 660)
        self.assertEqual(row["turns"], 3)
        self.assertEqual(row["model"], "gpt-5.6-sol")

    def test_no_message_text_leaks(self):
        proc, _report = self.collect()
        self.assertNotIn(MARKER, proc.stdout)


class TestOmpCollection(unittest.TestCase):
    """Two in-window usage rows: 10/20/30/40 and 1/2/3/4. The 2026-08-02 row is
    before --since and is excluded."""

    def test_usage_fields_summed(self):
        _proc, report = run_collect()
        row = sessions_by_id(report)[SESSION_OMP]
        self.assertEqual(row["tool"], "omp")
        self.assertEqual(row["origin"], "worker")
        self.assertEqual(row["model"], "gpt-5.4")
        self.assertEqual(row["input"], 11)
        self.assertEqual(row["output"], 22)
        self.assertEqual(row["cache_read"], 33)
        self.assertEqual(row["cache_write"], 44)
        self.assertEqual(row["total"], 110)
        self.assertEqual(row["turns"], 2)
        self.assertEqual(row["peak_context"], 80)


class TestDayTotalsAndErrors(unittest.TestCase):
    def test_totals_by_tool_origin_model_day(self):
        _proc, report = run_collect()
        totals = report["totals_by_tool_origin_model_day"]
        self.assertEqual(
            totals["claude|interactive|claude-opus-5|2026-09-20"],
            {"input": 1111, "cache_read": 330, "cache_write": 220, "output": 156, "total": 1817, "turns": 4},
        )
        self.assertEqual(
            totals["claude|interactive|claude-opus-5|2026-09-22"],
            {"input": 5, "cache_read": 500000, "cache_write": 0, "output": 10, "total": 500015, "turns": 1},
        )
        self.assertEqual(
            totals["claude|worker|claude-opus-5|2026-09-21"],
            {"input": 1, "cache_read": 3, "cache_write": 2, "output": 4, "total": 10, "turns": 1},
        )
        self.assertEqual(
            totals["codex|worker|gpt-5.6-sol|2026-09-20"],
            {"input": 2000, "cache_read": 1500, "cache_write": 0, "output": 270, "total": 3770, "turns": 3},
        )
        self.assertEqual(
            totals["omp|worker|gpt-5.4|2026-09-20"],
            {"input": 11, "cache_read": 33, "cache_write": 44, "output": 22, "total": 110, "turns": 2},
        )
        self.assertEqual(sum(v["total"] for v in totals.values()), 505722)

    def test_bad_json_line_counted_and_rest_of_file_still_read(self):
        _proc, report = run_collect()
        self.assertEqual(report["errors"]["bad_json_lines"], 1)
        self.assertEqual(sessions_by_id(report)[SESSION_BAD_LINE]["total"], 2)

    def test_unreadable_file_counted_not_dropped(self):
        tmp = tempfile.mkdtemp()
        project = os.path.join(tmp, "-home-user-missing")
        os.makedirs(project)
        os.symlink(os.path.join(tmp, "nowhere"), os.path.join(project, "ffff6666.jsonl"))
        _proc, report = run_collect(extra_claude_roots=[tmp])
        self.assertEqual(report["errors"]["unreadable_files"], 1)
        self.assertEqual(report["files"], 8)

    def test_report_header_fields(self):
        _proc, report = run_collect()
        self.assertEqual(report["host"], "mac")
        self.assertEqual(report["since"], SINCE)
        self.assertEqual(report["generatedAt"], "2026-09-23T00:00:00Z")
        self.assertEqual(len(report["sessions"]), 6)
        self.assertEqual(report["session_count"], 6)


class TestSessionsOutsideTheWindow(unittest.TestCase):
    """A log whose only turn predates --since must not become a zero-token
    session record, and must not be counted as a session on that machine."""

    def setUp(self):
        self.extra = claude_root_with_pre_window_session()
        _proc, self.report = run_collect(extra_claude_roots=[self.extra])

    def test_file_is_still_read_but_emits_no_session_record(self):
        self.assertEqual(self.report["files"], 8)
        self.assertNotIn(SESSION_PRE_WINDOW, sessions_by_id(self.report))
        self.assertEqual(len(self.report["sessions"]), 6)
        self.assertEqual(self.report["session_count"], 6)

    def test_pre_window_tokens_are_not_billed(self):
        self.assertEqual(
            sum(v["total"] for v in self.report["totals_by_tool_origin_model_day"].values()),
            505722,
        )

    def test_machine_session_count_excludes_it(self):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "mac.json")
        with open(path, "w") as handle:
            json.dump(self.report, handle)
        merged = json.loads(
            run_script(["merge", path, "--now", "2026-09-23T12:00:00Z", "--json"]).stdout
        )
        self.assertEqual(merged["machines"]["mac"]["sessions"], 6)
        self.assertEqual(merged["machines"]["mac"]["total"], 505722)


class TestMachineSessionCount(unittest.TestCase):
    def merged_for(self, report):
        tmp = tempfile.mkdtemp()
        path = os.path.join(tmp, "mac.json")
        with open(path, "w") as handle:
            json.dump(report, handle)
        return json.loads(
            run_script(["merge", path, "--now", "2026-09-23T12:00:00Z", "--json"]).stdout
        )

    def test_count_survives_the_emitted_session_limit(self):
        _proc, report = run_collect(session_limit=2)
        self.assertEqual(len(report["sessions"]), 2)
        self.assertEqual(report["session_count"], 6)
        merged = self.merged_for(report)
        self.assertEqual(merged["machines"]["mac"]["total"], 505722)
        self.assertEqual(merged["machines"]["mac"]["sessions"], 6)

    def test_report_without_session_count_falls_back_to_the_list(self):
        _proc, report = run_collect()
        del report["session_count"]
        self.assertEqual(self.merged_for(report)["machines"]["mac"]["sessions"], 6)


class TestSinceIsValidatedAndNormalized(unittest.TestCase):
    """--since is parsed as a date, so an unpadded day still selects the window.

    in_window compares timestamp[:10] >= since as strings, so an unpadded
    "2026-9-1" would sort above every "2026-09-.." timestamp and silently
    drop every dated turn, leaving a near-zero report that still exits 0.
    """

    def test_unpadded_since_selects_the_same_window_as_the_padded_form(self):
        _proc, padded = run_collect()
        _proc, unpadded = run_collect(since="2026-9-1")
        self.assertEqual(unpadded["session_count"], padded["session_count"])
        self.assertEqual(unpadded["sessions"], padded["sessions"])
        self.assertEqual(
            unpadded["totals_by_tool_origin_model_day"],
            padded["totals_by_tool_origin_model_day"],
        )

    def test_unpadded_since_is_normalized_in_the_report(self):
        _proc, report = run_collect(since="2026-9-1")
        self.assertEqual(report["since"], SINCE)

    def test_invalid_since_exits_nonzero_instead_of_an_empty_report(self):
        proc, report = run_collect(since="banana", check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIsNone(report)
        self.assertIn("YYYY-MM-DD", proc.stderr)
        self.assertNotIn("session_count", proc.stdout)

    def test_impossible_calendar_day_is_rejected(self):
        proc, _report = run_collect(since="2026-02-30", check=False)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("YYYY-MM-DD", proc.stderr)


class TestMerge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.mac = os.path.join(self.tmp, "mac.json")
        self.do1 = os.path.join(self.tmp, "do1.json")
        self.stale = os.path.join(self.tmp, "stale.json")
        _proc, mac_report = run_collect(host="mac", now="2026-09-23T00:00:00Z")
        _proc, do1_report = run_collect(host="do1", now="2026-09-22T00:00:00Z")
        stale_report = dict(mac_report)
        stale_report["host"] = "old-droplet"
        stale_report["generatedAt"] = "2026-09-01T00:00:00Z"
        for path, payload in ((self.mac, mac_report), (self.do1, do1_report), (self.stale, stale_report)):
            with open(path, "w") as handle:
                json.dump(payload, handle)

    def merge(self, extra=()):
        args = ["merge", self.mac, self.do1, self.stale, "--now", "2026-09-23T12:00:00Z"] + list(extra)
        return run_script(args)

    def test_marker_absent_from_merge_output(self):
        proc = self.merge()
        self.assertNotIn(MARKER, proc.stdout)
        self.assertNotIn(MARKER, proc.stderr)

    def test_per_machine_totals_and_top_sessions(self):
        proc = self.merge(["--json"])
        merged = json.loads(proc.stdout)
        self.assertEqual(merged["machines"]["mac"]["total"], 505722)
        self.assertEqual(merged["machines"]["do1"]["total"], 505722)
        self.assertNotIn("old-droplet", merged["machines"])
        self.assertEqual(len(merged["top_sessions"]), 10)
        top = merged["top_sessions"][0]
        self.assertEqual(top["total"], 500015)
        self.assertEqual(top["session_id"], SESSION_FORK)
        self.assertIn(top["host"], ("mac", "do1"))

    def test_stale_report_is_reported_not_merged(self):
        proc = self.merge(["--json"])
        merged = json.loads(proc.stdout)
        self.assertEqual(len(merged["skipped"]), 1)
        self.assertEqual(merged["skipped"][0]["host"], "old-droplet")
        self.assertEqual(merged["skipped"][0]["reason"], "too-old")
        self.assertEqual(len(merged["reports"]), 2)
        self.assertIn("too old", self.merge().stdout)

    def test_top_flag_limits_ranked_sessions(self):
        merged = json.loads(self.merge(["--json", "--top", "3"]).stdout)
        self.assertEqual(len(merged["top_sessions"]), 3)
        totals = [row["total"] for row in merged["top_sessions"]]
        self.assertEqual(totals, sorted(totals, reverse=True))

    def test_text_output_shows_machine_totals(self):
        text = self.merge().stdout
        self.assertIn("mac", text)
        self.assertIn("505722", text)
        self.assertIn(SESSION_FORK, text)


class TestMergeSupersededReports(unittest.TestCase):
    """Two in-window reports from the same host must not be added together:
    the newest wins, the older is listed in skipped as superseded, and its
    sessions must not appear a second time in the ranking."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        _proc, yesterday = run_collect(host="do1", now="2026-09-22T00:00:00Z")
        _proc, today = run_collect(host="do1", now="2026-09-23T00:00:00Z")
        self.yesterday = os.path.join(self.tmp, "do1-yesterday.json")
        self.today = os.path.join(self.tmp, "do1-today.json")
        for path, payload in ((self.yesterday, yesterday), (self.today, today)):
            with open(path, "w") as handle:
                json.dump(payload, handle)

    def merge(self, extra=()):
        args = ["merge", self.yesterday, self.today, "--now", "2026-09-23T12:00:00Z"] + list(extra)
        return run_script(args)

    def test_totals_are_not_doubled(self):
        merged = json.loads(self.merge(["--json"]).stdout)
        self.assertEqual(merged["machines"]["do1"]["total"], 505722)
        self.assertEqual(merged["machines"]["do1"]["sessions"], 6)

    def test_only_the_newest_report_is_merged(self):
        merged = json.loads(self.merge(["--json"]).stdout)
        self.assertEqual(len(merged["reports"]), 1)
        self.assertEqual(merged["reports"][0]["path"], self.today)
        self.assertEqual(merged["reports"][0]["generatedAt"], "2026-09-23T00:00:00Z")

    def test_older_report_is_skipped_as_superseded(self):
        merged = json.loads(self.merge(["--json"]).stdout)
        self.assertEqual(len(merged["skipped"]), 1)
        skipped = merged["skipped"][0]
        self.assertEqual(skipped["path"], self.yesterday)
        self.assertEqual(skipped["host"], "do1")
        self.assertEqual(skipped["generatedAt"], "2026-09-22T00:00:00Z")
        self.assertEqual(skipped["reason"], "superseded")
        self.assertIn("superseded", self.merge().stdout)

    def test_sessions_are_ranked_once(self):
        merged = json.loads(self.merge(["--json", "--top", "50"]).stdout)
        keys = [(row["host"], row["session_id"]) for row in merged["top_sessions"]]
        self.assertEqual(len(keys), 6)
        self.assertEqual(len(set(keys)), len(keys))

    def test_argument_order_does_not_change_the_winner(self):
        reversed_args = ["merge", self.today, self.yesterday, "--now", "2026-09-23T12:00:00Z", "--json"]
        merged = json.loads(run_script(reversed_args).stdout)
        self.assertEqual(merged["reports"][0]["path"], self.today)
        self.assertEqual(merged["skipped"][0]["path"], self.yesterday)
        self.assertEqual(merged["machines"]["do1"]["total"], 505722)

    def test_a_second_host_is_still_merged_alongside(self):
        _proc, mac_report = run_collect(host="mac", now="2026-09-23T00:00:00Z")
        mac = os.path.join(self.tmp, "mac.json")
        with open(mac, "w") as handle:
            json.dump(mac_report, handle)
        args = ["merge", self.yesterday, self.today, mac, "--now", "2026-09-23T12:00:00Z", "--json"]
        merged = json.loads(run_script(args).stdout)
        self.assertEqual(sorted(merged["machines"]), ["do1", "mac"])
        self.assertEqual(merged["machines"]["mac"]["total"], 505722)
        self.assertEqual(merged["machines"]["do1"]["total"], 505722)


if __name__ == "__main__":
    unittest.main()
