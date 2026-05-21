#!/usr/bin/env bash
# Deterministic repro for the post-bootstrap startup snapshot refresh overhead.
#
# Seeds an isolated Invoker DB with multiple workflows, then launches the
# Electron GUI under Playwright. After the graph is visible, the script reads
# `activity_log` ui-perf events via the renderer IPC and inspects the relevant
# entries (preload_bootstrap_sync, useTasks_snapshot_replace,
# startup_workflow_graph_visible). The redundant non-forced snapshot is
# detected by checking the timestamp ordering of the snapshot replace vs.
# preload bootstrap.
#
# Exit semantics:
#   --expect-issue : exit 0 only if a non-forced `useTasks_snapshot_replace`
#                    fires AFTER `preload_bootstrap_sync` (i.e. the current
#                    baseline reproduces the bug). Exit 1 otherwise.
#   default        : exit 0 only if no such redundant non-forced snapshot is
#                    observed (i.e. the optimization landed). Exit 1 otherwise.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#
# Environment overrides:
#   WORKFLOW_COUNT      Number of workflows to seed (default: 5).
#   TASKS_PER_WORKFLOW  Tasks per seeded workflow (default: 6).
#   GRAPH_VISIBLE_TIMEOUT_MS  Max time to wait for the graph (default: 30000).
#   STARTUP_WAIT_MS     Time to wait after graph visible to collect logs
#                       (default: 2000 — long enough to capture the trailing
#                       non-forced snapshot if it fires).
#   INVOKER_REPRO_KEEP_TMP=1  Keep the temp dir on exit for debugging.

set -euo pipefail

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed -n 's/^# \{0,1\}//p'
      exit 0
      ;;
    *)
      echo "repro: unknown argument: $arg" >&2
      exit 64
      ;;
  esac
done

WORKFLOW_COUNT="${WORKFLOW_COUNT:-5}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-6}"
GRAPH_VISIBLE_TIMEOUT_MS="${GRAPH_VISIBLE_TIMEOUT_MS:-30000}"
STARTUP_WAIT_MS="${STARTUP_WAIT_MS:-2000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-repro.XXXXXXXX)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REMOTE_REPO="$TMP_DIR/remote.git"
CONFIG_PATH="$TMP_DIR/config.json"
STUB_DIR="$TMP_DIR/stub"
MARKER_DIR="$TMP_DIR/markers"
HELPER_SCRIPT="$TMP_DIR/launch-and-capture.cjs"
HELPER_OUT="$TMP_DIR/helper.json"
HELPER_LOG="$TMP_DIR/helper.log"

cleanup() {
  if [[ "${INVOKER_REPRO_KEEP_TMP:-0}" = "1" ]]; then
    echo "repro: keeping temp dir at $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR" "$STUB_DIR" "$MARKER_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/headless-client.js || ! -f packages/app/dist/main.js ]]; then
  echo "repro: building @invoker/app (dist artifacts missing)..." >&2
  pnpm --filter @invoker/app build >&2
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"maxConcurrency":4}
EOF

CLAUDE_MARKER="$ROOT_DIR/scripts/e2e-dry-run/fixtures/claude-marker.sh"
if [[ ! -x "$CLAUDE_MARKER" ]]; then
  echo "repro: expected claude marker stub at $CLAUDE_MARKER" >&2
  exit 1
fi
ln -sf "$CLAUDE_MARKER" "$STUB_DIR/claude"

export HOME="$HOME_DIR"
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export INVOKER_HEADLESS_STANDALONE=1

extract_workflow_id() {
  sed -n 's/^Workflow ID: //p' "$1" | head -n1
}

write_plan() {
  local idx="$1"
  local plan_path="$TMP_DIR/plan-$idx.yaml"
  {
    echo "name: startup-snapshot-repro-$idx"
    echo "onFinish: none"
    echo "repoUrl: file://$REMOTE_REPO"
    echo "tasks:"
    for t in $(seq 1 "$TASKS_PER_WORKFLOW"); do
      echo "  - id: t$t"
      echo "    description: Seeded task $idx-$t"
      echo "    command: \"true\""
      if [[ "$t" -gt 1 ]]; then
        echo "    dependencies: [t$((t - 1))]"
      fi
    done
  } > "$plan_path"
  echo "$plan_path"
}

