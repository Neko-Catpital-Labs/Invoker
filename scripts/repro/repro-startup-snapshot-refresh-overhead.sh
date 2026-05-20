#!/usr/bin/env bash
# Deterministic repro for the redundant post-bootstrap startup snapshot request.
#
# Background
#   On app launch the preload script delivers an initial workflows/tasks payload
#   to the renderer via __INVOKER_BOOTSTRAP__ (recorded as ui-perf
#   "preload_bootstrap_sync"). The renderer's useTasks() hook then mounts and
#   calls window.invoker.getTasks(false), round-tripping a *second* full
#   snapshot through IPC and replacing React state (recorded as ui-perf
#   "useTasks_snapshot_replace" with forceRefresh=false). Production traces show
#   this redundant snapshot costs ~65-164ms and moves ~377KB after the graph is
#   already on screen.
#
# What this script does
#   1. Creates an isolated INVOKER_DB_DIR + a local bare repo for loadPlan.
#   2. Drives Electron with Playwright in two phases:
#        a. seed:    launch once, call window.invoker.loadPlan() N times so
#                    the next launch has a non-empty bootstrap snapshot.
#        b. measure: relaunch, wait for the workflow graph to be visible, then
#                    capture activity_log entries to extract:
#                      - preload_bootstrap_sync.{taskCount, workflowCount,
#                        jsonSizeBytes, durationMs}
#                      - useTasks_snapshot_replace.{forceRefresh,
#                        requestDurationMs, replaceDurationMs, jsonSizeBytes,
#                        taskCount, workflowCount}
#                      - startup_workflow_graph_visible.{nodeCount, edgeCount,
#                        processElapsedMs}
#   3. Prints a single summary block with the captured metrics.
#   4. Exit semantics:
#        --expect-issue (pre-fix baseline): exit 0 iff a non-forced
#          useTasks_snapshot_replace appears AFTER the measure-phase
#          preload_bootstrap_sync. Exit 1 if it is missing (repro broken).
#        default (post-fix mode): exit 0 iff NO non-forced
#          useTasks_snapshot_replace appears after that preload. Exit 1 if it
#          still occurs.
#
# Re-runnable: relies on the built @invoker/app dist + @playwright/test from
# the @invoker/app workspace. Honors xvfb-run when DISPLAY is unset on Linux.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-6}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-8}"
EXPECT_ISSUE=0
KEEP_TMP="${KEEP_TMP:-0}"

usage() {
  cat >&2 <<EOF
Usage: $(basename "$0") [--expect-issue] [--workflows N] [--tasks-per-workflow M]

Options:
  --expect-issue          Treat the redundant snapshot as the EXPECTED state
                          (exits 0 on the current pre-fix baseline). Default is
                          post-fix mode: exits 0 only when no redundant snapshot
                          is observed.
  --workflows N           Number of seeded workflows (default: $WORKFLOW_COUNT).
  --tasks-per-workflow M  Tasks per seeded workflow (default: $TASKS_PER_WORKFLOW).

Env:
  KEEP_TMP=1              Keep the isolated temp dir on exit (debugging).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) WORKFLOW_COUNT="${2:?--workflows requires a value}"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="${2:?--tasks-per-workflow requires a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

TMP_DIR="$(mktemp -d)"
DB_DIR="$TMP_DIR/db"
BARE_REPO="$TMP_DIR/repo.git"
CONFIG_PATH="$TMP_DIR/config.json"
DRIVER_JS="$TMP_DIR/driver.cjs"
RESULT_JSON="$TMP_DIR/result.json"

