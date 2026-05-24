#!/usr/bin/env bash
set -euo pipefail

# Drives an isolated Electron startup fixture and observes whether the
# renderer issues a second, redundant full-graph snapshot request after
# preload bootstrap has already delivered the same data.
#
# Background:
#   `preload.ts` hands the renderer a synchronous bootstrap payload
#   (`preload_bootstrap_sync`). `useTasks` then runs `fetchAll()` in a
#   mount effect, which calls `getTasks(forceRefresh=false)` and emits
#   `useTasks_snapshot_replace`. When the bootstrap already covers the
#   current state, that second IPC + map rebuild is pure overhead.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#                                                            [--workflow-count N]
#                                                            [--tasks-per-workflow N]
#
# Exit codes:
#   --expect-issue (baseline)  exit 0 only when a non-forced
#                              useTasks_snapshot_replace fires AFTER
#                              preload_bootstrap_sync (bug reproduced)
#   default (post-optimization) exit 0 only when no redundant non-forced
#                               startup snapshot is observed

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

EXPECT_ISSUE=0
WORKFLOW_COUNT="${REPRO_WORKFLOW_COUNT:-12}"
TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-8}"

usage() {
  sed -n '4,25p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift;;
    --workflow-count) WORKFLOW_COUNT="$2"; shift 2;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "repro: unknown arg: $1" >&2; usage >&2; exit 2;;
  esac
done

cd "$ROOT_DIR"

if [[ ! -f packages/ui/dist/index.html ]]; then
  echo "repro: building @invoker/ui ..." >&2
  pnpm --filter @invoker/ui build >&2
fi
if [[ ! -f packages/surfaces/dist/index.js ]]; then
  echo "repro: building @invoker/surfaces ..." >&2
  pnpm --filter @invoker/surfaces build >&2
fi
if [[ ! -f packages/app/dist/main.js ]]; then
  echo "repro: building @invoker/app ..." >&2
  pnpm --filter @invoker/app build >&2
fi

TMP_DIR="$(mktemp -d -t invoker-snapshot-refresh-repro-XXXXXX)"
# Driver must live inside the workspace so node's ESM resolver can find
# @playwright/test in node_modules; the rest stays in $TMP_DIR.
DRIVER_DIR="$ROOT_DIR/packages/app"
DRIVER_BASENAME=".repro-snapshot-refresh-driver-$$.mjs"
DRIVER="$DRIVER_DIR/$DRIVER_BASENAME"
trap 'rm -rf "$TMP_DIR" "$DRIVER"' EXIT

OBSERVATIONS="$TMP_DIR/observations.json"

cat > "$DRIVER" <<'NODE_EOF'
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { stringify as yamlStringify } from 'yaml';

const repoRoot = process.env.REPRO_REPO_ROOT;
if (!repoRoot) throw new Error('REPRO_REPO_ROOT missing');
const workflowCount = Number(process.env.REPRO_WORKFLOW_COUNT ?? '12');
const tasksPerWorkflow = Number(process.env.REPRO_TASKS_PER_WORKFLOW ?? '8');
const outputPath = process.env.REPRO_OUTPUT_PATH;
if (!outputPath) throw new Error('REPRO_OUTPUT_PATH missing');

const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-snapshot-refresh-'));
const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
const stubDir = path.join(testDir, 'claude-stub');
const configPath = path.join(testDir, 'e2e-config.json');
const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
const remoteRepo = path.join(testDir, 'remote.git');
mkdirSync(stubDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
try { symlinkSync(claudeMarker, path.join(stubDir, 'claude')); } catch { /* ignore EPERM */ }

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'repro',
  GIT_AUTHOR_EMAIL: 'repro@test',
  GIT_COMMITTER_NAME: 'repro',
  GIT_COMMITTER_EMAIL: 'repro@test',
};
execSync(`git init --bare "${remoteRepo}"`, { stdio: 'ignore' });
const seedClone = path.join(testDir, 'remote-seed');
execSync(`git clone "${remoteRepo}" "${seedClone}"`, { env: gitEnv, stdio: 'ignore' });
execSync('git commit --allow-empty -m init', { cwd: seedClone, env: gitEnv, stdio: 'ignore' });
execSync('git push origin HEAD:refs/heads/master', { cwd: seedClone, env: gitEnv, stdio: 'ignore' });
execSync('git push origin HEAD:refs/heads/main', { cwd: seedClone, env: gitEnv, stdio: 'ignore' });
rmSync(seedClone, { recursive: true, force: true });

