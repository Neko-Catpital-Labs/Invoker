#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #5483: run_loop did not catch the RuntimeError that run_once
# maps to exit code 2 (e.g. a failed .mergify.yml load). Under --loop the same
# failure crashed the unattended polling process with an unhandled traceback.
# Buggy behaviour: run_loop propagates RuntimeError.
# Fixed behaviour: run_loop returns exit code 2, like run_once.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path("scripts").resolve()))
import mergify_admin_requeue_exec as exec_impl

args = exec_impl.parse_args(["--loop", "--poll-seconds", "0"])
with mock.patch.object(exec_impl, "run_cycle", side_effect=RuntimeError("failed to load admin-bypass Mergify rule")):
    try:
        rc = exec_impl.run_loop(args)
    except RuntimeError:
        print("FAIL: run_loop propagated RuntimeError instead of returning a controlled exit code")
        sys.exit(1)

if rc != 2:
    print(f"FAIL: run_loop returned {rc!r}, expected 2 (matching run_once)")
    sys.exit(1)

print("PASS: run_loop maps RuntimeError to exit code 2, consistent with run_once")
PY
