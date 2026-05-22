#!/usr/bin/env bash
# Reproduce the redundant post-bootstrap startup snapshot request.
#
# After preload bootstrap hydrates window.__INVOKER_BOOTSTRAP__ with the full
# task/workflow state, useTasks still fires a non-forced getTasks() on mount,
# producing a second snapshot replace (~65-164ms request + ~377KB payload in
# the observed traces) for data the renderer already has.
#
# This script drives an isolated Electron startup against a seeded DB so that
# the regression is observable without manual interaction:
#   * --expect-issue : exit 0 when the redundant non-forced
#     useTasks_snapshot_replace IS observed after preload_bootstrap_sync
#     (the current baseline). Use this to detect regressions before the fix
#     lands.
#   * (default)      : exit 0 only when NO redundant non-forced startup
#     snapshot is observed (post-fix). Use this to confirm the optimization
#     stayed in place.
#
# Environment overrides:
#   WORKFLOW_COUNT (default 5)        seeded workflow count
#   TASKS_PER_WORKFLOW (default 8)    tasks per seeded workflow
#   INVOKER_REPRO_KEEP_TMP=1          retain tmp dir for debugging
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
       [--workflows N] [--tasks-per-workflow N] [-h|--help]
USAGE
}

EXPECT_ISSUE=0
WORKFLOW_COUNT="${WORKFLOW_COUNT:-5}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-8}"
KEEP_TMP="${INVOKER_REPRO_KEEP_TMP:-0}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift;;
    --workflows) WORKFLOW_COUNT="$2"; shift 2;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
SUMMARY_JSON="$TMP_DIR/summary.json"
DRIVER_LOG="$TMP_DIR/driver.log"
DRIVER_PATH="$TMP_DIR/driver.mjs"
BARE_REPO="$TMP_DIR/e2e-repo.git"

cleanup() {
  if [[ "$KEEP_TMP" = "1" ]]; then
    echo "repro: keeping tmp dir $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

pushd "$ROOT_DIR" >/dev/null

# Ensure renderer + main bundles exist (the driver launches packages/app/dist/main.js).
needs_build=0
for marker in packages/ui/dist/index.html packages/surfaces/dist/index.js packages/app/dist/main.js; do
  if [[ ! -f "$marker" ]]; then
    needs_build=1
    break
  fi
done
if [[ "$needs_build" -eq 1 ]]; then
  echo "repro: building @invoker/ui, @invoker/surfaces, @invoker/app..." >&2
  pnpm --filter @invoker/ui --filter @invoker/surfaces --filter @invoker/app build >/dev/null
fi

# Local bare repo used as the plan repoUrl (matches the e2e fixture pattern).
git init --bare "$BARE_REPO" >/dev/null 2>&1
SEED_CLONE="$TMP_DIR/e2e-repo.clone"
git clone -q "$BARE_REPO" "$SEED_CLONE"
(
  cd "$SEED_CLONE"
  git -c user.email=ci@invoker.dev -c user.name='Invoker Repro' commit --allow-empty -q -m init
  git push -q origin HEAD:refs/heads/master
  git push -q origin HEAD:refs/heads/main
)
rm -rf "$SEED_CLONE"

cat > "$DRIVER_PATH" <<'MJS'
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stringify as yamlStringify } from 'yaml';

const repoRoot = process.env.INVOKER_REPRO_REPO_ROOT;
const bareRepo = process.env.INVOKER_REPRO_BARE_REPO;
const summaryPath = process.env.INVOKER_REPRO_SUMMARY;
const expectIssue = process.env.INVOKER_REPRO_EXPECT_ISSUE === '1';
const workflowCount = Number(process.env.INVOKER_REPRO_WORKFLOWS ?? '5');
const tasksPerWorkflow = Number(process.env.INVOKER_REPRO_TASKS ?? '8');
const repoUrl = pathToFileURL(bareRepo).href;
const dbDir = mkdtempSync(path.join(tmpdir(), 'invoker-repro-startup-'));

async function launchApp(extraEnv = {}) {
  const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
  const stubDir = path.join(dbDir, 'claude-stub');
  const configPath = path.join(dbDir, 'config.json');
  const ipcSocketPath = path.join(dbDir, 'ipc.sock');
  await mkdir(stubDir, { recursive: true });
  // disableAutoRunOnStartup keeps the seeded tasks pending across restart so
  // the startup snapshot stays representative of "loaded but idle".
  writeFileSync(
    configPath,
    JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }),
    'utf8',
  );
  try { symlinkSync(claudeMarker, path.join(stubDir, 'claude')); } catch {}
  return electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
           '--disable-gpu-compositing', '--disable-gpu-sandbox',
           '--disable-software-rasterizer']
        : []),
      path.join(repoRoot, 'packages', 'app', 'dist', 'main.js'),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: dbDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
}

