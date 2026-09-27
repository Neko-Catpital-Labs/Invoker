import json
import tempfile
import unittest
from pathlib import Path

import run


def pinned(model="m1"):
    return {"harness": "claude", "binary": "/bin/claude", "binary_sha256": "abc", "version": "1.0", "model": model,
            "effort": "medium", "budget_usd": 5.0, "timeout_seconds": 900, "telemetry": "claude-stream-json",
            "argv_template": ["--model", "{model}", "--effort", "{effort}", "--settings", "{\"a\":1}", "--", "{prompt}"],
            "env_template": {"CLAUDE_CONFIG_DIR": "{auth_config_dir}"}, "auth_config_dir": "/cfg"}


def plan(trial):
    return {"work_root": "/w", "trial_dir": trial, "deny_read_write": ["/repo", f"{trial}/../other"],
            "reallow_auth_dir": ["/cfg"], "deny_exec": ["/bin/gh"]}


def make_pair(tmp: Path):
    manifest = run.manifest()
    configs = {arm: run.trial_config(pinned(), "p", plan(f"/w/{arm}"), manifest) for arm in run.ARMS}
    (tmp / "patches").mkdir(parents=True)
    trials, grades, arms = {}, {}, {}
    for arm in run.ARMS:
        patch = f"patch {arm}".encode()
        (tmp / "patches" / f"{arm}.patch").write_bytes(patch)
        sha = run.sha256_bytes(patch)
        trials[arm] = {"status": "completed", "invocations": 1, "retries": 0, "patch_file": f"patches/{arm}.patch",
                       "patch_sha256": sha}
        grades[arm] = {"passed": False, "patch_sha256": sha}
        arms[arm] = {"config_sha256": run.canonical_hash(configs[arm]), "snapshot_tree": f"tree-{arm}"}
    return {"experiment_id": "e", "pair_id": "p", "source": {}, "order": ["treatment", "baseline"], "arms": arms,
            "configs": configs, "trials": trials, "grades": grades}


class ConfigTests(unittest.TestCase):
    def test_trial_dir_is_normalized_out_of_config_hash(self):
        m = run.manifest()
        a = run.trial_config(pinned(), "p", plan("/w/a"), m)
        b = run.trial_config(pinned(), "p", plan("/w/b"), m)
        self.assertEqual(run.canonical_hash(a), run.canonical_hash(b))

    def test_model_change_changes_config_hash(self):
        m = run.manifest()
        a = run.trial_config(pinned("m1"), "p", plan("/w/a"), m)
        b = run.trial_config(pinned("m2"), "p", plan("/w/a"), m)
        self.assertNotEqual(run.canonical_hash(a), run.canonical_hash(b))

    def test_render_invocation_fills_placeholders_but_not_json_settings(self):
        argv, env = run.render_invocation(pinned(), "do {it}")
        self.assertEqual(argv, ["/bin/claude", "--model", "m1", "--effort", "medium", "--settings", "{\"a\":1}",
                                "--", "do {it}"])
        self.assertEqual(env, {"CLAUDE_CONFIG_DIR": "/cfg"})


class SandboxProfileTests(unittest.TestCase):
    def test_trial_dir_allow_comes_after_work_root_deny(self):
        profile = run.sandbox_profile({"work_root": "/w", "trial_dir": "/w/t", "deny_read_write": ["/repo"],
                                       "reallow_auth_dir": [], "deny_exec": ["/bin/gh"]})
        lines = profile.splitlines()
        deny = next(i for i, line in enumerate(lines) if '"/w"' in line)
        allow = next(i for i, line in enumerate(lines) if '"/w/t"' in line)
        self.assertLess(deny, allow)
        self.assertIn('(deny process-exec (literal "/bin/gh"))', profile)

    def test_auth_private_paths_are_denied_after_auth_reallow(self):
        profile = run.sandbox_profile({"work_root": "/w", "trial_dir": "/w/t",
                                       "deny_read_write": ["/home/.invoker", "/cfg/projects"],
                                       "reallow_auth_dir": ["/cfg"], "deny_exec": []})
        lines = profile.splitlines()
        allow_cfg = lines.index('(allow file-read* file-read-data file-write* (subpath "/cfg"))')
        deny_projects = lines.index('(deny file-read* file-read-data file-write* (subpath "/cfg/projects"))')
        self.assertLess(allow_cfg, deny_projects)


