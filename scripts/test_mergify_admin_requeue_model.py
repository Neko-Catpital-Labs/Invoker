"""Behavioural tests for ``mergify_admin_requeue_model``.

These tests double as documentation. The requeue worker has to reconstruct the
*real* state of a PR from two messy sources:

  1. Mergify's merge-queue **status comment** — free-text Markdown, no API.
  2. GitHub's **checks** — returned in two different GraphQL shapes.

Every test below feeds a realistic slice of that raw input to one function and
pins the structured value it produces, so a reader can see exactly what each
parser is for and why it exists.

Run:  python3 scripts/test_mergify_admin_requeue_model.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import mergify_admin_requeue_model as m


# --------------------------------------------------------------------------- #
# A realistic Mergify merge-queue status comment.
#
# This is the kind of comment Mergify posts on a PR that is queued but blocked.
# There is no API for "why won't this merge" — the answer only lives here, as
# prose under Markdown headings. The section parsers below all read this body.
# --------------------------------------------------------------------------- #
MERGIFY_COMMENT = """\
## Merge Queue status

The pull request is embarked in the merge queue.

### Waiting for

- all queue conditions to match

### Failing checks

- [ ] [build (ubuntu-latest)](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/123/job/456)
- [ ] [test:all](https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/123/job/789)

### All conditions

- [X] check-success = lint
- [ ] check-success = build (ubuntu-latest)
- [ ] check-success = test:all
- [X] base = master

### Reason

The merge is blocked by failing checks:
- build (ubuntu-latest)
- test:all

