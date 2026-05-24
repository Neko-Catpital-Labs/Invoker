#!/usr/bin/env bash
# Repro: redundant post-bootstrap startup snapshot refresh.
#
# Background: preload synchronously ships the full task/workflow graph to the
# renderer via `invoker:get-bootstrap-state-sync` (reported as
# `preload_bootstrap_sync`). Despite that, `useTasks` mounts and immediately
# issues a second non-forced `getTasks()` call (reported as
# `useTasks_snapshot_replace`) that re-serialises and re-applies the same
# graph, costing ~65-164ms and ~377KB on real-world data after the graph is
# already painted.
#
# This script drives an isolated Electron startup with multiple workflows and
# tasks, captures `ui-perf` activity_log entries from the restart, and prints
# the bootstrap + snapshot-replace + graph-visible metrics. It is designed to
# be rerun by CI or another agent without manual SQLite or DevTools access.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#                                                            [--workflows N]
#                                                            [--tasks-per-workflow N]
#
# Exit codes:
#   --expect-issue  : 0 when a non-forced `useTasks_snapshot_replace` event
#                     is observed after `preload_bootstrap_sync` (confirms the
#                     current baseline still exhibits the redundant refresh).
#   (no flag)       : 0 only when NO non-forced post-bootstrap snapshot replace
#                     is observed (the optimization is in place).
set -euo pipefail

EXPECT_ISSUE=0
WORKFLOWS="${REPRO_WORKFLOWS:-15}"
TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-8}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) WORKFLOWS="$2"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
DB_DIR="$TMP_DIR/db"
REMOTE_REPO="$TMP_DIR/remote.git"
CONFIG_PATH="$TMP_DIR/config.json"
# Helper.mjs must live inside packages/app so Node ESM resolution can find
# @playwright/test via the app's node_modules. NODE_PATH does not work for ESM.
HELPER_MJS="$APP_DIR/.repro-startup-snapshot-helper.mjs"
RESULT_JSON="$TMP_DIR/result.json"

cleanup() {
  rm -rf "$TMP_DIR"
  rm -f "$HELPER_MJS"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"
git init --bare "$REMOTE_REPO" >/dev/null 2>&1
cat >"$CONFIG_PATH" <<'JSON'
{"autoFixRetries":0,"disableAutoRunOnStartup":true}
JSON

pushd "$REPO_ROOT" >/dev/null
if [[ ! -f packages/app/dist/main.js ]] || [[ ! -f packages/ui/dist/index.html ]]; then
  echo "==> Building UI, surfaces, and app for repro..."
  pnpm --filter @invoker/ui build >/dev/null
  pnpm --filter @invoker/surfaces build >/dev/null
  pnpm --filter @invoker/app build >/dev/null
fi
node "$REPO_ROOT/scripts/electron.cjs" --ensure-only
popd >/dev/null

cat >"$HELPER_MJS" <<'MJS'
import { _electron as electron } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { stringify as yamlStringify } from 'yaml';

const DB_DIR = process.env.REPRO_DB_DIR;
const REMOTE_REPO = process.env.REPRO_REMOTE_REPO;
const CONFIG_PATH = process.env.REPRO_CONFIG_PATH;
const RESULT_PATH = process.env.REPRO_RESULT_PATH;
const MAIN_JS = process.env.REPRO_MAIN_JS;
const WORKFLOWS = Number(process.env.REPRO_WORKFLOWS);
const TASKS_PER_WORKFLOW = Number(process.env.REPRO_TASKS_PER_WORKFLOW);
const REPO_URL = `file://${REMOTE_REPO}`;

const linuxFlags = process.platform === 'linux'
  ? [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer',
    ]
  : [];

function launchArgs() {
  return [...linuxFlags, MAIN_JS];
}

function launchEnv() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    INVOKER_DB_DIR: DB_DIR,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
  };
}

function buildPlan(index) {
  return {
    name: `Startup Snapshot Repro ${index}`,
    repoUrl: REPO_URL,
    onFinish: 'none',
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, i) => ({
      id: `task-${index}-${i}`,
      description: `Task ${index}-${i}`,
      command: `echo task-${index}-${i}`,
      dependencies: i === 0 ? [] : [`task-${index}-${i - 1}`],
    })),
  };
}

async function seed() {
  const app = await electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30000 });
    for (let i = 0; i < WORKFLOWS; i += 1) {
      const planYaml = yamlStringify(buildPlan(i));
      await page.evaluate((planText) => window.invoker.loadPlan(planText), planYaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    // The orchestrator inserts a hidden __merge__ task per workflow regardless
    // of onFinish; count only the plan tasks to assert the seed shape.
    const planTasks = tasks.filter((t) => !t.config?.isMergeNode);
    const expected = WORKFLOWS * TASKS_PER_WORKFLOW;
    if (planTasks.length !== expected) {
      throw new Error(`seed: expected ${expected} plan tasks, got ${planTasks.length} (total tasks=${tasks.length})`);
    }
    const logs = await page.evaluate(() => window.invoker.getActivityLogs());
    const maxLogId = logs.reduce((acc, entry) => (entry.id > acc ? entry.id : acc), 0);
    return { maxLogId, taskCount: tasks.length };
  } finally {
    await app.close();
  }
}

async function measure(seedMaxLogId) {
  const restartStartedAt = Date.now();
  const app = await electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30000 });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({ state: 'visible', timeout: 30000 });
    // Allow the post-bootstrap getTasks() refresh and reporters to settle into
    // the activity_log before we read it.
    await page.waitForTimeout(2000);
    const logs = await page.evaluate(() => window.invoker.getActivityLogs());
    const restartLogs = logs.filter((entry) => entry.id > seedMaxLogId);
    writeFileSync(RESULT_PATH, JSON.stringify({
      restartStartedAt,
      seedMaxLogId,
      totalLogsReturned: logs.length,
      restartLogs,
    }, null, 2));
  } finally {
    await app.close();
  }
}

