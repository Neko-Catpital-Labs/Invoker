"""Behavioural tests for ``repair_filing_ledger``.

Documentation-by-test: given a stubbed ``run_headless_fn`` standing in for the
real Invoker headless CLI bridge, prove insert_repair_filing/release_repair_filing
build the right argv, parse both response shapes (raw and IPC-delegated
envelope), and fail loudly (never silently report inserted:true) when the
underlying call breaks.

Run:  python3 scripts/test_repair_filing_ledger.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import repair_filing_ledger as rfl


def completed(returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args=["fake"], returncode=returncode, stdout=stdout, stderr=stderr)


class InsertRepairFiling(unittest.TestCase):
    def test_claims_a_fresh_key(self):
        calls = []
        result = rfl.insert_repair_filing(
            "ci-regression:fleet", "master", "sha-a",
            run_headless_fn=lambda *a: calls.append(a) or completed(
                stdout=json.dumps({"inserted": True, "row": {"id": 1}}),
            ),
        )
        self.assertEqual(result, {"inserted": True, "row": {"id": 1}})
        command, kind, subject, sha = calls[0]
        self.assertIn("repair-filing insert", command)
        self.assertEqual((kind, subject, sha), ("ci-regression:fleet", "master", "sha-a"))

    def test_rejects_a_duplicate_key(self):
        result = rfl.insert_repair_filing(
            "admin-requeue:rebase-conflict", "9425", "sha-b",
            run_headless_fn=lambda *a: completed(stdout=json.dumps({"inserted": False, "row": {"id": 1}})),
        )
        self.assertFalse(result["inserted"])

    def test_unwraps_the_ipc_delegated_envelope(self):
        result = rfl.insert_repair_filing(
            "k", "s", "sha",
            run_headless_fn=lambda *a: completed(stdout=json.dumps({
                "ok": True,
                "response": {"inserted": True, "row": {"id": 2}},
            })),
        )
        self.assertEqual(result, {"inserted": True, "row": {"id": 2}})

    def test_passes_metadata_as_a_single_json_argument(self):
        calls = []
        rfl.insert_repair_filing(
            "k", "s", "sha", metadata={"memberJobs": ["a", "b"]},
            run_headless_fn=lambda *a: calls.append(a) or completed(stdout=json.dumps({"inserted": True, "row": {}})),
        )
        command, kind, subject, sha, metadata_json = calls[0]
        self.assertIn("--metadata", command)
        self.assertEqual(json.loads(metadata_json), {"memberJobs": ["a", "b"]})

    def test_raises_on_nonzero_exit_instead_of_silently_reporting_inserted_true(self):
        with self.assertRaises(rfl.RepairFilingLedgerError):
            rfl.insert_repair_filing(
                "k", "s", "sha",
                run_headless_fn=lambda *a: completed(returncode=1, stderr="owner unreachable"),
            )

    def test_raises_on_unparseable_output(self):
        with self.assertRaises(rfl.RepairFilingLedgerError):
            rfl.insert_repair_filing("k", "s", "sha", run_headless_fn=lambda *a: completed(stdout="not json"))

    def test_requires_kind_subject_and_state_sha(self):
        with self.assertRaises(ValueError):
            rfl.insert_repair_filing("", "s", "sha", run_headless_fn=lambda *a: completed())
        with self.assertRaises(ValueError):
            rfl.insert_repair_filing("k", "", "sha", run_headless_fn=lambda *a: completed())
        with self.assertRaises(ValueError):
            rfl.insert_repair_filing("k", "s", "", run_headless_fn=lambda *a: completed())


class ReleaseRepairFiling(unittest.TestCase):
    def test_releases_a_claimed_key(self):
        calls = []
        result = rfl.release_repair_filing(
            "k", "s", "sha",
            run_headless_fn=lambda *a: calls.append(a) or completed(stdout=json.dumps({"released": True})),
        )
        self.assertEqual(result, {"released": True})
        command = calls[0][0]
        self.assertIn("repair-filing release", command)

    def test_raises_on_failure_instead_of_silently_succeeding(self):
        with self.assertRaises(rfl.RepairFilingLedgerError):
            rfl.release_repair_filing("k", "s", "sha", run_headless_fn=lambda *a: completed(returncode=1))


if __name__ == "__main__":
    unittest.main()