<!-- mergify-stack-data: {"stack_id":"stack/demo","pulls":[{"number":3221,"head_sha":"0c55361"}]} -->
"""


class SectionExtraction(unittest.TestCase):
    """Turning headed Markdown prose into per-section lines/items."""

    def test_section_lines_is_scoped_to_one_heading(self):
        # "Waiting for" must yield ONLY its own line, not bleed into the next
        # "### Failing checks" section. Section boundaries = Markdown headings.
        self.assertEqual(
            m.section_lines(MERGIFY_COMMENT, "Waiting for"),
            ("- all queue conditions to match",),
        )

    def test_failing_checks_become_clean_check_names(self):
        # The raw lines are checkbox bullets wrapping Markdown links. We want the
        # bare check names the worker can match against required checks.
        self.assertEqual(
            m.section_items(MERGIFY_COMMENT, "Failing checks"),
            ("build (ubuntu-latest)", "test:all"),
        )

    def test_all_conditions_are_parsed_with_pass_fail_state(self):
        # The "All conditions" checklist is the ground truth for which required
        # checks passed ([X]) vs failed ([ ]). Non check-success rows (base=...)
        # are ignored because they are not checks.
        self.assertEqual(
            m.all_condition_states(MERGIFY_COMMENT),
            (
                ("lint", "success"),
                ("build (ubuntu-latest)", "failure"),
                ("test:all", "failure"),
            ),
        )

    def test_failing_check_urls_pairs_name_with_job_links(self):
        # So a human (or a later step) can jump straight to the failing GitHub
        # Actions job. Each failing check keeps its own run/job URL(s).
        self.assertEqual(
            m.failing_check_urls(MERGIFY_COMMENT),
            (
                (
                    "build (ubuntu-latest)",
                    ("https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/123/job/456",),
                ),
                (
                    "test:all",
                    ("https://github.com/Neko-Catpital-Labs/Invoker/actions/runs/123/job/789",),
                ),
            ),
        )

    def test_reason_failed_checks_only_fires_when_reason_blames_checks(self):
        # The "Reason" section is only mined for check names when it actually
        # says the block is due to failing checks; otherwise we don't guess.
        self.assertEqual(
            m.reason_failed_checks(MERGIFY_COMMENT),
            ("build (ubuntu-latest)", "test:all"),
        )
        no_check_reason = "### Reason\n\nThe base branch was updated.\n- rebase me\n"
        self.assertEqual(m.reason_failed_checks(no_check_reason), ())


class ItemNormalisation(unittest.TestCase):
    """`normalize_check_item` strips the many bullet/link/checkbox wrappers."""

    def test_strips_markdown_link_to_inner_text(self):
        self.assertEqual(m.normalize_check_item("[build](https://x/y)"), "build")

    def test_strips_checkbox_and_bullet(self):
        self.assertEqual(m.normalize_check_item("- [x] lint"), "lint")

    def test_unwraps_check_success_condition(self):
        self.assertEqual(
            m.normalize_check_item("- [ ] check-success = test:all"), "test:all"
        )

    def test_clean_markdown_drops_html_and_emphasis(self):
        self.assertEqual(
            m.clean_markdown("<sub>**bold** _x_</sub>"), "bold x"
        )


class QueueStateAndRule(unittest.TestCase):
    """Reading queued/dequeued and the queue rule from payload or body."""

    def test_state_from_structured_payload(self):
        self.assertEqual(m.payload_state({"state": "dequeued"}, ""), "dequeued")
        self.assertEqual(m.payload_state({"event": "queued"}, ""), "queued")

    def test_state_falls_back_to_comment_text(self):
        # Older Mergify comments carry no machine payload — only prose.
        self.assertEqual(m.payload_state({}, "The PR left the queue."), "dequeued")
        self.assertEqual(m.payload_state({}, "It entered the queue."), "queued")
        self.assertEqual(m.payload_state({}, "nothing relevant"), "unknown")

    def test_rule_from_payload_then_body(self):
        self.assertEqual(m.payload_rule({"queue_rule_name": "default"}, ""), "default")
        self.assertEqual(m.payload_rule({"queue": {"name": "hotfix"}}, ""), "hotfix")
        self.assertEqual(
            m.payload_rule({}, "removed from the queue rule `admin-bypass` now"),
            "admin-bypass",
        )


class StackMarker(unittest.TestCase):
    """Pulling the hidden stack metadata out of the comment."""

    def test_stack_marker_regex_captures_embedded_json(self):
        match = m.STACK_MARKER_RE.search(MERGIFY_COMMENT)
        self.assertIsNotNone(match)
        import json

        data = json.loads(match.group(1))
        self.assertEqual(data["stack_id"], "stack/demo")
        self.assertEqual(data["pulls"][0]["number"], 3221)

    def test_extract_first_json_object_handles_braces_inside_strings(self):
        # The brace/quote state machine must not be fooled by "}" inside a
        # string value, and must stop at the first *balanced* object.
        text = 'noise {"a": "x}y", "b": {"c": 1}} trailing {"d": 2}'
        self.assertEqual(
            m.extract_first_json_object(text), {"a": "x}y", "b": {"c": 1}}
        )
        self.assertIsNone(m.extract_first_json_object("no json here"))


class CheckNormalisation(unittest.TestCase):
    """GitHub returns checks in two shapes; both must flatten to one."""

    def test_check_run_shape(self):
        node = {
            "name": "build",
            "status": "COMPLETED",
            "conclusion": "SUCCESS",
            "detailsUrl": "https://x/run",
            "checkSuite": {"commit": {"oid": "a" * 40}},
            "completedAt": "2026-01-02T00:00:00Z",
        }
        name, state, url, sha, completed = m.norm_check_state(node)
        self.assertEqual(
            (name, state, url, sha, completed),
            ("build", "success", "https://x/run", "a" * 40, "2026-01-02T00:00:00Z"),
        )

    def test_status_context_legacy_shape(self):
        node = {
            "__typename": "StatusContext",
            "context": "ci/legacy",
            "state": "FAILURE",
            "targetUrl": "https://x/legacy",
            "commit": {"oid": "b" * 40},
        }
        name, state, url, sha, _ = m.norm_check_state(node)
        self.assertEqual(
            (name, state, url, sha), ("ci/legacy", "failure", "https://x/legacy", "b" * 40)
        )

    def test_conclusion_word_mapping(self):
        def state(conclusion, status="COMPLETED"):
            return m.norm_check_state(
                {"name": "c", "status": status, "conclusion": conclusion}
            )[1]

        self.assertEqual(state("TIMED_OUT"), "failure")
        self.assertEqual(state("SKIPPED"), "skipped")
        self.assertEqual(state("NEUTRAL"), "neutral")
        self.assertEqual(state("", status="IN_PROGRESS"), "pending")

    def test_latest_contexts_keeps_newest_required_only(self):
        head = "a" * 40
        contexts = [
            # required "build": an old pass, then a newer fail -> newest wins.
            {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS",
             "checkSuite": {"commit": {"oid": head}}, "completedAt": "2026-01-01T00:00:00Z"},
            {"name": "build", "status": "COMPLETED", "conclusion": "FAILURE",
             "checkSuite": {"commit": {"oid": head}}, "completedAt": "2026-01-02T00:00:00Z"},
            # required "test:all" via the legacy status shape.
            {"__typename": "StatusContext", "context": "test:all", "state": "SUCCESS",
             "commit": {"oid": head}},
            # noise that must be dropped:
            {"name": "Summary", "status": "COMPLETED", "conclusion": "SUCCESS",
             "checkSuite": {"commit": {"oid": head}}},          # self check
            {"name": "Rule: admin-bypass", "status": "COMPLETED", "conclusion": "SUCCESS",
             "checkSuite": {"commit": {"oid": head}}},           # mergify rule row
            {"name": "codecov", "status": "COMPLETED", "conclusion": "FAILURE",
             "checkSuite": {"commit": {"oid": head}}},           # not required
            {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS",
             "checkSuite": {"commit": {"oid": "z" * 40}}},        # wrong commit
        ]
        latest = m.latest_contexts_by_required_check(
            contexts, head, required_checks={"build", "test:all", "lint"}
        )
        self.assertEqual(set(latest), {"build", "test:all"})  # "lint" simply absent
        self.assertEqual(latest["build"].state, "failure")    # newest run wins
        self.assertEqual(latest["test:all"].state, "success")


MERGIFY_YML = """\
pull_request_rules:
  - name: admin-bypass
    conditions:
      - base=master
      - label=admin-bypass
    merge_conditions:
      - check-success = lint
      - check-success = build (ubuntu-latest)
    actions:
      queue:
        name: default
  - name: some-other-rule
    conditions:
      - base=master
