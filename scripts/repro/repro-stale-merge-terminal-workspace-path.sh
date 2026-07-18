#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SOURCE="$ROOT/packages/execution-engine/src/merge-gate-executor.ts"
echo "[repro] problem: restored merge-gate terminal targeted a deleted launch workspace"
echo "[repro] root cause: handle.workspacePath stayed pinned to the launch dir that run() later deletes"

python3 - "$SOURCE" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

class Handle:
    def __init__(self): self.workspacePath = "/launch/tmp"
def get_terminal_spec(h): return {"cwd": h.workspacePath}

def pre_fix_run(h):
    deleted = h.workspacePath           # cleanup removes the launch dir; handle never repointed
    return get_terminal_spec(h), deleted
def post_fix_run(h, real_path):
    h.workspacePath = real_path         # repoint to the gate clone before cleanup
    return get_terminal_spec(h), "/launch/tmp"

pre_spec, pre_deleted = pre_fix_run(Handle())
assert pre_spec["cwd"] == pre_deleted, "pre-fix model should leave terminal pointing at the deleted launch dir"

post_spec, post_deleted = post_fix_run(Handle(), "/real/gate")
assert post_spec["cwd"] == "/real/gate" and post_spec["cwd"] != post_deleted, \
    "fixed model should point the terminal at the real gate clone, not the deleted launch dir"

assign = source.find("handle.workspacePath = executionChanges.workspacePath")
last_cleanup = source.rfind("this.cleanupLaunchWorkspace(launchWorkspacePath")
if assign == -1 or last_cleanup == -1 or assign > last_cleanup:
    raise SystemExit("fixed invariant missing: run() must set handle.workspacePath before the final cleanupLaunchWorkspace")

print("[repro] pre-fix model: terminal cwd == deleted launch dir")
print("[repro] post-fix model: terminal cwd == real gate clone (launch dir safely removed)")
print("[repro] source check: run() repoints handle.workspacePath to the gate clone before cleanup")
PY
echo "[repro] passed"