const seedResult = await seed();
await measure(seedResult.maxLogId);
MJS

NODE_CMD=(node "$HELPER_MJS")
if [[ "$(uname -s)" == "Linux" ]] && [[ -z "${DISPLAY:-}" ]] && command -v xvfb-run >/dev/null 2>&1; then
  NODE_CMD=(xvfb-run --auto-servernum node "$HELPER_MJS")
fi

echo "==> Running Electron seed + measure pass ($WORKFLOWS workflows x $TASKS_PER_WORKFLOW tasks)..."
pushd "$APP_DIR" >/dev/null
REPRO_DB_DIR="$DB_DIR" \
REPRO_REMOTE_REPO="$REMOTE_REPO" \
REPRO_CONFIG_PATH="$CONFIG_PATH" \
REPRO_RESULT_PATH="$RESULT_JSON" \
REPRO_MAIN_JS="$APP_DIR/dist/main.js" \
REPRO_WORKFLOWS="$WORKFLOWS" \
REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  "${NODE_CMD[@]}"
popd >/dev/null

echo "==> Analyzing captured activity logs..."
python3 - "$RESULT_JSON" "$EXPECT_ISSUE" <<'PY'
import json
import sys

result_path = sys.argv[1]
expect_issue = sys.argv[2] == "1"

with open(result_path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

logs = data.get("restartLogs", [])

ui_perf = []
for entry in logs:
    if entry.get("source") != "ui-perf":
        continue
    try:
        payload = json.loads(entry.get("message", ""))
    except json.JSONDecodeError:
        continue
    if not isinstance(payload, dict):
        continue
    ui_perf.append({
        "id": entry["id"],
        "timestamp": entry.get("timestamp"),
        "metric": payload.get("metric"),
        "payload": payload,
    })

def first(metric, predicate=lambda p: True):
    for entry in ui_perf:
        if entry["metric"] == metric and predicate(entry["payload"]):
            return entry
    return None

bootstrap = first("preload_bootstrap_sync")
snapshot_replaces = [e for e in ui_perf if e["metric"] == "useTasks_snapshot_replace"]
post_bootstrap = []
if bootstrap is not None:
    post_bootstrap = [e for e in snapshot_replaces if e["id"] > bootstrap["id"]]
non_forced_post_bootstrap = [
    e for e in post_bootstrap if not bool(e["payload"].get("forceRefresh"))
]
graph_visible = first("startup_workflow_graph_visible")
task_graph_visible = first("startup_graph_visible")

print("repro-summary:")
if bootstrap:
    bp = bootstrap["payload"]
    print("  preload_bootstrap_sync:")
    print(f"    taskCount:     {bp.get('taskCount')}")
    print(f"    workflowCount: {bp.get('workflowCount')}")
    print(f"    jsonSizeBytes: {bp.get('jsonSizeBytes')}")
    print(f"    durationMs:    {bp.get('durationMs')}")
else:
    print("  preload_bootstrap_sync: <missing>")

print(f"  useTasks_snapshot_replace events total: {len(snapshot_replaces)}")
print(f"  useTasks_snapshot_replace events after bootstrap: {len(post_bootstrap)}")
print(f"  non-forced post-bootstrap snapshot replaces: {len(non_forced_post_bootstrap)}")

if snapshot_replaces:
    first_replace = snapshot_replaces[0]["payload"]
    print("  first useTasks_snapshot_replace:")
    print(f"    forceRefresh:       {bool(first_replace.get('forceRefresh'))}")
    print(f"    requestDurationMs:  {first_replace.get('requestDurationMs')}")
    print(f"    replaceDurationMs:  {first_replace.get('replaceDurationMs')}")
    print(f"    jsonSizeBytes:      {first_replace.get('jsonSizeBytes')}")
    print(f"    taskCount:          {first_replace.get('taskCount')}")
    print(f"    workflowCount:      {first_replace.get('workflowCount')}")
else:
    print("  useTasks_snapshot_replace: <none captured>")

if graph_visible:
    gp = graph_visible["payload"]
    print("  startup_workflow_graph_visible:")
    print(f"    nodeCount:        {gp.get('nodeCount')}")
    print(f"    edgeCount:        {gp.get('edgeCount')}")
    print(f"    elapsedMs:        {gp.get('elapsedMs')}")
    print(f"    processElapsedMs: {gp.get('processElapsedMs')}")
else:
    print("  startup_workflow_graph_visible: <missing>")

if task_graph_visible:
    tp = task_graph_visible["payload"]
    print("  startup_graph_visible (task DAG):")
    print(f"    nodeCount:        {tp.get('nodeCount')}")
    print(f"    elapsedMs:        {tp.get('elapsedMs')}")
    print(f"    processElapsedMs: {tp.get('processElapsedMs')}")

if expect_issue:
    if non_forced_post_bootstrap:
        print("\n[PASS] --expect-issue: observed a non-forced useTasks_snapshot_replace after preload_bootstrap_sync.")
        sys.exit(0)
    print("\n[FAIL] --expect-issue: no non-forced post-bootstrap snapshot replace was captured.", file=sys.stderr)
    sys.exit(1)

if not non_forced_post_bootstrap:
    print("\n[PASS] no redundant non-forced startup snapshot observed after preload_bootstrap_sync.")
    sys.exit(0)

print("\n[FAIL] redundant non-forced useTasks_snapshot_replace still occurs after preload_bootstrap_sync.", file=sys.stderr)
sys.exit(1)
PY
