#!/usr/bin/env bash
# Deterministic repro for the redundant post-bootstrap startup snapshot
# request observed in packages/ui/src/hooks/useTasks.ts.
#
# Symptom (baseline): after preload_bootstrap_sync has already populated
# window.__INVOKER_BOOTSTRAP__ with the full task/workflow snapshot, useTasks
# still fires a non-forced getTasks() on mount, producing a redundant
# `useTasks_snapshot_replace` event (~65-164ms request, ~377KB payload) that
# replaces state the bootstrap already provided.
#
# The script:
#   1. Provisions an isolated INVOKER_DB_DIR sandbox.
#   2. Seeds it with N workflows × M tasks via Playwright + Electron
#      (`window.invoker.loadPlan`) with auto-run disabled so nothing executes.
#   3. Relaunches the Electron app against the same DB and waits for the
#      startup graph to render.
#   4. Reads `activity_log` rows via `window.invoker.getActivityLogs()`
#      and ui-perf stats via `window.invoker.getUiPerfStats()`.
#   5. Prints bootstrap counts/jsonSizeBytes, snapshot replace timings,
#      forceRefresh flag, and graph-visible timing/node/edge counts.
#
# Exit semantics:
#   --expect-issue   exit 0 if a non-forced `useTasks_snapshot_replace` is
#                    observed AFTER `preload_bootstrap_sync` (current baseline)
#   (no flag)        exit 0 only if NO redundant non-forced replace is
#                    observed (post-optimization)
#
# Tunables (env):
#   WORKFLOW_COUNT       (default 30)
#   TASKS_PER_WORKFLOW   (default 8)
#   STARTUP_BUDGET_MS    (default 30000)
#   KEEP_TMP=1           keep $TMP_DIR for debugging

set -euo pipefail

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue)
      EXPECT_ISSUE=1
      ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-30}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-8}"
STARTUP_BUDGET_MS="${STARTUP_BUDGET_MS:-30000}"

TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-repro.XXXXXX)"
cleanup() {
  if [[ "${KEEP_TMP:-0}" = "1" ]]; then
    echo "[repro] keeping TMP_DIR=$TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

MAIN_JS="$REPO_ROOT/packages/app/dist/main.js"
if [[ ! -f "$MAIN_JS" ]]; then
  echo "[repro] building @invoker/app (dist/main.js missing)…" >&2
  pnpm --filter @invoker/app build >/dev/null
fi

DRIVER="$TMP_DIR/driver.mjs"
REPORT="$TMP_DIR/report.json"

# Resolve @playwright/test absolutely so the ESM driver can `import` it
# without depending on its own (temp) location in the module resolution graph.
PLAYWRIGHT_TEST_INDEX="$(cd "$REPO_ROOT/packages/app" && node -e "process.stdout.write(require.resolve('@playwright/test'))")"
PLAYWRIGHT_TEST_INDEX_JSON="$(node -e "process.stdout.write(JSON.stringify(process.argv[1]))" "$PLAYWRIGHT_TEST_INDEX")"
printf 'import __playwrightTest from %s;\nconst { _electron: electron } = __playwrightTest;\n' "$PLAYWRIGHT_TEST_INDEX_JSON" > "$DRIVER"

cat >> "$DRIVER" <<'NODE_EOF'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import * as path from 'node:path';

const [, , repoRootArg, dbDirArg, workflowCountArg, tasksPerWorkflowArg, startupBudgetMsArg, reportPathArg] = process.argv;
const repoRoot = repoRootArg;
const dbDir = dbDirArg;
const workflowCount = Number.parseInt(workflowCountArg, 10);
const tasksPerWorkflow = Number.parseInt(tasksPerWorkflowArg, 10);
const startupBudgetMs = Number.parseInt(startupBudgetMsArg, 10);
const reportPath = reportPathArg;

const mainJs = path.join(repoRoot, 'packages', 'app', 'dist', 'main.js');
const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
const stubDir = path.join(dbDir, 'claude-stub');
const markerRoot = path.join(dbDir, 'e2e-markers');
const configPath = path.join(dbDir, 'config.json');
mkdirSync(stubDir, { recursive: true });
mkdirSync(markerRoot, { recursive: true });
writeFileSync(
  configPath,
  JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true, allowGraphMutation: true }),
  'utf8',
);
try { symlinkSync(claudeMarker, path.join(stubDir, 'claude')); } catch { /* ignore */ }