echo "repro: seeding $WORKFLOW_COUNT workflows ($TASKS_PER_WORKFLOW tasks each) into $DB_DIR ..."
for idx in $(seq 1 "$WORKFLOW_COUNT"); do
  plan_path="$(write_plan "$idx")"
  run_stdout="$TMP_DIR/seed-$idx.stdout.log"
  run_stderr="$TMP_DIR/seed-$idx.stderr.log"
  ./run.sh --headless --no-track run "$plan_path" \
    >"$run_stdout" 2>"$run_stderr" || {
      echo "repro: failed to seed workflow $idx" >&2
      tail -n 40 "$run_stdout" >&2 || true
      tail -n 40 "$run_stderr" >&2 || true
      exit 1
    }
  wf_id="$(extract_workflow_id "$run_stdout")"
  if [[ -z "$wf_id" ]]; then
    echo "repro: could not parse workflow id from seed output ($run_stdout)" >&2
    tail -n 40 "$run_stdout" >&2 || true
    exit 1
  fi
done

# Ensure the seeded workflows finished so the startup snapshot has stable data.
sleep 1

cat > "$HELPER_SCRIPT" <<'NODE'
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const appRoot = path.resolve(process.env.INVOKER_REPO_ROOT, 'packages/app');
const mainJs = path.join(appRoot, 'dist/main.js');
let electron;
try {
  ({ _electron: electron } = require(path.join(appRoot, 'node_modules/@playwright/test')));
} catch (err) {
  console.error('helper: failed to load @playwright/test from packages/app:', err.message);
  process.exit(2);
}

const graphVisibleTimeoutMs = Number(process.env.GRAPH_VISIBLE_TIMEOUT_MS || 30000);
const postGraphWaitMs = Number(process.env.STARTUP_WAIT_MS || 2000);
const expectedWorkflowCount = Number(process.env.WORKFLOW_COUNT || 0);
const outPath = process.env.HELPER_OUT;

if (!outPath) {
  console.error('helper: HELPER_OUT env var is required');
  process.exit(2);
}

(async () => {
  const linuxArgs = process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
    : [];
  const app = await electron.launch({
    args: [...linuxArgs, mainJs],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: process.env.INVOKER_DB_DIR,
      INVOKER_REPO_CONFIG_PATH: process.env.INVOKER_REPO_CONFIG_PATH,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_E2E_MARKER_ROOT: process.env.INVOKER_E2E_MARKER_ROOT,
      INVOKER_CLAUDE_FIX_COMMAND: process.env.INVOKER_CLAUDE_FIX_COMMAND,
      INVOKER_CLAUDE_COMMAND: process.env.INVOKER_CLAUDE_COMMAND,
      PATH: process.env.PATH,
    },
  });
  let summary = { ok: false };
  try {
    const page = await app.firstWindow({ timeout: graphVisibleTimeoutMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, {
      timeout: graphVisibleTimeoutMs,
    });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: graphVisibleTimeoutMs,
    });
    // Allow trailing non-forced snapshot to fire after the graph is visible.
    await page.waitForTimeout(postGraphWaitMs);
    const result = await page.evaluate(async () => {
      const logs = await window.invoker.getActivityLogs();
      return { logs };
    });
    summary = {
      ok: true,
      expectedWorkflowCount,
      logs: result.logs,
    };
  } catch (err) {
    summary = {
      ok: false,
      error: err && err.message ? err.message : String(err),
    };
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
  fs.writeFileSync(outPath, JSON.stringify(summary), 'utf8');
  process.exit(summary.ok ? 0 : 1);
})().catch((err) => {
  fs.writeFileSync(outPath, JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }), 'utf8');
  process.exit(1);
});
NODE

