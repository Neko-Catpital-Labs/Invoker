#!/usr/bin/env python3
"""Fixture-based tests for analyze-json-log.py.

Run: python3 scripts/test-analyze-json-log.py
"""
import json
import os
import sys
import tempfile
import unittest
import importlib.util

spec = importlib.util.spec_from_file_location(
    "analyze_json_log", os.path.join(os.path.dirname(os.path.abspath(__file__)), "analyze-json-log.py")
)
analyze_json_log = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyze_json_log)


def write_lines(lines):
    f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
    for d in lines:
        f.write(json.dumps(d) + "\n")
    f.close()
    return f.name


class TestGetPath(unittest.TestCase):
    def test_top_level_field(self):
        self.assertEqual(analyze_json_log.get_path({"a": 1}, "a"), 1)

    def test_dotted_nested_field(self):
        self.assertEqual(analyze_json_log.get_path({"payload": {"type": "x"}}, "payload.type"), "x")

    def test_missing_field_returns_none(self):
        self.assertIsNone(analyze_json_log.get_path({"a": 1}, "b.c"))

    def test_path_through_non_dict_returns_none(self):
        self.assertIsNone(analyze_json_log.get_path({"a": 1}, "a.b"))


class TestTimeField(unittest.TestCase):
    def test_prefers_time_over_timestamp(self):
        self.assertEqual(analyze_json_log.get_time_field({"time": "t1", "timestamp": "t2"}), "t1")

    def test_falls_back_to_timestamp(self):
        self.assertEqual(analyze_json_log.get_time_field({"timestamp": "t2"}), "t2")


class TestReadMatchingLines(unittest.TestCase):
    def test_since_until_window(self):
        path = write_lines([
            {"time": "2026-08-15T10:00:00Z", "msg": "early"},
            {"time": "2026-08-15T10:30:00Z", "msg": "in-window"},
            {"time": "2026-08-15T11:00:00Z", "msg": "late"},
        ])
        matched = list(analyze_json_log.read_matching_lines(path, "2026-08-15T10:15:00Z", "2026-08-15T10:45:00Z", None))
        self.assertEqual(len(matched), 1)
        self.assertEqual(matched[0][0]["msg"], "in-window")

    def test_grep_terms_are_or_matched(self):
        path = write_lines([
            {"time": "t1", "module": "startup"},
            {"time": "t2", "module": "worker"},
            {"time": "t3", "module": "other"},
        ])
        matched = list(analyze_json_log.read_matching_lines(path, None, None, ["startup", "worker"]))
        self.assertEqual(len(matched), 2)

    def test_malformed_line_skipped_not_crash(self):
        f = tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False)
        f.write("not json\n")
        f.write(json.dumps({"time": "t1", "msg": "ok"}) + "\n")
        f.close()
        matched = list(analyze_json_log.read_matching_lines(f.name, None, None, None))
        self.assertEqual(len(matched), 1)

    def test_missing_time_field_excluded_when_bound_given(self):
        path = write_lines([{"msg": "no timestamp at all"}])
        matched = list(analyze_json_log.read_matching_lines(path, "2026-01-01", None, None))
        self.assertEqual(len(matched), 0)


class TestPerMinuteBucketing(unittest.TestCase):
    def test_reproduces_the_real_incident_shape(self):
        # Same shape as the real 2026-08-15 invoker.log incident: many
        # "module":"startup" lines within a minute, few outside it.
        path = write_lines(
            [{"time": f"2026-08-15T10:31:{s:02d}.000Z", "module": "startup"} for s in range(20)]
            + [{"time": "2026-08-15T10:32:00.000Z", "module": "startup"}]
        )
        matched = list(analyze_json_log.read_matching_lines(path, None, None, ["startup"]))
        from collections import Counter
        buckets = Counter()
        for _, ts in matched:
            buckets[ts[:16]] += 1
        self.assertEqual(buckets["2026-08-15T10:31"], 20)
        self.assertEqual(buckets["2026-08-15T10:32"], 1)


if __name__ == "__main__":
    unittest.main()