function buildPlan(idx) {
  const tasks = [];
  for (let t = 0; t < tasksPerWorkflow; t++) {
    tasks.push({
      id: `task-${idx}-${t}`,
      description: `Seed task ${idx}-${t}`,
      command: `true`,
      dependencies: t === 0 ? [] : [`task-${idx}-${t - 1}`],
    });
  }
  return {
    name: `startup-snapshot-repro-${idx}`,
    repoUrl: `file://${dbDir}/seed-repo.git`,
    onFinish: 'none',
    tasks,
  };
}

function yamlEscape(value) {
  // Minimal YAML escape: quote strings that may contain special chars.
  if (typeof value !== 'string') return value;
  return JSON.stringify(value);
}

function planToYaml(plan) {
  const lines = [];
  lines.push(`name: ${yamlEscape(plan.name)}`);
  lines.push(`repoUrl: ${yamlEscape(plan.repoUrl)}`);
  lines.push(`onFinish: ${plan.onFinish}`);
  lines.push(`tasks:`);
  for (const task of plan.tasks) {
    lines.push(`  - id: ${yamlEscape(task.id)}`);
    lines.push(`    description: ${yamlEscape(task.description)}`);
    lines.push(`    command: ${yamlEscape(task.command)}`);
    if (task.dependencies && task.dependencies.length > 0) {
      lines.push(`    dependencies:`);
      for (const dep of task.dependencies) lines.push(`      - ${yamlEscape(dep)}`);
    } else {
      lines.push(`    dependencies: []`);
    }
  }
  return lines.join('\n') + '\n';
}

const launchEnv = {
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
  PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
};

const launchArgs = [
  ...(process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
    : []),
  mainJs,
];

// ── Phase 1: seed the DB with N workflows × M tasks (no execution). ────
console.error(`[repro] seeding ${workflowCount} workflows × ${tasksPerWorkflow} tasks in ${dbDir}…`);
{
  const seedApp = await electron.launch({ args: launchArgs, env: launchEnv, timeout: startupBudgetMs });
  try {
    const page = await seedApp.firstWindow({ timeout: startupBudgetMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: startupBudgetMs });
    for (let i = 0; i < workflowCount; i++) {
      const yaml = planToYaml(buildPlan(i));
      await page.evaluate(async (planText) => {
        await window.invoker.loadPlan(planText);
      }, yaml);
    }
    const seeded = await page.evaluate(async () => {
      const r = await window.invoker.getTasks(true);
      return Array.isArray(r) ? { tasks: r.length, workflows: 0 } : { tasks: r.tasks.length, workflows: r.workflows.length };
    });
    console.error(`[repro] seeded ${seeded.tasks} tasks across ${seeded.workflows} workflows (includes synthetic merge nodes)`);
    if (seeded.workflows !== workflowCount || seeded.tasks < workflowCount * tasksPerWorkflow) {
      throw new Error(
        `expected ${workflowCount} workflows and >=${workflowCount * tasksPerWorkflow} tasks,`
          + ` got ${seeded.workflows} workflows / ${seeded.tasks} tasks`,
      );
    }
  } finally {
    await seedApp.close();
  }
}

