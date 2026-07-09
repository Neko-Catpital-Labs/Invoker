#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="__merge__wf-1782192505728-27"
SOURCE="$ROOT/packages/execution-engine/src/merge-gate-executor.ts"
TEST_SOURCE="$ROOT/packages/execution-engine/src/__tests__/merge-gate-executor.test.ts"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: processless merge executor destroyAll() dropped the active completion listener"

python3 - "$SOURCE" "$TEST_SOURCE" <<'PY'
import pathlib
import re
import sys

source_path = pathlib.Path(sys.argv[1])
test_path = pathlib.Path(sys.argv[2])
source = source_path.read_text(encoding="utf-8")
test_source = test_path.read_text(encoding="utf-8")

task_id = "__merge__wf-1782192505728-27"

class MergeEntry:
    def __init__(self):
        self.completed = False
        self.listeners = [lambda response: responses.append(response)]

responses = []

def emit_complete(entry, response: dict) -> None:
    if entry is None or entry.completed:
        return
    entry.completed = True
    for listener in entry.listeners:
        listener(response)

def pre_fix_destroy_all(entries: dict[str, MergeEntry]) -> None:
    # Before the fix, MergeGateExecutor.destroyAll() cleared entries without a
    # terminal response. The async merge action could later finish, but
    # emitComplete() had no entry/listener to notify.
    entries.clear()

def post_fix_destroy_all(entries: dict[str, MergeEntry]) -> None:
    for execution_id, entry in list(entries.items()):
        if not entry.completed:
            emit_complete(entry, {
                "status": "failed",
                "error": "Merge gate execution was stopped before completion",
            })
        entries.pop(execution_id, None)

pre_entries = {"exec": MergeEntry()}
pre_fix_destroy_all(pre_entries)
emit_complete(pre_entries.get("exec"), {"status": "review_ready"})
assert responses == [], "pre-fix model should drop the terminal merge completion"

post_entries = {"exec": MergeEntry()}
post_fix_destroy_all(post_entries)
emit_complete(post_entries.get("exec"), {"status": "review_ready"})
assert responses == [{
    "status": "failed",
    "error": "Merge gate execution was stopped before completion",
}], "fixed model should terminally fail exactly once"

destroy_match = re.search(r"async destroyAll\(\): Promise<void> \{(?P<body>.*?)\n  \}", source, re.S)
if not destroy_match:
    raise SystemExit("could not locate MergeGateExecutor.destroyAll()")
destroy_body = destroy_match.group("body")

required_source = [
    "entry.killed = true;",
    "this.emitComplete(executionId, {",
    "Merge gate execution was stopped before completion",
]
missing = [needle for needle in required_source if needle not in destroy_body]
if missing:
    raise SystemExit("fixed destroyAll terminal response invariant missing: " + ", ".join(missing))

if "emits a terminal failure when destroyed while a merge action is in flight" not in test_source:
    raise SystemExit("focused merge executor destroyAll regression test is missing")

print("[repro] pre-fix model: merge action can finish after destroyAll with no entry/listener, leaving task running")
print("[repro] post-fix model: destroyAll emits one failed terminal response before removing the entry")
print("[repro] source check: MergeGateExecutor.destroyAll() now terminally fails active processless runs")
PY

pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/merge-gate-executor.test.ts

echo "[repro] passed"
