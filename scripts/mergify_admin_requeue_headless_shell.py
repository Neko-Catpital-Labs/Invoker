from __future__ import annotations

import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
HEADLESS_LIB = REPO_ROOT / "scripts" / "headless-lib.sh"

# Sources scripts/headless-lib.sh directly (never scripts/cron-pr-lib.sh): by the
# time any caller of this module runs, cron-pr-lib.sh's cron_lock is already held
# by the calling bash script (scripts/cron-pr-admin-bypass-land.sh), so re-sourcing
# it and calling cron_lock again would self-deadlock or silently no-op.
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
        # A wedged owner-IPC connection (no reachable owner, a hung socket) must
        # never block a cron tick indefinitely -- surface it as an ordinary
        # non-zero CompletedProcess so every caller's existing "returncode != 0"
        # handling raises a clear RuntimeError instead of hanging the process.
        return subprocess.CompletedProcess(
            args, returncode=124, stdout="", stderr=f"timed out after {timeout_seconds}s",
        )
