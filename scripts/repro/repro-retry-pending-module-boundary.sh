#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] retry-pending mutation path must not import workspace TS packages"

bash -n scripts/retry-pending-autofix-failed.sh

python3 - "$ROOT" <<'PY'
import pathlib
import re
import sys

root = pathlib.Path(sys.argv[1])
script = root / "scripts" / "retry-pending-autofix-failed.sh"
text = script.read_text(encoding="utf-8")
for forbidden in ["headless-ipc", "headless-client", "IPC_HELPER", "packages/contracts/src", "packages/app/src"]:
    if forbidden in text:
        raise SystemExit(f"retry script still references forbidden module-boundary path: {forbidden}")
if "raw_ipc_request" not in text or "headless.exec" not in text:
    raise SystemExit("retry script no longer uses the raw IPC request path")
if re.search(r'node\s+"\$HEADLESS_CLIENT_JS"|node\s+"\$IPC_HELPER"', text):
    raise SystemExit("retry script still shells out through a Node helper that can import TS package sources")
PY

echo "[repro] retry-pending self-test"
bash scripts/retry-pending-autofix-failed.sh --self-test

echo "[repro] passed"
