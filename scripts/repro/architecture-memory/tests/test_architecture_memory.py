"""Focused unit tests for the paired evaluator. No model calls, no snapshots.

    python3 -m unittest discover -s scripts/repro/architecture-memory/tests \
        -t scripts/repro/architecture-memory
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[2]
sys.path.insert(0, str(ROOT))

from amlib import config, isolation, manifest, records  # noqa: E402
from amlib.checks import Results  # noqa: E402
from amlib.ledger import AttemptAlreadyRecorded, AttemptLedger, new_attempt  # noqa: E402
from amlib.report import render  # noqa: E402
from amlib.util import sha256_bytes, strip_ansi  # noqa: E402


def minimal_record(**overrides) -> dict:
    arm = {
        "variant": "baseline",
        "status": "completed",
        "exit_code": 0,
        "wall_seconds": 12.0,
        "diff_sha256": "a" * 64,
        "diff_bytes": 40,
        "patch_file": "pair-x-baseline.patch",
        "telemetry": {"cost_usd": 1.5, "cost_telemetry": "native", "tokens": {"input": 1}},
        "grade": {"passed": True, "checks": []},
    }
    record = {
        "schema": records.SCHEMA,
        "experiment_id": manifest.EXPERIMENT_ID,
        "pair_id": "x",
        "created_at": records.now(),
        "provenance": {
            "source_commit": manifest.EXPERIMENT_SOURCE_COMMIT,
            "archive_sha256": "b" * 64,
            "manifest_sha256": "c" * 64,
            "grader_sha256": "d" * 64,
            "structural_delta_sha256": "e" * 64,
            "prompt_sha256": "f" * 64,
            "runners_sha256": "0" * 64,
            "redactions": list(manifest.TRIAL_WORKSPACE_REDACTIONS),
            "snapshots": {
                "baseline": {"source_tree_sha256": "1" * 64, "target_file_sha256": "2" * 64},
                "treatment": {"source_tree_sha256": "3" * 64, "target_file_sha256": "4" * 64},
            },
        },
        "structural_delta_summary": manifest.STRUCTURAL_DELTA["summary"],
        "configuration": {
            "baseline": {"runner": "claude", "version": "v", "model": "m", "effort": "high",
                         "timeout_seconds": 900, "budget_usd": 12.0},
            "treatment": {"runner": "claude", "version": "v", "model": "m", "effort": "high",
                          "timeout_seconds": 900, "budget_usd": 12.0},
            "equal": True,
            "differences": [],
        },
        "execution_order": ["treatment", "baseline"],
        "order_seed": 7,
        "arms": {"baseline": dict(arm), "treatment": dict(arm, variant="treatment",
                                                          patch_file="pair-x-treatment.patch")},
    }
    record["conclusions"] = {
        "per_arm": {},
        "trials_counted": 2,
        "dollar_conclusion_permitted": True,
        "dollar_conclusion_reason": "both arms reported native cost telemetry",
        "cost_by_arm": {},
        "statistical_claim": "None. n=1 per arm.",
    }
    record.update(overrides)
    return record


class LedgerTests(unittest.TestCase):
    def test_partial_start_is_persisted_before_the_call(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "ledger.json"
            attempt = new_attempt("exp", "pair", "baseline", "baseline")
            AttemptLedger(path).claim(attempt)
            stored = json.loads(path.read_text())["attempts"][attempt.key]
            self.assertEqual(stored["state"], "started")
            self.assertIsNone(stored["finished_at"])

    def test_duplicate_attempt_is_refused_across_processes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "ledger.json"
            AttemptLedger(path).claim(new_attempt("exp", "pair", "baseline", "baseline"))
            with self.assertRaises(AttemptAlreadyRecorded):
                AttemptLedger(path).claim(new_attempt("exp", "pair", "baseline", "baseline"))

    def test_a_finished_attempt_still_blocks_a_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "ledger.json"
            attempt = new_attempt("exp", "pair", "treatment", "treatment")
            ledger = AttemptLedger(path)
            ledger.claim(attempt)
            ledger.finish(attempt.key, state="finished", outcome="harness_error")
            with self.assertRaises(AttemptAlreadyRecorded):
                AttemptLedger(path).claim(new_attempt("exp", "pair", "treatment", "treatment"))

    def test_a_different_pair_id_is_a_different_attempt(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "ledger.json"
            ledger = AttemptLedger(path)
            ledger.claim(new_attempt("exp", "pair-1", "baseline", "baseline"))
            ledger.claim(new_attempt("exp", "pair-2", "baseline", "baseline"))
            self.assertEqual(len(ledger.entries()), 2)


class RecordValidationTests(unittest.TestCase):
    def test_a_complete_pair_passes_both_gates(self):
        record = minimal_record()
        self.assertEqual(records.validate_structure(record), [])
        self.assertEqual(records.validate_config_equality(record), [])

    def test_a_missing_arm_is_rejected(self):
        record = minimal_record()
        record["arms"].pop("treatment")
        self.assertTrue(records.validate_structure(record))

    def test_a_missing_arm_field_is_rejected(self):
        record = minimal_record()
        record["arms"]["treatment"].pop("grade")
        problems = records.validate_structure(record)
        self.assertTrue(any("grade" in problem for problem in problems))

    def test_an_execution_order_covering_one_arm_twice_is_rejected(self):
        record = minimal_record(execution_order=["baseline", "baseline"])
        self.assertTrue(records.validate_structure(record))

    def test_missing_provenance_is_rejected(self):
        record = minimal_record()
        record["provenance"].pop("grader_sha256")
        self.assertTrue(records.validate_structure(record))

    def test_declared_config_differences_are_rejected(self):
        record = minimal_record()
        record["configuration"]["differences"] = ["effort: 'high' != 'low'"]
        self.assertTrue(records.validate_config_equality(record))

    def test_absent_differences_field_is_rejected(self):
        record = minimal_record()
        record["configuration"].pop("differences")
        self.assertTrue(records.validate_config_equality(record))


class CostTests(unittest.TestCase):
    def test_dollar_conclusion_needs_both_arms_metered(self):
        record = minimal_record()
        self.assertTrue(records.cost_conclusion(record)["dollar_conclusion_permitted"])

    def test_one_unmetered_arm_forbids_a_dollar_conclusion(self):
        record = minimal_record()
        record["arms"]["treatment"]["telemetry"] = {
            "cost_usd": None,
            "cost_telemetry": "unavailable",
        }
        conclusion = records.cost_conclusion(record)
        self.assertFalse(conclusion["dollar_conclusion_permitted"])
        self.assertIn("not dollars", conclusion["reason"])

    def test_token_totals_are_never_read_as_dollars(self):
        record = minimal_record()
        record["arms"]["baseline"]["telemetry"] = {
            "cost_usd": None,
            "cost_telemetry": "unavailable",
            "tokens": {"input": 500_000, "output": 20_000},
        }
        self.assertFalse(records.cost_conclusion(record)["dollar_conclusion_permitted"])


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.registry = config.load_registry(ROOT / "runners.json")

    def test_every_registered_runner_declares_pins_and_isolation(self):
        for name, entry in self.registry["runners"].items():
            with self.subTest(runner=name):
                self.assertTrue(entry["model"], f"{name} must pin a model")
                self.assertTrue(entry["effort"], f"{name} must pin an effort")
                self.assertIn(entry["cost_telemetry"], {"native", "unavailable"})
                self.assertNotIn("--dangerously-skip-permissions", entry["argv"])
                self.assertNotIn("bypassPermissions", entry["argv"])

    def test_the_selected_runner_denies_publication_tools(self):
        argv = " ".join(self.registry["runners"]["claude"]["argv"])
        for denied in ("WebFetch", "WebSearch", "Bash(git push:*)", "Bash(gh:*)"):
            self.assertIn(denied, argv)

    def test_unknown_runner_is_refused(self):
        with self.assertRaises(SystemExit):
            config.resolve_runner(self.registry, "nope", budget_usd=1.0, timeout_seconds=60)

    def test_configuration_equality_ignores_only_arm_local_fields(self):
        left = {"model": "m", "effort": "high", "arm": "baseline", "variant": "baseline"}
        right = {"model": "m", "effort": "high", "arm": "treatment", "variant": "treatment"}
        self.assertEqual(config.configuration_equality(left, right), [])
        right["effort"] = "low"
        self.assertEqual(len(config.configuration_equality(left, right)), 1)


class IsolationProfileTests(unittest.TestCase):
    def test_profile_denies_every_protected_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(os.path.realpath(temporary))
            protected = base / "evaluator"
            protected.mkdir()
            memory = base / "memory"
            memory.mkdir()
            try:
                built = isolation.build_isolation(base / "p.sb", [protected], [memory])
            except isolation.IsolationUnavailable:
                self.skipTest("no supported isolation mechanism on this host")
            profile = built.profile_path.read_text()
            self.assertIn("(allow default)", profile)
            self.assertIn(f'(deny file-read* (subpath "{protected}"))', profile)
            self.assertIn(f'(deny file-write* (subpath "{protected}"))', profile)
            self.assertIn(f'(deny file-read* (subpath "{memory}"))', profile)

    def test_user_memory_candidates_cover_the_known_channels(self):
        for expected in (".claude/CLAUDE.md", ".claude/projects", ".claude/plugins", ".cursor"):
            self.assertIn(expected, isolation.USER_MEMORY_CANDIDATES)


class FixtureIntegrityTests(unittest.TestCase):
    """The committed patches must still describe the recorded source commit."""

    @classmethod
    def setUpClass(cls):
        cls.source = subprocess.run(
            ["git", "show", f"{manifest.EXPERIMENT_SOURCE_COMMIT}:{manifest.TARGET_FILE}"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )

    def _require_commit(self):
        if self.source.returncode != 0:
            self.skipTest("experiment source commit is not present locally")

    def _apply(self, patches: list[Path]) -> Path:
        self._require_commit()
        temporary = Path(tempfile.mkdtemp())
        target = temporary / manifest.TARGET_FILE
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(self.source.stdout)
        subprocess.run(["git", "init", "-q"], cwd=temporary, check=True)
        for patch in patches:
            applied = subprocess.run(
                ["git", "apply", "--whitespace=nowarn", str(patch)],
                cwd=temporary,
                capture_output=True,
                text=True,
            )
            self.assertEqual(applied.returncode, 0, f"{patch.name}: {applied.stderr}")
        return target

    def test_structural_delta_applies_and_is_behaviour_shaped(self):
        target = self._apply([ROOT / "treatment" / "structural-delta.patch"])
        text = target.read_text()
        self.assertIn("private async mutateTaskScoped(", text)
        self.assertEqual(text.count("this.mutateTaskScoped("), len(manifest.STRUCTURAL_DELTA["replacements"]))
        self.assertNotIn("closeIdleTask", text)

    def test_every_variant_patch_applies_to_its_own_variant(self):
        for variant in ("baseline", "treatment"):
            prerequisites = (
                [ROOT / "treatment" / "structural-delta.patch"] if variant == "treatment" else []
            )
            for patch in sorted((ROOT / "grader" / "patches" / variant).glob("*.patch")):
                with self.subTest(variant=variant, patch=patch.name):
                    self._apply(prerequisites + [patch])

    def test_gold_patch_adds_the_method_and_the_envelope(self):
        for variant in ("baseline", "treatment"):
            prerequisites = (
                [ROOT / "treatment" / "structural-delta.patch"] if variant == "treatment" else []
            )
            text = self._apply(
                prerequisites + [ROOT / "grader" / "patches" / variant / "gold.patch"]
            ).read_text()
            self.assertIn("async closeIdleTask(taskId: string)", text)
            self.assertIn("facade.close-idle-task", text)

    def test_missing_invariant_control_really_skips_the_review_close(self):
        text = self._apply(
            [ROOT / "grader" / "patches" / "baseline" / "control-missing-invariant.patch"]
        ).read_text()
        body = text.split("async closeIdleTask(")[1].split("\n  async ")[0]
        self.assertNotIn("closeReviewForTask", body)

    def test_the_trial_prompt_never_names_the_answer(self):
        prompt = (ROOT / "task" / "PROMPT.md").read_text()
        for leak in ("closeReviewForTask", "mutateTaskScoped", "closeWorkflowReview", "finalizeWithTopup"):
            self.assertNotIn(leak, prompt)

    def test_the_grader_asserts_call_order_not_a_helper_name(self):
        checks = (ROOT / "grader" / "checks" / "close-idle-task.checks.test.ts").read_text()
        self.assertIn("invocationCallOrder", checks)
        self.assertNotIn("mutateTaskScoped", checks)
        for check_id in manifest.GRADER_CHECK_IDS:
            self.assertIn(check_id, checks)

    def test_redactions_remove_every_prose_channel_the_delta_could_leak_through(self):
        for expected in ("CLAUDE.md", "ARCHITECTURE.md", "docs", "skills", "scripts/repro"):
            self.assertIn(expected, manifest.TRIAL_WORKSPACE_REDACTIONS)


class SanitisationTests(unittest.TestCase):
    def test_absolute_paths_are_replaced_everywhere_in_the_tree(self):
        payload = {
            "a": "/secret/run/source.tar",
            "b": ["/secret/run", {"c": "/secret/run/x"}],
            "d": 3,
        }
        cleaned = records.sanitise_value(payload, {"/secret/run": "<run-root>"})
        self.assertEqual(cleaned["a"], "<run-root>/source.tar")
        self.assertEqual(cleaned["b"][1]["c"], "<run-root>/x")
        self.assertEqual(cleaned["d"], 3)

    def test_strip_ansi_leaves_plain_text_alone(self):
        self.assertEqual(strip_ansi("Tests 82 passed"), "Tests 82 passed")
        self.assertEqual(strip_ansi("\x1b[32mok\x1b[39m"), "ok")


class ReportTests(unittest.TestCase):
    def test_report_is_self_contained_and_states_its_limits(self):
        html = render(minimal_record(), {"checks": [{"name": "c", "passed": True, "detail": "ok"}]})
        self.assertNotIn("<script", html)
        self.assertNotIn("http://", html)
        self.assertIn("What was not exercised", html)
        self.assertIn("What would invalidate this pair", html)
        self.assertIn("n=1 per arm", html)

    def test_a_tied_pair_is_reported_as_separating_nothing(self):
        record = minimal_record()
        record["conclusions"]["per_arm"] = {
            "baseline": {"trial_status": "completed", "graded_pass": True, "failing_checks": []},
            "treatment": {"trial_status": "completed", "graded_pass": True, "failing_checks": []},
        }
        self.assertIn("separates nothing", render(record, None))

    def test_a_split_pair_is_not_reported_as_an_effect(self):
        record = minimal_record()
        record["conclusions"]["per_arm"] = {
            "baseline": {"trial_status": "completed", "graded_pass": False,
                         "failing_checks": ["check:closes-review-before-mutation"]},
            "treatment": {"trial_status": "completed", "graded_pass": True, "failing_checks": []},
        }
        html = render(record, None)
        self.assertIn("not an effect", html)
        self.assertIn("run-to-run variance", html)

    def test_a_double_failure_is_recorded_not_retried(self):
        record = minimal_record()
        record["conclusions"]["per_arm"] = {
            "baseline": {"trial_status": "timeout", "graded_pass": False, "failing_checks": ["x"]},
            "treatment": {"trial_status": "harness_error", "graded_pass": False,
                          "failing_checks": ["x"]},
        }
        html = render(record, None)
        self.assertIn("valid data", html)
        self.assertIn("not a reason to tune the treatment", html)

    def test_report_carries_no_transcript(self):
        record = minimal_record()
        record["arms"]["baseline"]["raw_output_sha256"] = sha256_bytes(b"secret transcript")
        html = render(record, None)
        self.assertNotIn("secret transcript", html)


class ResultsTests(unittest.TestCase):
    def test_exit_code_is_nonzero_when_any_check_fails(self):
        results = Results("t")
        results.add("a", True)
        self.assertEqual(results.exit_code(), 0)
        results.add("b", False, "boom")
        self.assertEqual(results.exit_code(), 1)
        self.assertEqual(len(results.failed), 1)


if __name__ == "__main__":
    unittest.main()