const repoUrl = pathToFileURL(remoteRepo).href;
const mainJs = path.join(repoRoot, 'packages', 'app', 'dist', 'main.js');
const pathEnv = `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`;
const linuxArgs = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
  : [];

function launchEnv() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    INVOKER_DB_DIR: testDir,
    INVOKER_IPC_SOCKET: ipcSocketPath,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_CLAUDE_COMMAND: claudeMarker,
    INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
    PATH: pathEnv,
  };
}

function buildPlan(index) {
  return {
    name: `repro snapshot refresh ${index}`,
    repoUrl,
    onFinish: 'none',
    tasks: Array.from({ length: tasksPerWorkflow }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

function parsePayload(message) {
  try { return JSON.parse(message); } catch { return null; }
}

function collectObservations(activityLogs) {
  const entries = activityLogs
    .filter((entry) => entry.source === 'ui-perf' || entry.source === 'startup-phase')
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      source: entry.source,
      payload: parsePayload(entry.message),
    }))
    .filter((entry) => entry.payload !== null);

  const preloadBootstrap = entries.find(
    (e) => e.source === 'ui-perf' && e.payload?.metric === 'preload_bootstrap_sync',
  );
  const preloadId = preloadBootstrap?.id ?? -1;

  const snapshotReplaces = entries.filter(
    (e) => e.source === 'ui-perf' && e.payload?.metric === 'useTasks_snapshot_replace',
  );
  const redundantNonForced = snapshotReplaces.find(
    (e) => e.id > preloadId && e.payload?.forceRefresh === false,
  );
  const workflowGraphVisible = entries.find(
    (e) => e.source === 'ui-perf' && e.payload?.metric === 'startup_workflow_graph_visible',
  );

  return {
    bootstrap: preloadBootstrap?.payload ?? null,
    firstSnapshotReplace: snapshotReplaces[0]?.payload ?? null,
    redundantNonForcedSnapshot: redundantNonForced?.payload ?? null,
    workflowGraphVisible: workflowGraphVisible?.payload ?? null,
    snapshotReplaceCount: snapshotReplaces.length,
    bootstrapId: preloadId,
  };
}

try {
  const seedApp = await electron.launch({ args: [...linuxArgs, mainJs], env: launchEnv() });
  try {
    const page = await seedApp.firstWindow({ timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 20000 });
    for (let i = 0; i < workflowCount; i += 1) {
      const yaml = yamlStringify(buildPlan(i));
      await page.evaluate(async (text) => { await window.invoker.loadPlan(text); }, yaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    // The orchestrator may add a per-workflow __merge__ gate node, so accept
    // either the bare task count or task count + one merge node per workflow.
    const baseExpected = workflowCount * tasksPerWorkflow;
    const withMerge = baseExpected + workflowCount;
    if (seededTasks.length !== baseExpected && seededTasks.length !== withMerge) {
      throw new Error(`seed phase: expected ${baseExpected} or ${withMerge} tasks, got ${seededTasks.length}`);
    }
  } finally {
    await seedApp.close();
  }

  const app = await electron.launch({ args: [...linuxArgs, mainJs], env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 20000 });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: 30000,
    });
    // Let the renderer mount effect and any post-bootstrap fetchAll() flush to the activity log.
    await page.waitForTimeout(2000);
    const activityLogs = await page.evaluate(() => window.invoker.getActivityLogs());
    const observations = collectObservations(activityLogs);
    writeFileSync(outputPath, JSON.stringify(observations), 'utf8');
  } finally {
    await app.close();
  }
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
NODE_EOF

