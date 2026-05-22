#!/usr/bin/env bash
# Repro for the redundant post-bootstrap startup snapshot request.
#
# Background
#   On startup the preload script issues a synchronous IPC bootstrap call
#   (`invoker:get-bootstrap-state-sync`) and exposes the result to the
#   renderer via `window.__INVOKER_BOOTSTRAP__`. `useTasks` seeds its
#   state from that bootstrap and, in `useEffect`, immediately calls
#   `window.invoker.getTasks()` again WITHOUT `forceRefresh=true`. That
#   second call re-fetches the entire workflow/task snapshot that was
#   already serialized into the bootstrap state — measured at ~65-164ms
#   request time and ~377KB of IPC payload after the graph is already
#   visible on the user's screen.
#
# What this script does
#   1. Builds the Electron app if needed.
#   2. Spins up an isolated INVOKER_DB_DIR plus a bare git remote so the
#      app can persist plans without touching the user's real ~/.invoker
#      data.
#   3. Phase 1 (seed): launches Electron via Playwright's `_electron`
#      driver and loads N workflows × M tasks through `window.invoker.loadPlan`.
#   4. Phase 2 (observe): re-launches Electron against the seeded DB,
#      waits for the workflow graph to render, then pulls
#      `invoker:get-activity-logs` and locates the `ui-perf` entries for
#      `preload_bootstrap_sync`, `useTasks_snapshot_replace`,
#      `startup_workflow_graph_visible`, and `startup_graph_visible`.
#   5. Reports the bootstrap counts/byte size, the snapshot request/
#      replace timings, graph-visible timing, and whether the redundant
#      snapshot was forced.
#
# Exit semantics
#   Default (post-optimization): exit 0 only when there is NO non-forced
#   `useTasks_snapshot_replace` after `preload_bootstrap_sync`.
#   --expect-issue (baseline): exit 0 when the redundant non-forced
#   `useTasks_snapshot_replace` IS observed (bug is reproducible).
#
# Env overrides
#   SNAPSHOT_REPRO_WORKFLOWS         (default 6) workflows to seed
#   SNAPSHOT_REPRO_TASKS_PER_WORKFLOW(default 8) tasks per workflow
#   SNAPSHOT_REPRO_WAIT_MS           (default 4000) extra settle window
#                                                   after graph visible
#   SNAPSHOT_REPRO_KEEP_TMP          set 1 to keep the temp dir on exit

set -euo pipefail

EXPECT_ISSUE=0
WORKFLOW_COUNT="${SNAPSHOT_REPRO_WORKFLOWS:-6}"
TASKS_PER_WORKFLOW="${SNAPSHOT_REPRO_TASKS_PER_WORKFLOW:-8}"
SETTLE_MS="${SNAPSHOT_REPRO_WAIT_MS:-4000}"
KEEP_TMP="${SNAPSHOT_REPRO_KEEP_TMP:-0}"

print_help() {
  cat <<'USAGE'
Usage: scripts/repro/repro-startup-snapshot-refresh-overhead.sh [options]

Options:
  --expect-issue                  Baseline mode. Exit 0 iff the redundant
                                  non-forced useTasks_snapshot_replace after
                                  preload_bootstrap_sync is observed.
  --workflows N                   Seed N workflows (default 6).
  --tasks-per-workflow N          Seed N tasks per workflow (default 8).
  --settle-ms N                   Wait N ms after graph visible to capture
                                  any post-bootstrap snapshot (default 4000).
  --keep-tmp                      Do not delete the temporary workspace.
  -h, --help                      Print this help.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    --settle-ms) SETTLE_MS="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    -h|--help) print_help; exit 0 ;;
    *) echo "repro: unknown argument '$1'" >&2; print_help >&2; exit 64 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
DB_DIR="$TMP_DIR/db"
BARE_REPO="$TMP_DIR/bare.git"
CLAUDE_STUB_DIR="$TMP_DIR/claude-stub"
CONFIG_PATH="$TMP_DIR/config.json"
RESULT_PATH="$TMP_DIR/result.json"
DRIVER_PATH="$TMP_DIR/driver.cjs"
DRIVER_LOG="$TMP_DIR/driver.log"
mkdir -p "$DB_DIR" "$CLAUDE_STUB_DIR"