function buildPlan(index) {
  return {
    name: `Startup Snapshot Repro ${index}`,
    repoUrl,
    onFinish: 'none',
    tasks: Array.from({ length: tasksPerWorkflow }, (_, i) => ({
      id: `task-${index}-${i}`,
      description: `Task ${index}-${i}`,
      command: `echo task-${index}-${i}`,
      dependencies: i === 0 ? [] : [`task-${index}-${i - 1}`],
    })),
  };
}

async function collectStartupSnapshot() {
  const app = await launchApp({ INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000' });
  try {
    const page = await app.firstWindow({ timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15000 });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: 15000,
    });
    // Give the renderer a moment so a post-bootstrap snapshot refresh has time
    // to be invoked and logged before we drain the activity_log.
    await page.waitForTimeout(2500);
    return page.evaluate(async () => ({
      activityLogs: await window.invoker.getActivityLogs(),
      perf: await window.invoker.getUiPerfStats(),
    }));
  } finally {
    await app.close();
  }
}

let exitCode = 1;
try {
  // Phase 1 — seed the DB with multiple workflows/tasks.
  const seed = await launchApp();
  try {
    const page = await seed.firstWindow({ timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15000 });
    for (let i = 0; i < workflowCount; i += 1) {
      const yaml = yamlStringify(buildPlan(i));
      await page.evaluate((y) => window.invoker.loadPlan(y), yaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    const expected = workflowCount * tasksPerWorkflow;
    if (tasks.length !== expected) {
      throw new Error(`seed expected ${expected} tasks, got ${tasks.length}`);
    }
  } finally {
    await seed.close();
  }

  // Phase 2 — measure the cold-start snapshot behavior against the seeded DB.
  const collected = await collectStartupSnapshot();

  const events = [];
  for (const entry of collected.activityLogs) {
    if (entry.source !== 'ui-perf') continue;
    let payload;
    try { payload = JSON.parse(entry.message); } catch { continue; }
    if (!payload || typeof payload !== 'object') continue;
    events.push({
      id: entry.id,
      timestamp: entry.timestamp,
      metric: payload.metric,
      payload,
    });
  }

  const firstOf = (metric) => events.find((e) => e.metric === metric);
  const bootstrap = firstOf('preload_bootstrap_sync');
  const graphVisible =
    firstOf('startup_workflow_graph_visible') ?? firstOf('startup_graph_visible');

  const snapshotEvents = events.filter((e) => e.metric === 'useTasks_snapshot_replace');
  const postBootstrapSnapshots = bootstrap
    ? snapshotEvents.filter((e) => e.id > bootstrap.id)
    : snapshotEvents;
  const redundantSnapshot = postBootstrapSnapshots.find(
    (e) => e.payload?.forceRefresh === false,
  );

  const summary = {
    expectIssue,
    workflowCount,
    tasksPerWorkflow,
    bootstrap: bootstrap
      ? {
          timestamp: bootstrap.timestamp,
          taskCount: bootstrap.payload.taskCount,
          workflowCount: bootstrap.payload.workflowCount,
          jsonSizeBytes: bootstrap.payload.jsonSizeBytes,
          durationMs: bootstrap.payload.durationMs,
          processElapsedMs: bootstrap.payload.processElapsedMs,
        }
      : null,
    graphVisible: graphVisible
      ? {
          metric: graphVisible.metric,
          timestamp: graphVisible.timestamp,
          elapsedMs: graphVisible.payload.elapsedMs,
          processElapsedMs: graphVisible.payload.processElapsedMs,
          nodeCount: graphVisible.payload.nodeCount,
          edgeCount: graphVisible.payload.edgeCount,
        }
      : null,
    snapshotEvents: snapshotEvents.map((e) => ({
      timestamp: e.timestamp,
      forceRefresh: e.payload.forceRefresh,
      taskCount: e.payload.taskCount,
      workflowCount: e.payload.workflowCount,
      requestDurationMs: e.payload.requestDurationMs,
      replaceDurationMs: e.payload.replaceDurationMs,
      jsonSizeBytes: e.payload.jsonSizeBytes,
      postBootstrap: bootstrap ? e.id > bootstrap.id : null,
    })),
    redundantSnapshot: redundantSnapshot
      ? {
          timestamp: redundantSnapshot.timestamp,
          forceRefresh: redundantSnapshot.payload.forceRefresh,
          taskCount: redundantSnapshot.payload.taskCount,
          workflowCount: redundantSnapshot.payload.workflowCount,
          requestDurationMs: redundantSnapshot.payload.requestDurationMs,
          replaceDurationMs: redundantSnapshot.payload.replaceDurationMs,
          jsonSizeBytes: redundantSnapshot.payload.jsonSizeBytes,
        }
      : null,
  };
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  const sawRedundant = summary.redundantSnapshot !== null;
  exitCode = expectIssue ? (sawRedundant ? 0 : 1) : (sawRedundant ? 1 : 0);
} finally {
  rmSync(dbDir, { recursive: true, force: true });
}
process.exit(exitCode);
MJS

# @playwright/test and yaml resolve from packages/app, not the repo root.
pushd packages/app >/dev/null
set +e
INVOKER_REPRO_REPO_ROOT="$ROOT_DIR" \
INVOKER_REPRO_BARE_REPO="$BARE_REPO" \
INVOKER_REPRO_SUMMARY="$SUMMARY_JSON" \
INVOKER_REPRO_WORKFLOWS="$WORKFLOW_COUNT" \
INVOKER_REPRO_TASKS="$TASKS_PER_WORKFLOW" \
INVOKER_REPRO_EXPECT_ISSUE="$EXPECT_ISSUE" \
  node "$DRIVER_PATH" 2>&1 | tee "$DRIVER_LOG"
DRIVER_EXIT="${PIPESTATUS[0]}"
set -e
popd >/dev/null

if [[ -f "$SUMMARY_JSON" ]]; then
  python3 - "$SUMMARY_JSON" <<'PY'
import json
import sys

summary = json.load(open(sys.argv[1]))

bootstrap = summary.get('bootstrap') or {}
graph = summary.get('graphVisible') or {}
redundant = summary.get('redundantSnapshot')
snapshots = summary.get('snapshotEvents') or []

print('repro-summary:')
print(f"  seeded: {summary['workflowCount']} workflows x "
      f"{summary['tasksPerWorkflow']} tasks "
      f"(expected={summary['workflowCount'] * summary['tasksPerWorkflow']})")
print('  bootstrap:')
print(f"    taskCount:     {bootstrap.get('taskCount')}")
print(f"    workflowCount: {bootstrap.get('workflowCount')}")
print(f"    jsonSizeBytes: {bootstrap.get('jsonSizeBytes')}")
print(f"    durationMs:    {bootstrap.get('durationMs')}")
print('  graph-visible:')
print(f"    metric:           {graph.get('metric')}")
print(f"    elapsedMs:        {graph.get('elapsedMs')}")
print(f"    processElapsedMs: {graph.get('processElapsedMs')}")
print(f"    nodeCount:        {graph.get('nodeCount')}")
print(f"    edgeCount:        {graph.get('edgeCount')}")
print(f"  useTasks_snapshot_replace events: {len(snapshots)}")
for snap in snapshots:
    print(
        f"    - forceRefresh={snap.get('forceRefresh')} "
        f"postBootstrap={snap.get('postBootstrap')} "
        f"taskCount={snap.get('taskCount')} "
        f"workflowCount={snap.get('workflowCount')} "
        f"requestDurationMs={snap.get('requestDurationMs')} "
        f"replaceDurationMs={snap.get('replaceDurationMs')} "
        f"jsonSizeBytes={snap.get('jsonSizeBytes')}"
    )
if redundant:
    print('  redundant-snapshot (non-forced, post-bootstrap):')
    print(f"    forceRefresh:      {redundant.get('forceRefresh')}")
    print(f"    taskCount:         {redundant.get('taskCount')}")
    print(f"    workflowCount:     {redundant.get('workflowCount')}")
    print(f"    jsonSizeBytes:     {redundant.get('jsonSizeBytes')}")
    print(f"    requestDurationMs: {redundant.get('requestDurationMs')}")
    print(f"    replaceDurationMs: {redundant.get('replaceDurationMs')}")
else:
    print('  redundant-snapshot: none')
PY
else
  echo "repro: driver did not write a summary; see $DRIVER_LOG" >&2
fi

if [[ "$EXPECT_ISSUE" -eq 1 ]]; then
  if [[ "$DRIVER_EXIT" -eq 0 ]]; then
    echo "repro: PASS (baseline) — observed redundant non-forced useTasks_snapshot_replace after preload_bootstrap_sync"
  else
    echo "repro: FAIL (baseline) — expected a redundant non-forced snapshot after bootstrap but did not see one" >&2
  fi
else
  if [[ "$DRIVER_EXIT" -eq 0 ]]; then
    echo "repro: PASS — no redundant non-forced startup snapshot observed"
  else
    echo "repro: FAIL — redundant non-forced startup snapshot still fires after preload_bootstrap_sync" >&2
  fi
fi
exit "$DRIVER_EXIT"