RUN_NODE=(node "$DRIVER")
if [[ "$(uname -s)" == "Linux" ]] && command -v xvfb-run >/dev/null 2>&1; then
  RUN_NODE=(xvfb-run --auto-servernum node "$DRIVER")
fi

echo "repro: launching Electron fixture (workflows=$WORKFLOW_COUNT, tasksPerWorkflow=$TASKS_PER_WORKFLOW) ..." >&2

REPRO_REPO_ROOT="$ROOT_DIR" \
  REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
  REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  REPRO_OUTPUT_PATH="$OBSERVATIONS" \
  "${RUN_NODE[@]}"

python3 - "$OBSERVATIONS" "$EXPECT_ISSUE" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    data = json.load(f)
expect_issue = sys.argv[2] == '1'

bootstrap = data.get('bootstrap') or {}
first_replace = data.get('firstSnapshotReplace') or {}
redundant = data.get('redundantNonForcedSnapshot')
graph_visible = data.get('workflowGraphVisible') or {}

def fmt(value):
    return '—' if value is None else value

print('repro: startup-snapshot-refresh observations')
print(f'  bootstrap.taskCount          = {fmt(bootstrap.get("taskCount"))}')
print(f'  bootstrap.workflowCount      = {fmt(bootstrap.get("workflowCount"))}')
print(f'  bootstrap.jsonSizeBytes      = {fmt(bootstrap.get("jsonSizeBytes"))}')
print(f'  bootstrap.durationMs         = {fmt(bootstrap.get("durationMs"))}')
print(f'  snapshot.requestDurationMs   = {fmt(first_replace.get("requestDurationMs"))}')
print(f'  snapshot.replaceDurationMs   = {fmt(first_replace.get("replaceDurationMs"))}')
print(f'  snapshot.taskCount           = {fmt(first_replace.get("taskCount"))}')
print(f'  snapshot.workflowCount       = {fmt(first_replace.get("workflowCount"))}')
print(f'  snapshot.jsonSizeBytes       = {fmt(first_replace.get("jsonSizeBytes"))}')
print(f'  snapshot.forceRefresh        = {fmt(first_replace.get("forceRefresh"))}')
print(f'  snapshot.replaceCount        = {fmt(data.get("snapshotReplaceCount"))}')
print(f'  graphVisible.elapsedMs       = {fmt(graph_visible.get("elapsedMs"))}')
print(f'  graphVisible.processElapsedMs= {fmt(graph_visible.get("processElapsedMs"))}')
print(f'  graphVisible.nodeCount       = {fmt(graph_visible.get("nodeCount"))}')
print(f'  graphVisible.edgeCount       = {fmt(graph_visible.get("edgeCount"))}')
print(f'  redundant_non_forced_present = {bool(redundant)}')
if redundant:
    print(f'    redundant.taskCount        = {fmt(redundant.get("taskCount"))}')
    print(f'    redundant.workflowCount    = {fmt(redundant.get("workflowCount"))}')
    print(f'    redundant.requestDurationMs= {fmt(redundant.get("requestDurationMs"))}')
    print(f'    redundant.replaceDurationMs= {fmt(redundant.get("replaceDurationMs"))}')
    print(f'    redundant.jsonSizeBytes    = {fmt(redundant.get("jsonSizeBytes"))}')
    print(f'    redundant.forceRefresh     = {fmt(redundant.get("forceRefresh"))}')

if expect_issue:
    if redundant is None:
        print('repro: FAIL — expected a redundant non-forced startup snapshot but observed none.', file=sys.stderr)
        sys.exit(1)
    print('repro: PASS — observed redundant non-forced startup snapshot (baseline reproduces the bug).')
    sys.exit(0)
else:
    if redundant is not None:
        print('repro: FAIL — redundant non-forced startup snapshot still occurs after the optimization.', file=sys.stderr)
        sys.exit(1)
    print('repro: PASS — no redundant non-forced startup snapshot observed.')
    sys.exit(0)
PY