cleanup() {
  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "repro: keeping temp dir: $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

pushd "$REPO_ROOT" >/dev/null

if [[ ! -f packages/app/dist/main.js || ! -f packages/app/dist/preload.js ]]; then
  echo "repro: building Electron app (missing dist artifacts)..." >&2
  pnpm --filter @invoker/ui build >&2
  pnpm --filter @invoker/surfaces build >&2
  pnpm --filter @invoker/app build >&2
fi

if [[ ! -d packages/app/node_modules/@playwright/test ]]; then
  echo "repro: @playwright/test is required (run pnpm install in packages/app)" >&2
  exit 2
fi

git init --bare --quiet "$BARE_REPO"
REPO_URL="file://$BARE_REPO"

cat > "$CONFIG_PATH" <<'JSON'
{"autoFixRetries":0,"disableAutoRunOnStartup":true,"maxConcurrency":1}
JSON

# Marker stub for the `claude` CLI so the Electron app does not refuse to
# load when scanning PATH. The repro never invokes a real model.
cat > "$CLAUDE_STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$CLAUDE_STUB_DIR/claude"

cat > "$DRIVER_PATH" <<'NODE_EOF'
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(process.env.SNAPSHOT_REPRO_APP_ROOT);
const mainJs = path.join(appRoot, 'packages', 'app', 'dist', 'main.js');
const dbDir = process.env.SNAPSHOT_REPRO_DB_DIR;
const repoUrl = process.env.SNAPSHOT_REPRO_REPO_URL;
const configPath = process.env.SNAPSHOT_REPRO_CONFIG_PATH;
const resultPath = process.env.SNAPSHOT_REPRO_RESULT_PATH;
const claudeStubDir = process.env.SNAPSHOT_REPRO_CLAUDE_STUB_DIR;
const workflowCount = Number(process.env.SNAPSHOT_REPRO_WORKFLOWS || '6');
const tasksPerWorkflow = Number(process.env.SNAPSHOT_REPRO_TASKS_PER_WORKFLOW || '8');
const settleMs = Number(process.env.SNAPSHOT_REPRO_SETTLE_MS || '4000');

const { _electron: electron } = require(
  require.resolve('@playwright/test', { paths: [path.join(appRoot, 'packages', 'app')] }),
);

const yaml = require(
  require.resolve('yaml', { paths: [path.join(appRoot, 'packages', 'app')] }),
);

const linuxFlags = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing',
     '--disable-gpu-sandbox', '--disable-software-rasterizer']
  : [];

function launchArgs() {
  return [...linuxFlags, mainJs];
}

function launchEnv(extra) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    INVOKER_DB_DIR: dbDir,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    INVOKER_CLAUDE_COMMAND: path.join(claudeStubDir, 'claude'),
    INVOKER_CLAUDE_FIX_COMMAND: path.join(claudeStubDir, 'claude'),
    PATH: `${claudeStubDir}${path.delimiter}${process.env.PATH || ''}`,
    ...(extra || {}),
  };
}

function buildPlan(idx) {
  const tasks = [];
  for (let t = 0; t < tasksPerWorkflow; t += 1) {
    tasks.push({
      id: `task-${idx}-${t}`,
      description: `Seed task ${idx}-${t}`,
      command: 'true',
      dependencies: t === 0 ? [] : [`task-${idx}-${t - 1}`],
    });
  }
  return {
    name: `Snapshot Refresh Repro Plan ${idx}`,
    repoUrl,
    onFinish: 'none',
    tasks,
  };
}

async function waitForBridge(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, {
    timeout: 20000,
  });
}

