#!/usr/bin/env bash
set -euo pipefail

# Deterministic repro for the post-bootstrap startup snapshot refresh.
#
# Drives an isolated Electron fixture twice: once to seed N workflows × M tasks
# into a fresh INVOKER_DB_DIR, then a second time to measure the renderer's
# startup behavior. Reads ui-perf entries out of the activity_log via the IPC
# bridge and prints the bootstrap / snapshot-replace / graph-visible metrics.
#
# Baseline (current main): the renderer fires a non-forced
#   `useTasks_snapshot_replace` immediately after `preload_bootstrap_sync`,
#   re-fetching a snapshot that bootstrap already hydrated. Run with
#   `--expect-issue` to assert that redundancy still reproduces (exit 0).
#
# Post-fix: invoke without `--expect-issue`. The script exits 0 only when no
#   non-forced startup snapshot replace is observed after bootstrap.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#       [--workflows N] [--tasks-per-workflow M]
#       [--startup-budget-ms MS] [--keep-tmp]

EXPECT_ISSUE=0
KEEP_TMP=0
WORKFLOW_COUNT="${WORKFLOW_COUNT:-3}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-7}"
STARTUP_BUDGET_MS="${STARTUP_BUDGET_MS:-45000}"

usage() {
  sed -n '3,/^$/{s/^# \{0,1\}//;p;}' "$0"
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    --startup-budget-ms) STARTUP_BUDGET_MS="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "[repro] unknown arg: $1" >&2; usage 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/repro-startup-snapshot-XXXXXX")"
cleanup() {
  if [[ "$KEEP_TMP" -eq 0 ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "[repro] keeping tmp dir: $TMP_DIR" >&2
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"

# Ensure the renderer + main + surfaces builds are present.
need_build=0
for artifact in \
  packages/ui/dist/index.html \
  packages/surfaces/dist/index.js \
  packages/app/dist/main.js \
  packages/app/dist/preload.js; do
  if [[ ! -f "$artifact" ]]; then need_build=1; fi
done
if (( need_build )); then
  echo "[repro] building @invoker/ui + @invoker/surfaces + @invoker/app..." >&2
  pnpm --filter @invoker/ui build >&2
  pnpm --filter @invoker/surfaces build >&2
  pnpm --filter @invoker/app build >&2
fi

# Local bare repo so plans can clone without network.
BARE_REPO="$TMP_DIR/e2e-repo.git"
SETUP_CLONE="$TMP_DIR/e2e-clone.setup"
git init --bare "$BARE_REPO" >/dev/null
git -c init.defaultBranch=master clone "$BARE_REPO" "$SETUP_CLONE" >/dev/null 2>&1
git -C "$SETUP_CLONE" \
  -c user.name="Invoker Repro" \
  -c user.email="repro@invoker.dev" \
  commit --allow-empty -m "init" >/dev/null
git -C "$SETUP_CLONE" push origin HEAD:refs/heads/master >/dev/null 2>&1
git -C "$SETUP_CLONE" push origin HEAD:refs/heads/main >/dev/null 2>&1
rm -rf "$SETUP_CLONE"

DB_DIR="$TMP_DIR/db"
mkdir -p "$DB_DIR"

DRIVER_SCRIPT="$TMP_DIR/driver.cjs"
DRIVER_OUT="$TMP_DIR/summary.json"
DRIVER_LOG="$TMP_DIR/driver.log"

cat > "$DRIVER_SCRIPT" <<'DRIVER_EOF'
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { _electron } = require('@playwright/test');
const yaml = require('yaml');

const env = process.env;
const repoRoot = env.REPRO_REPO_ROOT;
const bareRepo = env.REPRO_BARE_REPO;
const dbDir = env.REPRO_DB_DIR;
const outPath = env.REPRO_OUT_PATH;
const workflowCount = Number(env.REPRO_WORKFLOW_COUNT);
const tasksPerWorkflow = Number(env.REPRO_TASKS_PER_WORKFLOW);
const startupBudgetMs = Number(env.REPRO_STARTUP_BUDGET_MS);

const repoUrl = 'file://' + bareRepo;
const configPath = path.join(dbDir, 'invoker-config.json');
const stubDir = path.join(dbDir, 'claude-stub');
const markerRoot = path.join(dbDir, 'markers');
fs.mkdirSync(stubDir, { recursive: true });
fs.mkdirSync(markerRoot, { recursive: true });
fs.writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');

const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
try { fs.symlinkSync(claudeMarker, path.join(stubDir, 'claude')); } catch (_e) { /* ignore */ }

function launchArgs() {
  const args = [];
  if (process.platform === 'linux') {
    args.push(
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer',
    );
  }
  args.push(path.join(repoRoot, 'packages', 'app', 'dist', 'main.js'));
  return args;
}

function launchEnv() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    INVOKER_DB_DIR: dbDir,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_E2E_MARKER_ROOT: markerRoot,
    INVOKER_CLAUDE_COMMAND: claudeMarker,
    INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
    PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
  };
}

function buildPlanYaml(idx) {
  const tasks = [];
  for (let t = 0; t < tasksPerWorkflow; t++) {
    tasks.push({
      id: `task-${idx}-${t}`,
      description: `Task ${idx}-${t}`,
      command: `echo task-${idx}-${t}`,
      dependencies: t === 0 ? [] : [`task-${idx}-${t - 1}`],
    });
  }
  return yaml.stringify({
    name: `Startup Snapshot Repro ${idx}`,
    repoUrl,
    onFinish: 'none',
    tasks,
  });
}

async function seedFixture() {
  const app = await _electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: startupBudgetMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: startupBudgetMs });
    for (let idx = 0; idx < workflowCount; idx++) {
      const planText = buildPlanYaml(idx);
      await page.evaluate(async (text) => {
        await window.invoker.loadPlan(text);
      }, planText);
    }
    const seeded = await page.evaluate(async () => {
      const r = await window.invoker.getTasks(true);
      const tasks = Array.isArray(r) ? r : r.tasks;
      const wfs = Array.isArray(r) ? [] : (r.workflows || []);
      return { tasks: tasks.length, workflows: wfs.length };
    });
    if (seeded.workflows < workflowCount) {
      throw new Error(`Seed mismatch: wanted ${workflowCount} workflows, got ${seeded.workflows}`);
    }
    if (seeded.tasks < workflowCount * tasksPerWorkflow) {
      throw new Error(`Seed mismatch: wanted >=${workflowCount * tasksPerWorkflow} tasks, got ${seeded.tasks}`);
    }
  } finally {
    await app.close();
  }
}