cleanup() {
  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "repro: KEEP_TMP=1; preserved $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"
cat > "$CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"disableAutoRunOnStartup":true,"maxConcurrency":1}
EOF

# ── Pre-flight build check ──────────────────────────────────────────────────
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
if [[ ! -f "$MAIN_JS" ]]; then
  echo "repro: building @invoker/app (dist/main.js missing)..." >&2
  pnpm --filter @invoker/ui build >&2
  pnpm --filter @invoker/surfaces build >&2
  pnpm --filter @invoker/app build >&2
fi

# ── Local bare repo (loadPlan rejects plans without a clonable repoUrl) ─────
git init --bare "$BARE_REPO" >/dev/null
SETUP_CLONE="$TMP_DIR/setup-clone"
git clone --quiet "$BARE_REPO" "$SETUP_CLONE"
(
  cd "$SETUP_CLONE"
  git config user.email "ci@invoker.dev"
  git config user.name  "Invoker Repro"
  git commit --allow-empty --quiet -m "init"
  git push --quiet origin HEAD:refs/heads/master
  git push --quiet origin HEAD:refs/heads/main
)
rm -rf "$SETUP_CLONE"
REPO_URL="file://$BARE_REPO"

# ── Playwright driver: seed + measure ───────────────────────────────────────
cat > "$DRIVER_JS" <<'NODE'
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { _electron: electron } = require('@playwright/test');

const REPO_ROOT = process.env.REPRO_REPO_ROOT;
const MAIN_JS = path.resolve(REPO_ROOT, 'packages/app/dist/main.js');
const DB_DIR = process.env.REPRO_DB_DIR;
const CONFIG_PATH = process.env.REPRO_CONFIG_PATH;
const REPO_URL = process.env.REPRO_REPO_URL;
const WORKFLOW_COUNT = parseInt(process.env.REPRO_WORKFLOW_COUNT, 10);
const TASKS_PER_WORKFLOW = parseInt(process.env.REPRO_TASKS_PER_WORKFLOW, 10);
const RESULT_JSON = process.env.REPRO_RESULT_JSON;

const SEED_TIMEOUT_MS = 60000;
const MEASURE_TIMEOUT_MS = 30000;
const POST_GRAPH_WAIT_MS = 3000;

const launchArgs = [
  ...(process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
       '--disable-gpu-compositing', '--disable-gpu-sandbox',
       '--disable-software-rasterizer']
    : []),
  MAIN_JS,
];

function envBase() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    INVOKER_DB_DIR: DB_DIR,
    INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    // Suppress the periodic db-poll snapshot replay so it cannot inject extra
    // useTasks_snapshot_replace events during measurement.
    INVOKER_STARTUP_POLL_DELAY_MS: '60000',
  };
}

function buildPlan(idx) {
  const tasks = [];
  for (let t = 0; t < TASKS_PER_WORKFLOW; t += 1) {
    tasks.push({
      id: `task-${idx}-${t}`,
      description: `Seed task ${idx}-${t}`,
      command: `echo seed-${idx}-${t}`,
      ...(t === 0 ? {} : { dependencies: [`task-${idx}-${t - 1}`] }),
    });
  }
  return {
    name: `Repro Snapshot Plan ${idx}`,
    repoUrl: REPO_URL,
    onFinish: 'none',
    tasks,
  };
}

function planToYaml(plan) {
  // Minimal hand-rolled YAML — every value is plain ASCII; avoids adding a
  // yaml dep to the driver script.
  const lines = [
    `name: ${JSON.stringify(plan.name)}`,
    `repoUrl: ${plan.repoUrl}`,
    `onFinish: ${plan.onFinish}`,
    'tasks:',
  ];
  for (const task of plan.tasks) {
    lines.push(`  - id: ${task.id}`);
    lines.push(`    description: ${JSON.stringify(task.description)}`);
    lines.push(`    command: ${JSON.stringify(task.command)}`);
    if (task.dependencies && task.dependencies.length > 0) {
      const deps = task.dependencies.map((d) => JSON.stringify(d)).join(', ');
      lines.push(`    dependencies: [${deps}]`);
    }
  }
  return lines.join('\n') + '\n';
}

