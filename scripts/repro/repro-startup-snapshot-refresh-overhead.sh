#!/usr/bin/env bash
#
# Deterministic repro for the redundant post-bootstrap startup snapshot refresh.
#
# After preload synchronously seeds the renderer with a full task/workflow
# snapshot (`preload_bootstrap_sync`), `useTasks` still issues a non-forced
# `getTasks()` IPC on mount and applies the result as
# `useTasks_snapshot_replace` (forced=false). Recent ui-perf samples show the
# second snapshot costs ~65–164ms and moves ~377KB on top of the bootstrap
# that already populated the graph.
#
# This script drives an isolated jsdom fixture that uses the real
# `useTasks` hook, captures the renderer ui-perf events (which the running
# Electron app persists to `activity_log`), and asserts whether the
# redundant non-forced snapshot still lands after `preload_bootstrap_sync`.
#
# Exit semantics:
#   --expect-issue (current baseline):
#       exit 0 when a non-forced `useTasks_snapshot_replace` is observed
#       after `preload_bootstrap_sync`; non-zero otherwise.
#   default (post-fix expectation):
#       exit 0 only when no redundant non-forced startup snapshot lands
#       after `preload_bootstrap_sync`; non-zero otherwise.

set -euo pipefail

EXPECT_ISSUE=0
WORKFLOW_COUNT="${WORKFLOW_COUNT:-8}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-12}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--expect-issue] [--workflows N] [--tasks-per-workflow M]

  --expect-issue            Assert the redundant snapshot IS present (baseline).
  --workflows N             Synthesize N workflows in the bootstrap (default: 8).
  --tasks-per-workflow M    Tasks per workflow in the bootstrap (default: 12).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows)
      [[ $# -ge 2 ]] || { echo "missing value for --workflows" >&2; exit 2; }
      WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow)
      [[ $# -ge 2 ]] || { echo "missing value for --tasks-per-workflow" >&2; exit 2; }
      TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE_REL_PATH="src/__tests__/repro-startup-snapshot-refresh-overhead.fixture.test.tsx"
FIXTURE_FULL_PATH="$ROOT_DIR/packages/ui/$FIXTURE_REL_PATH"

if [[ ! -f "$FIXTURE_FULL_PATH" ]]; then
  echo "repro: fixture missing at $FIXTURE_FULL_PATH" >&2
  exit 3
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
EVENTS_PATH="$TMP_DIR/events.json"
VITEST_LOG="$TMP_DIR/vitest.log"

echo "repro: driving useTasks fixture (workflows=$WORKFLOW_COUNT tasks_per_workflow=$TASKS_PER_WORKFLOW)..."

set +e
env \
  INVOKER_REPRO_STARTUP_SNAPSHOT_OUTPUT_PATH="$EVENTS_PATH" \
  INVOKER_REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
  INVOKER_REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  pnpm --dir "$ROOT_DIR/packages/ui" exec vitest run "$FIXTURE_REL_PATH" --reporter=dot \
  >"$VITEST_LOG" 2>&1
VITEST_STATUS=$?
set -e

if [[ ! -s "$EVENTS_PATH" ]]; then
  echo "repro: fixture did not produce events at $EVENTS_PATH (vitest exit=$VITEST_STATUS)" >&2
  echo "--- vitest output ---" >&2
  cat "$VITEST_LOG" >&2 || true
  exit 4
fi

python3 - "$EVENTS_PATH" "$EXPECT_ISSUE" <<'PY'
import json
import sys

events_path = sys.argv[1]
expect_issue = sys.argv[2] == '1'

with open(events_path, 'r', encoding='utf-8') as f:
    payload = json.load(f)

events = sorted(payload.get('events', []), key=lambda e: e.get('relTsMs', 0))
bootstrap = payload.get('bootstrap', {})
config = payload.get('config', {})

def find_event(metric):
    for e in events:
        if e.get('metric') == metric:
            return e
    return None

preload = find_event('preload_bootstrap_sync')
preload_idx = events.index(preload) if preload else -1
post_preload = events[preload_idx + 1:] if preload_idx >= 0 else events

snapshot_replace = next(
    (e for e in post_preload if e.get('metric') == 'useTasks_snapshot_replace'),
    None,
)
snapshot_skipped = next(
    (e for e in post_preload
     if e.get('metric') == 'startup_snapshot_skipped_smaller_than_bootstrap'),
    None,
)
graph_visible = find_event('startup_graph_visible')

replace_data = (snapshot_replace or {}).get('data', {})
forced = bool(replace_data.get('forceRefresh', False))
redundant_replace_present = snapshot_replace is not None and not forced

print('repro-summary:')
print(f"  config.workflowCount: {config.get('workflowCount')}")
print(f"  config.tasksPerWorkflow: {config.get('tasksPerWorkflow')}")
print(f"  bootstrap.taskCount: {bootstrap.get('taskCount')}")
print(f"  bootstrap.workflowCount: {bootstrap.get('workflowCount')}")
print(f"  bootstrap.jsonSizeBytes: {bootstrap.get('jsonSizeBytes')}")
print(f"  preload_bootstrap_sync.present: {preload is not None}")

if snapshot_replace is not None:
    print('  useTasks_snapshot_replace.present: True')
    print(f"  useTasks_snapshot_replace.forceRefresh: {forced}")
    print(f"  useTasks_snapshot_replace.requestDurationMs: {replace_data.get('requestDurationMs')}")
    print(f"  useTasks_snapshot_replace.replaceDurationMs: {replace_data.get('replaceDurationMs')}")
    print(f"  useTasks_snapshot_replace.taskCount: {replace_data.get('taskCount')}")
    print(f"  useTasks_snapshot_replace.workflowCount: {replace_data.get('workflowCount')}")
    print(f"  useTasks_snapshot_replace.jsonSizeBytes: {replace_data.get('jsonSizeBytes')}")
else:
    print('  useTasks_snapshot_replace.present: False')
    print('  useTasks_snapshot_replace.forceRefresh: n/a')
    print('  useTasks_snapshot_replace.requestDurationMs: n/a')
    print('  useTasks_snapshot_replace.replaceDurationMs: n/a')

if snapshot_skipped is not None:
    skipped_data = snapshot_skipped.get('data', {})
    print('  startup_snapshot_skipped_smaller_than_bootstrap.present: True')
    print(f"  startup_snapshot_skipped.bootstrapTaskCount: {skipped_data.get('bootstrapTaskCount')}")
    print(f"  startup_snapshot_skipped.snapshotTaskCount: {skipped_data.get('snapshotTaskCount')}")

if graph_visible is not None:
    gv_data = graph_visible.get('data', {})
    print('  startup_graph_visible.elapsedMs: {0}'.format(gv_data.get('elapsedMs')))
    print('  startup_graph_visible.nodeCount: {0}'.format(gv_data.get('nodeCount')))
    print('  startup_graph_visible.edgeCount: {0}'.format(gv_data.get('edgeCount')))
else:
    print('  startup_graph_visible: <not emitted>')

print(f"  redundant_replace_after_preload: {redundant_replace_present}")

if expect_issue:
    if redundant_replace_present:
        print('repro: PASS (baseline reproduces redundant snapshot refresh)')
        sys.exit(0)
    print('repro: FAIL (--expect-issue but no redundant snapshot refresh observed)', file=sys.stderr)
    sys.exit(1)

if redundant_replace_present:
    print('repro: FAIL (redundant non-forced startup snapshot still lands after preload_bootstrap_sync)', file=sys.stderr)
    sys.exit(1)

print('repro: PASS (no redundant non-forced startup snapshot after preload_bootstrap_sync)')
sys.exit(0)
PY
