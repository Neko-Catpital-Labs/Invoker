#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
SOURCE="$ROOT/packages/execution-engine/src/merge-gate-executor.ts"
echo "[repro] problem: a merge gate reads as 'Executing' with no progress while it is really cloning/provisioning the gate workspace"
echo "[repro] root cause: run() entered the merge action without surfacing that the running phase starts with provisioning"

python3 - "$SOURCE" <<'PY'
import pathlib, sys
src = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")

# The provisioning notice must be emitted BEFORE the merge action (the clone happens inside it).
notice = src.find("Preparing gate workspace")
action = src.find("await runMergeGateActionImpl(this.host, task)")
if notice == -1:
    raise SystemExit("missing provisioning notice in merge gate run()")
if action == -1 or notice > action:
    raise SystemExit("provisioning notice must be emitted before runMergeGateActionImpl")

# Recovery is unchanged: still runs under the executing-stall-protected running phase (no phase downgrade).
if "phase: 'launching'" in src:
    raise SystemExit("must NOT move the clone into launching phase (would lose executing-stall recovery)")

print("[repro] post-fix: run() emits a 'Preparing gate workspace' provisioning notice before the merge action")
print("[repro] invariant: clone stays in the executing-stall-protected running phase (recovery unchanged)")
PY
echo "[repro] passed"