class LedgerTests(unittest.TestCase):
    def test_arm_state_transitions(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = run.Ledger(Path(tmp) / "l.jsonl")
            self.assertEqual(ledger.arm_state("baseline"), "none")
            ledger.append("trial_start", arm="baseline")
            self.assertEqual(ledger.arm_state("baseline"), "started")
            ledger.append("trial_end", arm="baseline")
            self.assertEqual(ledger.arm_state("baseline"), "finished")
            self.assertEqual(ledger.invocations("baseline"), 1)
            self.assertEqual(ledger.arm_state("treatment"), "none")


class PairValidationTests(unittest.TestCase):
    def test_complete_pair_is_valid(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(run.validate_pair(make_pair(Path(tmp)), Path(tmp)), [])

    def test_missing_arm_is_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            pair = make_pair(Path(tmp))
            del pair["trials"]["baseline"]
            self.assertTrue(any("incomplete" in e for e in run.validate_pair(pair, Path(tmp))))

    def test_config_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            pair = make_pair(Path(tmp))
            pair["configs"]["treatment"]["harness"]["effort"] = "high"
            pair["arms"]["treatment"]["config_sha256"] = run.canonical_hash(pair["configs"]["treatment"])
            self.assertTrue(any("differ" in e for e in run.validate_pair(pair, Path(tmp))))

    def test_unrecorded_config_edit_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            pair = make_pair(Path(tmp))
            pair["configs"]["baseline"]["retries"] = 1
            self.assertTrue(any("config_sha256" in e for e in run.validate_pair(pair, Path(tmp))))

    def test_extra_invocation_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            pair = make_pair(Path(tmp))
            pair["trials"]["treatment"]["invocations"] = 2
            self.assertTrue(any("invocations" in e for e in run.validate_pair(pair, Path(tmp))))

    def test_patch_tamper_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            pair = make_pair(Path(tmp))
            (Path(tmp) / "patches" / "baseline.patch").write_bytes(b"different")
            self.assertTrue(any("hash mismatch" in e for e in run.validate_pair(pair, Path(tmp))))

    def test_identical_snapshots_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            pair = make_pair(Path(tmp))
            pair["arms"]["treatment"]["snapshot_tree"] = pair["arms"]["baseline"]["snapshot_tree"]
            self.assertTrue(any("identical" in e for e in run.validate_pair(pair, Path(tmp))))


class TelemetryTests(unittest.TestCase):
    def test_claude_stream_json_result_is_parsed(self):
        events = [
            {"type": "system", "subtype": "init", "model": "claude-sonnet-5", "tools": ["Bash"], "mcp_servers": []},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash"}]}},
            {"type": "result", "subtype": "success", "is_error": False, "num_turns": 3, "result": "done",
             "total_cost_usd": 0.5, "usage": {"input_tokens": 10, "output_tokens": 20},
             "modelUsage": {"claude-sonnet-5": {}}, "permission_denials": [{}]},
        ]
        parsed = run.parse_telemetry("claude-stream-json", "\n".join(json.dumps(e) for e in events))
        self.assertEqual(parsed["cost_usd"], 0.5)
        self.assertEqual(parsed["usage"]["output_tokens"], 20)
        self.assertEqual(parsed["tool_uses"], 1)
        self.assertEqual(parsed["permission_denials"], 1)
        self.assertEqual(parsed["init_model"], "claude-sonnet-5")

    def test_missing_result_event_marks_cost_missing(self):
        parsed = run.parse_telemetry("claude-stream-json", "not json\n")
        self.assertIsNone(parsed["cost_usd"])
        self.assertTrue(parsed["cost_source"].startswith("missing"))


class PatchTests(unittest.TestCase):
    def test_changed_paths(self):
        patch = b"diff --git a/x/y.ts b/x/y.ts\n--- a/x/y.ts\n+++ b/x/y.ts\n"
        self.assertEqual(run.changed_paths(patch), ["x/y.ts"])

    def test_sanitize_redacts_home_and_keys(self):
        text = run.sanitize(f"{Path.home()}/a sk-ant-abcdefghijklmnop")
        self.assertNotIn(str(Path.home()), text)
        self.assertIn("<redacted>", text)


if __name__ == "__main__":
    unittest.main()
