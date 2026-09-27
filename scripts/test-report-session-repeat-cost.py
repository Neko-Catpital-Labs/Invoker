#!/usr/bin/env python3
"""Fixture-based tests for report-session-repeat-cost.py.

Run: python3 scripts/test-report-session-repeat-cost.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "report-session-repeat-cost.py"


class SinceCutoffTest(unittest.TestCase):
    def test_whitespace_timestamp_is_used_for_since_cutoff(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sid = "session-whitespace-timestamp"
            project = root / "projects" / "proj"
            project.mkdir(parents=True)
            transcript = project / f"{sid}.jsonl"
            transcript.write_text(
                json.dumps(
                    {
                        "timestamp": "2026-09-01T00:00:00.000Z",
                        "message": {
                            "id": "msg_1",
                            "usage": {
                                "input_tokens": 100,
                                "output_tokens": 2,
                                "cache_read_input_tokens": 3,
                                "cache_creation_input_tokens": 4,
                            },
                        },
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            recovery = root / "recovery.jsonl"
            recovery.write_text(
                json.dumps({"workflow_id": "wf-old", "agent_session_id": sid}) + "\n",
                encoding="utf-8",
            )
            decision = root / "decision.jsonl"
            decision.write_text("", encoding="utf-8")

            proc = subprocess.run(
                [
                    sys.executable,
                    os.fspath(SCRIPT),
                    "--recovery-dump",
                    os.fspath(recovery),
                    "--decision-log",
                    os.fspath(decision),
                    "--projects-root",
                    os.fspath(root / "projects"),
                    "--since",
                    "2026-09-02T00:00:00",
                ],
                check=True,
                text=True,
                capture_output=True,
            )

        self.assertIn("matched_sessions=0 unmatched_sessions=0", proc.stdout)


if __name__ == "__main__":
    unittest.main()
