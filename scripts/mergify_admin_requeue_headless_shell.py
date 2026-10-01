from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HEADLESS_LIB = REPO_ROOT / "scripts" / "headless-lib.sh"

# Safety invariant: source scripts/headless-lib.sh directly because cron-pr-lib.sh's cron_lock is already held and re-sourcing it can self-deadlock or silently no-op.
_SOURCE_HEADLESS_LIB = 'set -euo pipefail\nsource "$1"\n'

DEFAULT_TIMEOUT_SECONDS = 30


def run_headless(command: str, *extra_args: str, timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS) -> subprocess.CompletedProcess[str]:
    args = ["bash", "-c", _SOURCE_HEADLESS_LIB + command, "bash", str(HEADLESS_LIB), *extra_args]
    try:
        return subprocess.run(
            args,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired:
        # Safety invariant: a wedged owner-IPC connection must return a non-zero CompletedProcess instead of blocking a cron tick indefinitely.
        return subprocess.CompletedProcess(
            args, returncode=124, stdout="", stderr=f"timed out after {timeout_seconds}s",
        )