// ── Phase 2: relaunch fresh — this is the startup we are profiling. ────
console.error(`[repro] relaunching app against seeded DB and capturing activity log…`);
const relaunchStartedAt = Date.now();
const app = await electron.launch({ args: launchArgs, env: launchEnv, timeout: startupBudgetMs });
try {
  const page = await app.firstWindow({ timeout: startupBudgetMs });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: startupBudgetMs });

  // Wait for at least one workflow node so startup_workflow_graph_visible fires.
  await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
    state: 'visible',
    timeout: startupBudgetMs,
  });
  // Give the useTasks fetchAll() Promise time to resolve and report.
  await page.waitForFunction(async () => {
    const logs = await window.invoker.getActivityLogs();
    return logs.some((entry) => {
      if (entry.source !== 'ui-perf') return false;
      try {
        const payload = JSON.parse(entry.message);
        return payload?.metric === 'useTasks_snapshot_replace'
          || payload?.metric === 'startup_snapshot_skipped_smaller_than_bootstrap';
      } catch {
        return false;
      }
    });
  }, null, { timeout: startupBudgetMs }).catch(() => undefined);

  const collected = await page.evaluate(async () => {
    const logs = await window.invoker.getActivityLogs();
    const perf = await window.invoker.getUiPerfStats();
    return { logs, perf };
  });

  const parsed = [];
  for (const entry of collected.logs) {
    if (entry.source !== 'ui-perf') continue;
    let payload;
    try { payload = JSON.parse(entry.message); } catch { continue; }
    if (!payload || typeof payload.metric !== 'string') continue;
    parsed.push({ id: entry.id, ts: entry.timestamp ?? entry.ts ?? payload.ts ?? null, payload });
  }

  // activity_log persists across phases, so seed-phase and relaunch-phase
  // events share the same table. The relaunch's preload_bootstrap_sync is the
  // LAST one (seed-phase preload fired earlier with empty state). All metrics
  // we analyze must be scoped to events with id >= that preload's id.
  const allMatching = (metric) => parsed.filter((e) => e.payload.metric === metric);
  const lastMatching = (metric) => {
    const list = allMatching(metric);
    return list.length > 0 ? list[list.length - 1] : undefined;
  };

  const preloadBootstrap = lastMatching('preload_bootstrap_sync');
  const preloadId = preloadBootstrap?.id ?? -1;
  const eventsInRelaunchWindow = parsed.filter((e) => e.id >= preloadId);
  const findFirstScoped = (metric) => eventsInRelaunchWindow.find((e) => e.payload.metric === metric);
  const findAllScoped = (metric) => eventsInRelaunchWindow.filter((e) => e.payload.metric === metric);

  const snapshotReplaces = findAllScoped('useTasks_snapshot_replace');
  const skippedSmaller = findAllScoped('startup_snapshot_skipped_smaller_than_bootstrap');
  const graphVisible = findFirstScoped('startup_workflow_graph_visible');
  const taskGraphVisible = findFirstScoped('startup_graph_visible');
  const bootstrapState = findFirstScoped('startup_bootstrap_state');

  const postBootstrapReplaces = snapshotReplaces.filter((e) => e.id > preloadId);
  const redundantNonForced = postBootstrapReplaces.find((e) => e.payload?.forceRefresh === false);

  const report = {
    elapsedMs: Date.now() - relaunchStartedAt,
    workflowCount,
    tasksPerWorkflow,
    allUiPerfMetrics: parsed.map((e) => ({ id: e.id, metric: e.payload.metric })),
    bootstrap: preloadBootstrap?.payload ?? null,
    bootstrapState: bootstrapState?.payload ?? null,
    snapshotReplaces: snapshotReplaces.map((e) => ({
      id: e.id,
      forceRefresh: !!e.payload.forceRefresh,
      taskCount: e.payload.taskCount,
      workflowCount: e.payload.workflowCount,
      requestDurationMs: e.payload.requestDurationMs,
      replaceDurationMs: e.payload.replaceDurationMs,
      jsonSizeBytes: e.payload.jsonSizeBytes,
    })),
    snapshotsSkippedSmaller: skippedSmaller.map((e) => e.payload),
    workflowGraphVisible: graphVisible?.payload ?? null,
    taskGraphVisible: taskGraphVisible?.payload ?? null,
    redundantNonForcedAfterBootstrap: redundantNonForced
      ? {
          id: redundantNonForced.id,
          requestDurationMs: redundantNonForced.payload.requestDurationMs,
          replaceDurationMs: redundantNonForced.payload.replaceDurationMs,
          jsonSizeBytes: redundantNonForced.payload.jsonSizeBytes,
          forceRefresh: !!redundantNonForced.payload.forceRefresh,
        }
      : null,
    perfStartupMarks: collected.perf?.startupMarks ?? null,
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2));
} finally {
  await app.close();
}
NODE_EOF