"""
MERGIFY_YML_WITH_ALIAS = """\
queue_rules:
  - name: default
    merge_conditions: &required_checks
      - check-success = lint
      - check-success = build (ubuntu-latest)
  - name: admin-bypass
    queue_conditions:
      - base=master
      - label=admin-bypass
    merge_conditions: *required_checks
"""



class MergifyRuleLoading(unittest.TestCase):
    """`load_mergify_rules` reads what 'green + landable' means from config."""

    def _write(self, text):
        fd, path = tempfile.mkstemp(suffix=".yml")
        os.close(fd)
        Path(path).write_text(text, encoding="utf-8")
        self.addCleanup(os.unlink, path)
        return Path(path)

    def test_reads_trunk_label_and_required_checks(self):
        trunk, labels, required = m.load_mergify_rules(self._write(MERGIFY_YML))
        self.assertEqual(trunk, "master")
        self.assertEqual(labels, frozenset({"admin-bypass"}))
        self.assertEqual(required, frozenset({"lint", "build (ubuntu-latest)"}))

    def test_reads_required_checks_from_yaml_alias(self):
        trunk, labels, required = m.load_mergify_rules(self._write(MERGIFY_YML_WITH_ALIAS))
        self.assertEqual(trunk, "master")
        self.assertEqual(labels, frozenset({"admin-bypass"}))
        self.assertEqual(required, frozenset({"lint", "build (ubuntu-latest)"}))

    def test_missing_admin_bypass_rule_is_an_error(self):
        with self.assertRaises(ValueError):
            m.load_mergify_rules(self._write("pull_request_rules:\n  - name: other\n"))


class LedgerIdempotency(unittest.TestCase):
    """The ledger stops the worker repeating an action on the same commit."""

    def _ledger_path(self):
        d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(d, ignore_errors=True))
        return Path(d) / "ledger.jsonl"

    def test_record_then_count_and_reload(self):
        path = self._ledger_path()
        led = m.Ledger(path)
        self.assertEqual(led.count("requeue", 3221, "sha1", "flaky"), 0)
        led.record("requeue", 3221, "sha1", "flaky")
        self.assertEqual(led.count("requeue", 3221, "sha1", "flaky"), 1)
        # A different key is a different action -> not counted.
        self.assertEqual(led.count("requeue", 3221, "sha1", "other"), 0)
        # Persisted: a fresh Ledger reads the same row back from disk.
        self.assertEqual(m.Ledger(path).count("requeue", 3221, "sha1", "flaky"), 1)

    def test_has_different_head_detects_new_commit(self):
        path = self._ledger_path()
        led = m.Ledger(path)
        led.record("requeue", 3221, "sha1", "flaky")
        # Same commit -> already handled, do not act again.
        self.assertFalse(led.has_different_head("requeue", 3221, "sha1", "flaky"))
        # New commit pushed -> prior action is stale, acting again is allowed.
        self.assertTrue(led.has_different_head("requeue", 3221, "sha2", "flaky"))

    def test_malformed_ledger_lines_are_skipped(self):
        path = self._ledger_path()
        path.write_text(
            'not json\n'
            '[1, 2, 3]\n'  # valid json, wrong type
            '{"kind": "requeue", "pr": 3221, "headSha": "sha1", "key": "flaky"}\n',
            encoding="utf-8",
        )
        led = m.Ledger(path)
        self.assertEqual(led.count("requeue", 3221, "sha1", "flaky"), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