async function seed() {
  console.error(`repro: seed phase — launching Electron to load ${WORKFLOW_COUNT} workflows`);
  const app = await electron.launch({
    args: launchArgs,
    env: envBase(),
    timeout: SEED_TIMEOUT_MS,
  });
  try {
    const page = await app.firstWindow({ timeout: SEED_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: SEED_TIMEOUT_MS });
    for (let idx = 0; idx < WORKFLOW_COUNT; idx += 1) {
      const yaml = planToYaml(buildPlan(idx));
      await page.evaluate((y) => window.invoker.loadPlan(y), yaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(seeded) ? seeded : (seeded.tasks ?? []);
    const workflows = Array.isArray(seeded) ? [] : (seeded.workflows ?? []);
    // Orchestrator auto-creates one merge node per workflow (`__merge__<wf>`)
    // regardless of onFinish, so the expected total includes those nodes.
    const expectedUser = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;
    const userTasks = tasks.filter((t) => !t.config?.isMergeNode);
    if (userTasks.length !== expectedUser) {
      throw new Error(`seed failed: expected ${expectedUser} user tasks, got ${userTasks.length} (total ${tasks.length})`);
    }
    console.error(`repro: seeded ${workflows.length} workflows / ${tasks.length} tasks (${userTasks.length} user + merge nodes)`);
  } finally {
    await app.close();
  }
}

async function measure() {
  console.error('repro: measure phase — relaunching Electron, waiting for graph visible');
  const app = await electron.launch({
    args: launchArgs,
    env: envBase(),
    timeout: MEASURE_TIMEOUT_MS,
  });
  try {
    const page = await app.firstWindow({ timeout: MEASURE_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: MEASURE_TIMEOUT_MS });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: MEASURE_TIMEOUT_MS,
    });
    // Allow the redundant post-bootstrap snapshot (or its absence) to land.
    await page.waitForTimeout(POST_GRAPH_WAIT_MS);
    const activityLogs = await page.evaluate(() => window.invoker.getActivityLogs());
    return activityLogs;
  } finally {
    await app.close();
  }
}

function parsePayload(message) {
  try { return JSON.parse(message); } catch { return null; }
}

(async () => {
  await seed();
  const activityLogs = await measure();
  const events = [];
  for (const entry of activityLogs) {
    if (entry.source !== 'ui-perf' && entry.source !== 'startup-phase') continue;
    const payload = parsePayload(entry.message);
    if (!payload) continue;
    events.push({ id: entry.id, source: entry.source, payload });
  }
  fs.writeFileSync(RESULT_JSON, JSON.stringify({ events }, null, 2));
  console.error(`repro: wrote ${events.length} ui-perf/startup-phase events to ${RESULT_JSON}`);
})().catch((err) => {
  console.error(`repro: driver failed: ${err && err.stack ? err.stack : err}`);
  process.exit(2);
});
NODE

export REPRO_REPO_ROOT="$ROOT_DIR"
export REPRO_DB_DIR="$DB_DIR"
export REPRO_CONFIG_PATH="$CONFIG_PATH"
export REPRO_REPO_URL="$REPO_URL"
export REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
export REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
export REPRO_RESULT_JSON="$RESULT_JSON"
# The driver lives in $TMP_DIR, so Node's CJS resolver cannot walk up into the
# workspace's node_modules. Pin NODE_PATH to the @invoker/app and repo-root
# node_modules so require('@playwright/test') succeeds.
export NODE_PATH="$ROOT_DIR/packages/app/node_modules:$ROOT_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"

PLAYWRIGHT_RUN=(pnpm --filter @invoker/app exec node "$DRIVER_JS")
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "repro: xvfb-run not found and DISPLAY is unset — install xvfb or set DISPLAY." >&2
    exit 2
  fi
  PLAYWRIGHT_RUN=(xvfb-run --auto-servernum pnpm --filter @invoker/app exec node "$DRIVER_JS")
fi

echo "repro: driver cmd: ${PLAYWRIGHT_RUN[*]}" >&2
"${PLAYWRIGHT_RUN[@]}"

if [[ ! -s "$RESULT_JSON" ]]; then
  echo "repro: driver produced no result JSON" >&2
  exit 2