# Run from packages/app so `@playwright/test` resolves via that package's
# node_modules (pnpm installs it there).
( cd "$REPO_ROOT/packages/app" \
    && node "$DRIVER" \
      "$REPO_ROOT" \
      "$TMP_DIR" \
      "$WORKFLOW_COUNT" \
      "$TASKS_PER_WORKFLOW" \
      "$STARTUP_BUDGET_MS" \
      "$REPORT" )

python3 - "$REPORT" "$EXPECT_ISSUE" <<'PY'
import json, sys

report_path, expect_issue_raw = sys.argv[1], sys.argv[2]
expect_issue = expect_issue_raw == '1'

with open(report_path) as f:
    report = json.load(f)

bootstrap = report.get('bootstrap') or {}
replaces = report.get('snapshotReplaces') or []
graph = report.get('workflowGraphVisible') or {}
task_graph = report.get('taskGraphVisible') or {}
redundant = report.get('redundantNonForcedAfterBootstrap')

print('repro-summary:')
print(f"  workflow_count       : {report.get('workflowCount')}")
print(f"  tasks_per_workflow   : {report.get('tasksPerWorkflow')}")
print(f"  relaunch_elapsed_ms  : {report.get('elapsedMs')}")
print()
print('  bootstrap (preload_bootstrap_sync):')
print(f"    taskCount          : {bootstrap.get('taskCount')}")
print(f"    workflowCount      : {bootstrap.get('workflowCount')}")
print(f"    jsonSizeBytes      : {bootstrap.get('jsonSizeBytes')}")
print(f"    durationMs         : {bootstrap.get('durationMs')}")
print()

if replaces:
    print('  useTasks_snapshot_replace events (in order):')
    for idx, ev in enumerate(replaces):
        print(f"    [{idx}] forceRefresh={ev.get('forceRefresh')}"
              f" requestDurationMs={ev.get('requestDurationMs')}"
              f" replaceDurationMs={ev.get('replaceDurationMs')}"
              f" jsonSizeBytes={ev.get('jsonSizeBytes')}"
              f" taskCount={ev.get('taskCount')}"
              f" workflowCount={ev.get('workflowCount')}")
else:
    print('  useTasks_snapshot_replace events: <none>')
print()

print('  graph visibility:')
print(f"    workflow_graph     : nodeCount={graph.get('nodeCount')} edgeCount={graph.get('edgeCount')}"
      f" elapsedMs={graph.get('elapsedMs')} processElapsedMs={graph.get('processElapsedMs')}")
print(f"    task_dag_graph     : nodeCount={task_graph.get('nodeCount')}"
      f" elapsedMs={task_graph.get('elapsedMs')} processElapsedMs={task_graph.get('processElapsedMs')}")
print()

if redundant is not None:
    print('  redundant_non_forced_snapshot_after_bootstrap: YES')
    print(f"    requestDurationMs  : {redundant.get('requestDurationMs')}")
    print(f"    replaceDurationMs  : {redundant.get('replaceDurationMs')}")
    print(f"    jsonSizeBytes      : {redundant.get('jsonSizeBytes')}")
    print(f"    forced             : {redundant.get('forceRefresh')}")
else:
    print('  redundant_non_forced_snapshot_after_bootstrap: NO')

# Exit semantics:
#   --expect-issue: PASS iff a redundant non-forced replace IS present (baseline).
#   no flag       : PASS iff a redundant non-forced replace is ABSENT  (post-fix).
if expect_issue:
    if redundant is not None:
        print('\n[repro] PASS (--expect-issue): observed redundant non-forced startup snapshot')
        sys.exit(0)
    print('\n[repro] FAIL (--expect-issue): no redundant non-forced startup snapshot observed')
    sys.exit(1)
else:
    if redundant is None:
        print('\n[repro] PASS: no redundant non-forced startup snapshot after bootstrap')
        sys.exit(0)
    print('\n[repro] FAIL: redundant non-forced startup snapshot still observed after bootstrap')
    sys.exit(1)
PY