async function seedPhase() {
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv(),
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await waitForBridge(page);
    for (let i = 0; i < workflowCount; i += 1) {
      const planYaml = yaml.stringify(buildPlan(i));
      await page.evaluate(async (text) => {
        await window.invoker.loadPlan(text);
      }, planYaml);
    }
    const seeded = await page.evaluate(async () => {
      const r = await window.invoker.getTasks(true);
      const tasks = Array.isArray(r) ? r : r.tasks;
      const workflows = Array.isArray(r) ? [] : (r.workflows || []);
      return { taskCount: tasks.length, workflowCount: workflows.length };
    });
    const expectedTasks = workflowCount * tasksPerWorkflow;
    if (seeded.taskCount < expectedTasks || seeded.workflowCount < workflowCount) {
      throw new Error(
        `seed phase persisted ${seeded.taskCount}/${expectedTasks} tasks ` +
        `and ${seeded.workflowCount}/${workflowCount} workflows`,
      );
    }
  } finally {
    await app.close();
  }
}

function parseEntry(entry) {
  try {
    return { ...entry, payload: JSON.parse(entry.message) };
  } catch {
    return null;
  }
}

async function observePhase() {
  const app = await electron.launch({
    args: launchArgs(),
    env: launchEnv({ INVOKER_TEST_RESUME_PENDING_DELAY_MS: '60000' }),
    timeout: 60000,
  });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await waitForBridge(page);

    await page.waitForFunction(
      () => Boolean(window.__INVOKER_BOOTSTRAP__),
      null,
      { timeout: 20000 },
    );

    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: 30000,
    });

    await page.waitForFunction(
      async (expectedMetric) => {
        const logs = await window.invoker.getActivityLogs();
        return logs.some((e) => {
          if (e.source !== 'ui-perf') return false;
          try {
            return JSON.parse(e.message).metric === expectedMetric;
          } catch {
            return false;
          }
        });
      },
      'startup_workflow_graph_visible',
      { timeout: 20000 },
    );

    // Give the renderer a settle window so any redundant snapshot replace
    // from useTasks's useEffect lands in the activity log before we sample.
    await page.waitForTimeout(settleMs);

    const rawLogs = await page.evaluate(() => window.invoker.getActivityLogs());
    const perfEntries = rawLogs
      .filter((e) => e.source === 'ui-perf')
      .map(parseEntry)
      .filter((e) => e && e.payload && typeof e.payload.metric === 'string');

    const findFirst = (metric, predicate) => perfEntries.find(
      (e) => e.payload.metric === metric && (predicate ? predicate(e.payload) : true),
    );
    const findAll = (metric, predicate) => perfEntries.filter(
      (e) => e.payload.metric === metric && (predicate ? predicate(e.payload) : true),
    );

    const bootstrapSync = findFirst('preload_bootstrap_sync');
    const graphVisible = findFirst('startup_workflow_graph_visible');
    const taskGraphVisible = findFirst('startup_graph_visible');
    const startupBootstrapState = findFirst('startup_bootstrap_state');
    const allSnapshotReplaces = findAll('useTasks_snapshot_replace');
    const allSnapshotSkips = findAll('startup_snapshot_skipped_smaller_than_bootstrap');

    // The redundant replace is the first non-forced replace that lands
    // after preload_bootstrap_sync. With sql.js insertion ordering, log id
    // is monotonic per-write so id comparison is reliable.
    const bootstrapId = bootstrapSync ? bootstrapSync.id : -1;
    const redundantReplace = allSnapshotReplaces.find(
      (e) => e.id > bootstrapId && e.payload.forceRefresh === false,
    );

    const result = {
      workflowCount,
      tasksPerWorkflow,
      settleMs,
      bootstrap: bootstrapSync ? {
        taskCount: bootstrapSync.payload.taskCount,
        workflowCount: bootstrapSync.payload.workflowCount,
        jsonSizeBytes: bootstrapSync.payload.jsonSizeBytes,
        durationMs: bootstrapSync.payload.durationMs,
        processElapsedMs: bootstrapSync.payload.processElapsedMs,
        activityLogId: bootstrapSync.id,
      } : null,
      startupBootstrapState: startupBootstrapState ? startupBootstrapState.payload : null,
      snapshotReplaces: allSnapshotReplaces.map((e) => ({
        activityLogId: e.id,
        afterBootstrap: e.id > bootstrapId,
        forceRefresh: e.payload.forceRefresh,
        taskCount: e.payload.taskCount,
        workflowCount: e.payload.workflowCount,
        requestDurationMs: e.payload.requestDurationMs,
        replaceDurationMs: e.payload.replaceDurationMs,
        jsonSizeBytes: e.payload.jsonSizeBytes,
      })),
      snapshotSkips: allSnapshotSkips.map((e) => ({
        activityLogId: e.id,
        afterBootstrap: e.id > bootstrapId,
        bootstrapTaskCount: e.payload.bootstrapTaskCount,
        snapshotTaskCount: e.payload.snapshotTaskCount,
        requestDurationMs: e.payload.requestDurationMs,
      })),
      redundantReplace: redundantReplace ? {
        activityLogId: redundantReplace.id,
        forceRefresh: redundantReplace.payload.forceRefresh,
        taskCount: redundantReplace.payload.taskCount,
        workflowCount: redundantReplace.payload.workflowCount,
        requestDurationMs: redundantReplace.payload.requestDurationMs,
        replaceDurationMs: redundantReplace.payload.replaceDurationMs,
        jsonSizeBytes: redundantReplace.payload.jsonSizeBytes,
      } : null,
      workflowGraphVisible: graphVisible ? {
        activityLogId: graphVisible.id,
        nodeCount: graphVisible.payload.nodeCount,
        edgeCount: graphVisible.payload.edgeCount,
        elapsedMs: graphVisible.payload.elapsedMs,
        processElapsedMs: graphVisible.payload.processElapsedMs,
      } : null,
      taskGraphVisible: taskGraphVisible ? {
        activityLogId: taskGraphVisible.id,
        nodeCount: taskGraphVisible.payload.nodeCount,
        elapsedMs: taskGraphVisible.payload.elapsedMs,
        processElapsedMs: taskGraphVisible.payload.processElapsedMs,
      } : null,
    };

    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