fi

# ── Analyze and assert ──────────────────────────────────────────────────────
python3 - "$RESULT_JSON" "$EXPECT_ISSUE" <<'PY'
import json
import sys

result_path, expect_issue_str = sys.argv[1], sys.argv[2]
expect_issue = expect_issue_str == '1'

with open(result_path, 'r', encoding='utf-8') as f:
    data = json.load(f)
events = data.get('events', [])

def find_all(metric):
    out = []
    for ev in events:
        payload = ev.get('payload') or {}
        if payload.get('metric') == metric:
            out.append(ev)
    return out

def latest(metric):
    found = find_all(metric)
    return found[-1] if found else None

# The activity_log accumulates across launches, so use the LATEST
# preload_bootstrap_sync (the one from the measure phase) as the cutoff.
preload = latest('preload_bootstrap_sync')
graph_visible = latest('startup_workflow_graph_visible')
task_graph_visible = latest('startup_graph_visible')
all_replaces = find_all('useTasks_snapshot_replace')

preload_id = preload['id'] if preload else None
redundant = None
for ev in all_replaces:
    payload = ev.get('payload') or {}
    if payload.get('forceRefresh'):
        continue
    if preload_id is not None and ev['id'] <= preload_id:
        continue
    redundant = ev
    break

print('repro-summary:')
if preload:
    p = preload['payload']
    print(f"  preload_bootstrap_sync: taskCount={p.get('taskCount')} "
          f"workflowCount={p.get('workflowCount')} "
          f"jsonSizeBytes={p.get('jsonSizeBytes')} "
          f"durationMs={p.get('durationMs')}")
else:
    print('  preload_bootstrap_sync: <missing>')

if redundant:
    r = redundant['payload']
    print(f"  useTasks_snapshot_replace (post-bootstrap):")
    print(f"    forced={r.get('forceRefresh')}")
    print(f"    requestDurationMs={r.get('requestDurationMs')}")
    print(f"    replaceDurationMs={r.get('replaceDurationMs')}")
    print(f"    taskCount={r.get('taskCount')}")
    print(f"    workflowCount={r.get('workflowCount')}")
    print(f"    jsonSizeBytes={r.get('jsonSizeBytes')}")
else:
    print('  useTasks_snapshot_replace (post-bootstrap, non-forced): <not observed>')

forced = [ev for ev in all_replaces if (ev.get('payload') or {}).get('forceRefresh')]
if forced:
    f = forced[-1]['payload']
    print(f"  forced snapshot replaces observed: {len(forced)} "
          f"(latest: taskCount={f.get('taskCount')} "
          f"requestDurationMs={f.get('requestDurationMs')})")

if graph_visible:
    g = graph_visible['payload']
    print(f"  startup_workflow_graph_visible: nodeCount={g.get('nodeCount')} "
          f"edgeCount={g.get('edgeCount')} "
          f"processElapsedMs={g.get('processElapsedMs')}")
else:
    print('  startup_workflow_graph_visible: <missing>')

if task_graph_visible:
    t = task_graph_visible['payload']
    print(f"  startup_graph_visible (task DAG): nodeCount={t.get('nodeCount')} "
          f"edgeCount={t.get('edgeCount')} "
          f"processElapsedMs={t.get('processElapsedMs')}")

print(f"  expect_issue_mode: {expect_issue}")

if expect_issue:
    if redundant is None:
        print('repro: FAIL (--expect-issue): no redundant non-forced post-bootstrap snapshot observed.')
        sys.exit(1)
    print('repro: PASS (--expect-issue): redundant non-forced post-bootstrap snapshot reproduced.')
    sys.exit(0)
else:
    if redundant is not None:
        print('repro: FAIL (post-fix mode): a redundant non-forced post-bootstrap snapshot still occurs.')
        sys.exit(1)
    print('repro: PASS (post-fix mode): no redundant non-forced post-bootstrap snapshot.')
    sys.exit(0)
PY