LAUNCH_CMD=(env
  HOME="$HOME_DIR"
  INVOKER_DB_DIR="$DB_DIR"
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
  INVOKER_E2E_MARKER_ROOT="$MARKER_DIR"
  INVOKER_CLAUDE_FIX_COMMAND="$CLAUDE_MARKER"
  INVOKER_CLAUDE_COMMAND="$CLAUDE_MARKER"
  INVOKER_REPO_ROOT="$ROOT_DIR"
  HELPER_OUT="$HELPER_OUT"
  WORKFLOW_COUNT="$WORKFLOW_COUNT"
  GRAPH_VISIBLE_TIMEOUT_MS="$GRAPH_VISIBLE_TIMEOUT_MS"
  STARTUP_WAIT_MS="$STARTUP_WAIT_MS"
  PATH="$STUB_DIR:$PATH"
)

echo "repro: launching Electron under Playwright and waiting for graph visible..."
LAUNCHER="node"
if [[ "$(uname)" = "Linux" && -z "${DISPLAY:-}" ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    LAUNCHER="xvfb-run --auto-servernum node"
  else
    echo "repro: Linux without DISPLAY requires xvfb-run; please install it." >&2
    exit 1
  fi
fi

if ! "${LAUNCH_CMD[@]}" $LAUNCHER "$HELPER_SCRIPT" >"$HELPER_LOG" 2>&1; then
  echo "repro: helper exited non-zero. log follows:" >&2
  tail -n 80 "$HELPER_LOG" >&2 || true
  if [[ -f "$HELPER_OUT" ]]; then
    cat "$HELPER_OUT" >&2 || true
  fi
  exit 1
fi

if [[ ! -s "$HELPER_OUT" ]]; then
  echo "repro: helper produced no output (log follows):" >&2
  tail -n 80 "$HELPER_LOG" >&2 || true
  exit 1
fi

echo "repro: analyzing activity log entries..."
ANALYSIS_OUT="$TMP_DIR/analysis.json"
EXPECT_ISSUE="$EXPECT_ISSUE" HELPER_OUT="$HELPER_OUT" ANALYSIS_OUT="$ANALYSIS_OUT" \
python3 - <<'PY'
import json
import os
import sys

helper_path = os.environ["HELPER_OUT"]
analysis_path = os.environ["ANALYSIS_OUT"]
expect_issue = os.environ.get("EXPECT_ISSUE", "0") == "1"

with open(helper_path, "r", encoding="utf-8") as f:
    helper = json.load(f)

if not helper.get("ok"):
    print(f"repro: helper failed: {helper.get('error')}", file=sys.stderr)
    sys.exit(1)

logs = helper.get("logs", [])
entries = []
for row in logs:
    if not isinstance(row, dict):
        continue
    source = row.get("source")
    if source not in ("ui-perf", "startup-phase"):
        continue
    msg = row.get("message")
    if not isinstance(msg, str):
        continue
    try:
        payload = json.loads(msg)
    except Exception:
        continue
    entries.append({
        "id": row.get("id"),
        "timestamp": row.get("timestamp"),
        "source": source,
        "payload": payload,
    })

def metric(name):
    return next((e for e in entries if e["source"] == "ui-perf" and e["payload"].get("metric") == name), None)

def metric_after(name, after_id):
    return next((e for e in entries if e["source"] == "ui-perf" and e["payload"].get("metric") == name and (e["id"] or 0) > after_id), None)

bootstrap = metric("preload_bootstrap_sync")
graph_visible = metric("startup_workflow_graph_visible")
snapshot_applied = metric("startup_snapshot_applied")

# All useTasks_snapshot_replace events, in insertion order.
snapshot_replaces = [
    e for e in entries
    if e["source"] == "ui-perf" and e["payload"].get("metric") == "useTasks_snapshot_replace"
]

# Redundant snapshot = a non-forced useTasks_snapshot_replace that fires
# after preload_bootstrap_sync (i.e. the post-bootstrap refresh).
redundant = None
if bootstrap is not None:
    bootstrap_id = bootstrap["id"] or 0
    for e in snapshot_replaces:
        if (e["id"] or 0) <= bootstrap_id:
            continue
        if not e["payload"].get("forceRefresh"):
            redundant = e
            break

summary = {
    "bootstrap": bootstrap and bootstrap["payload"],
    "graph_visible": graph_visible and graph_visible["payload"],
    "snapshot_applied": snapshot_applied and snapshot_applied["payload"],
    "snapshot_replaces": [e["payload"] for e in snapshot_replaces],
    "redundant_post_bootstrap_snapshot": redundant and redundant["payload"],
}
with open(analysis_path, "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)

print("repro-summary:")
if bootstrap:
    bp = bootstrap["payload"]
    print(f"  preload_bootstrap_sync.taskCount: {bp.get('taskCount')}")
    print(f"  preload_bootstrap_sync.workflowCount: {bp.get('workflowCount')}")
    print(f"  preload_bootstrap_sync.jsonSizeBytes: {bp.get('jsonSizeBytes')}")
    print(f"  preload_bootstrap_sync.durationMs: {bp.get('durationMs')}")
else:
    print("  preload_bootstrap_sync: <missing>")

if graph_visible:
    gp = graph_visible["payload"]
    print(f"  startup_workflow_graph_visible.elapsedMs: {gp.get('elapsedMs')}")
    print(f"  startup_workflow_graph_visible.processElapsedMs: {gp.get('processElapsedMs')}")
    print(f"  startup_workflow_graph_visible.nodeCount: {gp.get('nodeCount')}")
    print(f"  startup_workflow_graph_visible.edgeCount: {gp.get('edgeCount')}")
else:
    print("  startup_workflow_graph_visible: <missing>")

if snapshot_replaces:
    print(f"  useTasks_snapshot_replace.count: {len(snapshot_replaces)}")
    for idx, e in enumerate(snapshot_replaces):
        p = e["payload"]
        print(f"  useTasks_snapshot_replace[{idx}].forceRefresh: {p.get('forceRefresh')}")
        print(f"  useTasks_snapshot_replace[{idx}].requestDurationMs: {p.get('requestDurationMs')}")
        print(f"  useTasks_snapshot_replace[{idx}].replaceDurationMs: {p.get('replaceDurationMs')}")
        print(f"  useTasks_snapshot_replace[{idx}].jsonSizeBytes: {p.get('jsonSizeBytes')}")
        print(f"  useTasks_snapshot_replace[{idx}].taskCount: {p.get('taskCount')}")
        print(f"  useTasks_snapshot_replace[{idx}].workflowCount: {p.get('workflowCount')}")
else:
    print("  useTasks_snapshot_replace: <none>")

if redundant:
    print(f"  redundant_post_bootstrap_snapshot.forced: {bool(redundant['payload'].get('forceRefresh'))}")
    print(f"  redundant_post_bootstrap_snapshot.requestDurationMs: {redundant['payload'].get('requestDurationMs')}")
    print(f"  redundant_post_bootstrap_snapshot.replaceDurationMs: {redundant['payload'].get('replaceDurationMs')}")
    print(f"  redundant_post_bootstrap_snapshot.jsonSizeBytes: {redundant['payload'].get('jsonSizeBytes')}")
else:
    print("  redundant_post_bootstrap_snapshot: <none>")

print(f"  expect_issue: {expect_issue}")

if bootstrap is None or graph_visible is None:
    print("repro: required ui-perf events missing — fixture failed to capture startup", file=sys.stderr)
    sys.exit(1)

if expect_issue:
    if redundant is None:
        print("repro: --expect-issue set but no redundant non-forced post-bootstrap snapshot observed.", file=sys.stderr)
        sys.exit(1)
    print("repro: PASS (baseline reproduces redundant post-bootstrap snapshot).")
else:
    if redundant is not None:
        print("repro: redundant non-forced post-bootstrap snapshot still present (optimization missing).", file=sys.stderr)
        sys.exit(1)
    print("repro: PASS (no redundant non-forced post-bootstrap snapshot).")
PY

popd >/dev/null
