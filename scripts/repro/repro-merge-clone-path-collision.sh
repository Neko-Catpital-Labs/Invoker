#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-merge-clone-path-collision.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] issue: duplicate merge clone labels can collide when Date.now() returns the same value"

python3 <<'PY'
from pathlib import Path

label = "gate-__merge__wf-demo"
timestamp = 123456789
pre_fix_first = f"{label}-{timestamp}"
pre_fix_second = f"{label}-{timestamp}"
assert pre_fix_first == pre_fix_second, "pre-fix Date.now path model should collide"

source = Path("packages/execution-engine/src/task-runner.ts").read_text(encoding="utf-8")
assert "mkdtempSync(resolve(mergeCloneRoot, `${label}-`))" in source, "fixed TaskRunner must allocate merge clone paths with mkdtempSync"
print("[repro] pre-fix model: duplicate labels in the same millisecond choose the same clone directory")
print("[repro] source check: TaskRunner now delegates suffix allocation to mkdtempSync")
PY

pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/create-merge-worktree.test.ts \
  -t "allocates unique clone directories for duplicate labels" \
  >"$log_file" 2>&1 || {
  status=$?
  echo "[repro] focused merge clone regression failed"
  cat "$log_file"
  exit "$status"
}

echo "[repro] passed"
