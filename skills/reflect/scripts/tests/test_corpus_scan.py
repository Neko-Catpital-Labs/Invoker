#!/usr/bin/env python3
"""Unit tests for corpus_scan.py.

Run: python3 -m unittest discover -s skills/reflect/scripts/tests -v
(stdlib unittest only - no pytest in this environment)

Covers the pure/deterministic pieces only - no SSH, no real transcripts.
The two things worth locking down: (1) remote_scan_command's OUTPUT is
exactly what gets executed when --confirm-remote-scan is passed, since
that's the "show the exact command" transparency guarantee the skill
promises; (2) bucket_summary actually flags concurrent-host bursts, since
that's the whole reason this script exists over token_audit.py/
top_sessions.py.
"""
import os
import sys
import unittest

SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, SCRIPTS_DIR)

import corpus_scan  # noqa: E402


class TestMtimeMinutes(unittest.TestCase):
    def test_whole_hours(self):
        self.assertEqual(corpus_scan._mtime_minutes(24), 1440)
        self.assertEqual(corpus_scan._mtime_minutes(1), 60)

    def test_fractional_hours_round_not_truncate(self):
        # 0.5h must become a plain int minute count find(1) accepts on both
        # BSD (bfs) and GNU find - a fractional -mtime silently matches
        # nothing (the bug this function exists to prevent).
        self.assertEqual(corpus_scan._mtime_minutes(0.5), 30)
        self.assertIsInstance(corpus_scan._mtime_minutes(0.5), int)

    def test_never_zero(self):
        self.assertGreaterEqual(corpus_scan._mtime_minutes(0.001), 1)


class TestRemoteScanCommand(unittest.TestCase):
    def setUp(self):
        self.target = {"host": "1.2.3.4", "user": "invoker", "sshKeyPath": "/k"}

    def test_uses_mmin_not_mtime(self):
        cmd = corpus_scan.remote_scan_command(self.target, "e2e", 24)
        script = cmd[-1]
        self.assertIn("-mmin -1440", script)
        self.assertNotIn("-mtime", script)

    def test_ssh_args_from_target_config(self):
        cmd = corpus_scan.remote_scan_command(self.target, "e2e", 1)
        self.assertEqual(cmd[0], "ssh")
        self.assertIn("-i", cmd)
        self.assertIn("/k", cmd)
        self.assertIn("invoker@1.2.3.4", cmd)

    def test_pattern_is_embedded_verbatim(self):
        cmd = corpus_scan.remote_scan_command(self.target, "e2e|playwright", 24)
        self.assertIn("e2e|playwright", cmd[-1])

    def test_read_only_no_write_commands(self):
        # `2>/dev/null` (discarding stderr) is fine and expected; nothing
        # here should write real output anywhere or reach out over the
        # network beyond the single already-open ssh session.
        cmd = corpus_scan.remote_scan_command(self.target, "e2e", 24)
        script = cmd[-1]
        for banned in ("rm ", "mv ", "scp", "curl", "wget"):
            self.assertNotIn(banned, script)
        self.assertNotIn(">/dev/null 2>&1 &", script)  # no backgrounding/detaching either

    def test_stderr_discarded_not_a_real_write(self):
        cmd = corpus_scan.remote_scan_command(self.target, "e2e", 24)
        script = cmd[-1]
        # every '>' in this script is a `2>/dev/null` stderr discard
        for m in __import__("re").finditer(r"[^2]>", script):
            self.fail(f"found a non-stderr redirect at {m.start()}: {script[max(0,m.start()-10):m.start()+10]!r}")


class TestBucketSummary(unittest.TestCase):
    def test_detects_concurrent_multi_host_burst(self):
        results = [
            {"host": "remote_digital_ocean_1", "ts_raw": "2026-08-15T07-37-08-abc"},
            {"host": "remote_digital_ocean_3", "ts_raw": "2026-08-15T07-38-01-abc"},
            {"host": "remote_digital_ocean_6", "ts_raw": "2026-08-15T07-38-23-abc"},
            {"host": "remote_digital_ocean_4", "ts_raw": "2026-08-15T09-10-00-abc"},  # isolated
        ]
        buckets = corpus_scan.bucket_summary(results, bucket_minutes=15)
        # three of four sessions land in the same 07:30 bucket, one each host
        same_window = [k for k in buckets if k[1] == "07" and k[2] == "30"]
        self.assertEqual(len(same_window), 3)
        for k in same_window:
            self.assertEqual(len(buckets[k]), 1)  # one session per host in that bucket
        isolated = [k for k in buckets if k[1] == "09"]
        self.assertEqual(len(isolated), 1)

    def test_ignores_entries_without_timestamp(self):
        results = [{"host": "local", "ts_raw": None}]
        buckets = corpus_scan.bucket_summary(results)
        self.assertEqual(len(buckets), 0)


if __name__ == "__main__":
    unittest.main()