(async () => {
  await seedPhase();
  await observePhase();
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
NODE_EOF

run_driver() {
  if [[ "$(uname -s)" == "Linux" ]] && [[ -z "${DISPLAY:-}" ]] && command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run --auto-servernum node "$DRIVER_PATH"
  else
    node "$DRIVER_PATH"
  fi
}

echo "repro: seeding $WORKFLOW_COUNT workflows × $TASKS_PER_WORKFLOW tasks and observing startup snapshot..." >&2
export SNAPSHOT_REPRO_APP_ROOT="$REPO_ROOT"
export SNAPSHOT_REPRO_DB_DIR="$DB_DIR"
export SNAPSHOT_REPRO_REPO_URL="$REPO_URL"
export SNAPSHOT_REPRO_CONFIG_PATH="$CONFIG_PATH"
export SNAPSHOT_REPRO_RESULT_PATH="$RESULT_PATH"
export SNAPSHOT_REPRO_CLAUDE_STUB_DIR="$CLAUDE_STUB_DIR"
export SNAPSHOT_REPRO_WORKFLOWS="$WORKFLOW_COUNT"
export SNAPSHOT_REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
export SNAPSHOT_REPRO_SETTLE_MS="$SETTLE_MS"

if ! run_driver >"$DRIVER_LOG" 2>&1; then
  echo "repro: Electron driver failed. Driver log:" >&2
  tail -n 200 "$DRIVER_LOG" >&2 || true
  exit 2
fi

if [[ ! -s "$RESULT_PATH" ]]; then
  echo "repro: driver produced no result file. Driver log:" >&2
  tail -n 200 "$DRIVER_LOG" >&2 || true
  exit 2
fi

popd >/dev/null

EXPECT_ISSUE="$EXPECT_ISSUE" RESULT_PATH="$RESULT_PATH" python3 - <<'PY'
import json
import os
import sys

with open(os.environ['RESULT_PATH'], 'r', encoding='utf-8') as f:
    result = json.load(f)

bootstrap = result.get('bootstrap')
redundant = result.get('redundantReplace')
graph = result.get('workflowGraphVisible')
task_graph = result.get('taskGraphVisible')

def fmt(value):
    if value is None:
        return 'n/a'
    if isinstance(value, float):
        return f'{value:.2f}'
    return str(value)

print('repro-startup-snapshot-refresh-overhead:')
print(f"  seeded_workflows                            : {result['workflowCount']}")
print(f"  seeded_tasks_per_workflow                   : {result['tasksPerWorkflow']}")
if bootstrap:
    print('  preload_bootstrap_sync:')
    print(f"    taskCount                                 : {fmt(bootstrap.get('taskCount'))}")
    print(f"    workflowCount                             : {fmt(bootstrap.get('workflowCount'))}")
    print(f"    jsonSizeBytes                             : {fmt(bootstrap.get('jsonSizeBytes'))}")
    print(f"    durationMs                                : {fmt(bootstrap.get('durationMs'))}")
else:
    print('  preload_bootstrap_sync                      : MISSING')

if redundant:
    print('  useTasks_snapshot_replace (post-bootstrap, non-forced):')
    print(f"    forceRefresh                              : {fmt(redundant.get('forceRefresh'))}")
    print(f"    requestDurationMs                         : {fmt(redundant.get('requestDurationMs'))}")
    print(f"    replaceDurationMs                         : {fmt(redundant.get('replaceDurationMs'))}")
    print(f"    jsonSizeBytes                             : {fmt(redundant.get('jsonSizeBytes'))}")
    print(f"    taskCount                                 : {fmt(redundant.get('taskCount'))}")
    print(f"    workflowCount                             : {fmt(redundant.get('workflowCount'))}")
else:
    print('  useTasks_snapshot_replace (post-bootstrap, non-forced): NONE')

replaces = result.get('snapshotReplaces') or []
forced_after = [r for r in replaces if r.get('afterBootstrap') and r.get('forceRefresh')]
if forced_after:
    print(f"  forced_useTasks_snapshot_replace_after_bootstrap: {len(forced_after)}")

skips = result.get('snapshotSkips') or []
post_skips = [s for s in skips if s.get('afterBootstrap')]
if post_skips:
    print(f"  startup_snapshot_skipped_smaller_than_bootstrap_after_bootstrap: {len(post_skips)}")

if graph:
    print('  startup_workflow_graph_visible:')
    print(f"    nodeCount                                 : {fmt(graph.get('nodeCount'))}")
    print(f"    edgeCount                                 : {fmt(graph.get('edgeCount'))}")
    print(f"    elapsedMs                                 : {fmt(graph.get('elapsedMs'))}")
    print(f"    processElapsedMs                          : {fmt(graph.get('processElapsedMs'))}")
else:
    print('  startup_workflow_graph_visible              : MISSING')

if task_graph:
    print('  startup_graph_visible:')
    print(f"    nodeCount                                 : {fmt(task_graph.get('nodeCount'))}")
    print(f"    elapsedMs                                 : {fmt(task_graph.get('elapsedMs'))}")
    print(f"    processElapsedMs                          : {fmt(task_graph.get('processElapsedMs'))}")

expect_issue = os.environ['EXPECT_ISSUE'] == '1'
has_issue = redundant is not None

if expect_issue:
    if has_issue:
        print('  result                                      : OK (baseline reproduced redundant snapshot)')
        sys.exit(0)
    print(
        '  result                                      : FAIL '
        '(--expect-issue set but no non-forced useTasks_snapshot_replace landed after preload_bootstrap_sync)',
        file=sys.stderr,
    )
    sys.exit(1)
else:
    if not has_issue:
        print('  result                                      : OK (no redundant non-forced snapshot replace after bootstrap)')
        sys.exit(0)
    print(
        '  result                                      : FAIL '
        '(post-optimization run still observed a non-forced useTasks_snapshot_replace after preload_bootstrap_sync)',
        file=sys.stderr,
    )
    sys.exit(1)
PY