async function measureFixture() {
  const startedAtMs = Date.now();
  const app = await _electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: startupBudgetMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: startupBudgetMs });
    // Wait for the workflow graph to render so every startup ui-perf event has fired.
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: startupBudgetMs,
    });
    // Give buffered ipcRenderer.invoke('invoker:report-ui-perf', ...) calls time to flush.
    await page.waitForTimeout(1500);
    const elapsedMs = Date.now() - startedAtMs;
    const logs = await page.evaluate(() => window.invoker.getActivityLogs());
    return { elapsedMs, logs };
  } finally {
    await app.close();
  }
}

(async () => {
  await seedFixture();
  const { elapsedMs, logs } = await measureFixture();

  const uiPerf = [];
  for (const entry of logs || []) {
    if (entry.source !== 'ui-perf') continue;
    try {
      const payload = JSON.parse(entry.message);
      uiPerf.push({ id: entry.id, ...payload });
    } catch (_e) { /* skip malformed */ }
  }

  const preloadBootstrap = uiPerf.find((e) => e.metric === 'preload_bootstrap_sync') || null;
  const snapshotReplaces = uiPerf.filter((e) => e.metric === 'useTasks_snapshot_replace');
  const firstAfterBootstrap = preloadBootstrap
    ? (snapshotReplaces.find((e) => e.id > preloadBootstrap.id) || null)
    : (snapshotReplaces[0] || null);
  const workflowGraphVisible = uiPerf.find((e) => e.metric === 'startup_workflow_graph_visible') || null;
  const taskGraphVisible = uiPerf.find((e) => e.metric === 'startup_graph_visible') || null;
  const skippedSmaller = uiPerf.find((e) => e.metric === 'startup_snapshot_skipped_smaller_than_bootstrap') || null;

  const redundantStartupSnapshot =
    firstAfterBootstrap != null && firstAfterBootstrap.forceRefresh === false;

  const summary = {
    elapsedMs,
    workflowCount,
    tasksPerWorkflow,
    preloadBootstrap: preloadBootstrap && {
      taskCount: preloadBootstrap.taskCount,
      workflowCount: preloadBootstrap.workflowCount,
      jsonSizeBytes: preloadBootstrap.jsonSizeBytes,
      durationMs: preloadBootstrap.durationMs,
      processElapsedMs: preloadBootstrap.processElapsedMs,
    },
    snapshotReplace: firstAfterBootstrap && {
      taskCount: firstAfterBootstrap.taskCount,
      workflowCount: firstAfterBootstrap.workflowCount,
      forceRefresh: firstAfterBootstrap.forceRefresh,
      requestDurationMs: firstAfterBootstrap.requestDurationMs,
      replaceDurationMs: firstAfterBootstrap.replaceDurationMs,
      jsonSizeBytes: firstAfterBootstrap.jsonSizeBytes,
    },
    workflowGraphVisible: workflowGraphVisible && {
      nodeCount: workflowGraphVisible.nodeCount,
      edgeCount: workflowGraphVisible.edgeCount,
      elapsedMs: workflowGraphVisible.elapsedMs,
      processElapsedMs: workflowGraphVisible.processElapsedMs,
    },
    taskGraphVisible: taskGraphVisible && {
      nodeCount: taskGraphVisible.nodeCount,
      elapsedMs: taskGraphVisible.elapsedMs,
      processElapsedMs: taskGraphVisible.processElapsedMs,
    },
    skippedSmallerThanBootstrap: skippedSmaller != null,
    snapshotReplaceCount: snapshotReplaces.length,
    redundantStartupSnapshot,
  };

  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
})().catch((err) => {
  console.error('[repro/driver] failed:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
DRIVER_EOF

# Node needs to resolve @playwright/test, electron, yaml from the workspace stores.
NODE_PATH_VAL="$ROOT_DIR/packages/app/node_modules:$ROOT_DIR/node_modules"

DRIVER_ENV=(
  NODE_PATH="$NODE_PATH_VAL"
  REPRO_REPO_ROOT="$ROOT_DIR"
  REPRO_BARE_REPO="$BARE_REPO"
  REPRO_DB_DIR="$DB_DIR"
  REPRO_OUT_PATH="$DRIVER_OUT"
  REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
  REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
  REPRO_STARTUP_BUDGET_MS="$STARTUP_BUDGET_MS"
)

if [[ "$(uname)" == "Linux" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "[repro] ERROR: xvfb-run is required on Linux to drive Electron" >&2
    exit 1
  fi
  RUNNER=(xvfb-run --auto-servernum --server-args="-screen 0 1280x800x24" node "$DRIVER_SCRIPT")
else
  RUNNER=(node "$DRIVER_SCRIPT")
fi

echo "[repro] seeding+measuring (workflows=$WORKFLOW_COUNT, tasksPerWorkflow=$TASKS_PER_WORKFLOW)..." >&2
if ! env "${DRIVER_ENV[@]}" "${RUNNER[@]}" >"$DRIVER_LOG" 2>&1; then
  echo "[repro] ERROR: driver exited non-zero" >&2
  cat "$DRIVER_LOG" >&2
  exit 1
fi

if [[ ! -f "$DRIVER_OUT" ]]; then
  echo "[repro] ERROR: driver did not produce summary at $DRIVER_OUT" >&2
  cat "$DRIVER_LOG" >&2
  exit 1
fi

python3 - "$DRIVER_OUT" "$EXPECT_ISSUE" <<'PY'
import json
import sys

summary_path = sys.argv[1]
expect_issue = sys.argv[2] == '1'
with open(summary_path, 'r', encoding='utf-8') as fh:
    s = json.load(fh)

def fmt(v):
    return '<missing>' if v is None else v

bp = s.get('preloadBootstrap')
sr = s.get('snapshotReplace')
wf = s.get('workflowGraphVisible')
tg = s.get('taskGraphVisible')

print('repro-summary:')
print(f"  seeded: {s['workflowCount']} workflows x {s['tasksPerWorkflow']} tasks "
      f"(measure-launch wall time {s.get('elapsedMs', '?')} ms)")
print('  preload_bootstrap_sync:')
print(f"    taskCount={fmt(bp and bp.get('taskCount'))}, "
      f"workflowCount={fmt(bp and bp.get('workflowCount'))}, "
      f"jsonSizeBytes={fmt(bp and bp.get('jsonSizeBytes'))}, "
      f"durationMs={fmt(bp and bp.get('durationMs'))}, "
      f"processElapsedMs={fmt(bp and bp.get('processElapsedMs'))}")
print('  useTasks_snapshot_replace (first after bootstrap):')
print(f"    requestDurationMs={fmt(sr and sr.get('requestDurationMs'))}")
print(f"    replaceDurationMs={fmt(sr and sr.get('replaceDurationMs'))}")
print(f"    jsonSizeBytes={fmt(sr and sr.get('jsonSizeBytes'))}, "
      f"taskCount={fmt(sr and sr.get('taskCount'))}, "
      f"workflowCount={fmt(sr and sr.get('workflowCount'))}")
print(f"    forceRefresh={fmt(sr and sr.get('forceRefresh'))}")
print('  startup_workflow_graph_visible:')
print(f"    nodeCount={fmt(wf and wf.get('nodeCount'))}, "
      f"edgeCount={fmt(wf and wf.get('edgeCount'))}, "
      f"elapsedMs={fmt(wf and wf.get('elapsedMs'))}, "
      f"processElapsedMs={fmt(wf and wf.get('processElapsedMs'))}")
print('  startup_graph_visible (selected workflow task DAG):')
print(f"    nodeCount={fmt(tg and tg.get('nodeCount'))}, "
      f"elapsedMs={fmt(tg and tg.get('elapsedMs'))}, "
      f"processElapsedMs={fmt(tg and tg.get('processElapsedMs'))}")
print(f"  snapshot_replace_count={s.get('snapshotReplaceCount')}, "
      f"skipped_smaller_than_bootstrap={s.get('skippedSmallerThanBootstrap')}")
print(f"  redundant_startup_snapshot={s.get('redundantStartupSnapshot')}")
print()

observed = bool(s.get('redundantStartupSnapshot'))
if expect_issue:
    if observed:
        print('repro: PASS (baseline) — non-forced useTasks_snapshot_replace observed after preload_bootstrap_sync')
        sys.exit(0)
    print('repro: FAIL (baseline) — expected a redundant non-forced startup snapshot but none was observed')
    sys.exit(1)
else:
    if observed:
        print('repro: FAIL — non-forced useTasks_snapshot_replace still firing after preload_bootstrap_sync')
        sys.exit(1)
    print('repro: PASS — no redundant non-forced startup snapshot observed')
    sys.exit(0)
PY
