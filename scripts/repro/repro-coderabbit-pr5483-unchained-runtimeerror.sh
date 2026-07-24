#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #5483 (Ruff B904): run_cycle re-raised RuntimeError inside
# `except ValueError:` without `from exc`, dropping the original ValueError
# that explains WHY the .mergify.yml admin-bypass rule failed to load. Since
# run_once/run_loop swallow the RuntimeError into exit code 2, the unchained
# cause is lost entirely.
# Buggy behaviour: RuntimeError.__cause__ is None.
# Fixed behaviour: RuntimeError.__cause__ is the original ValueError.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
import sys
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path("scripts").resolve()))
import mergify_admin_requeue_exec as exec_impl

args = exec_impl.parse_args(["--once"])
cause = ValueError("admin-bypass rule missing queue conditions")
with mock.patch.object(exec_impl, "load_mergify_rules", side_effect=cause):
    try:
        exec_impl.run_cycle(args)
    except RuntimeError as exc:
        if exc.__cause__ is not cause:
            print("FAIL: RuntimeError not chained to the original ValueError; load failure cause is lost")
            sys.exit(1)
    else:
        print("FAIL: run_cycle did not raise RuntimeError on a failed .mergify.yml load")
        sys.exit(1)

print("PASS: run_cycle chains RuntimeError from the original ValueError")
PY
