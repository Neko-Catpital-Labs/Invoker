#!/usr/bin/env bash
#
# Deterministic repro for the redundant post-bootstrap startup snapshot.
#
# After preload pushes a full `preload_bootstrap_sync` into the renderer
# (carrying every persisted task + workflow), the useTasks hook still issues
# a non-forced getTasks() call on mount. The resulting
# `useTasks_snapshot_replace` rebuilds the renderer's task/workflow maps
# from a payload identical to what bootstrap already supplied, costing
# ~65-164ms of main-thread work and ~377KB of IPC moved after the graph
# is already visible.
#
# This script boots an isolated Electron app twice against a seeded DB
# with multiple workflows/tasks, captures `ui-perf` activity_log entries,
# and decides PASS/FAIL based on whether a non-forced
# `useTasks_snapshot_replace` appears AFTER `preload_bootstrap_sync`.
#
# Modes:
#   --expect-issue   PASS when the redundant non-forced snapshot IS seen
#                    (confirms the bug exists today).
#   (default)        PASS only when no redundant non-forced snapshot is
#                    seen (validates the optimization).

set -euo pipefail

EXPECT_ISSUE=0
WORKFLOW_COUNT="${WORKFLOW_COUNT:-5}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-7}"
SETTLE_MS="${SETTLE_MS:-4000}"
LAUNCH_TIMEOUT_MS="${LAUNCH_TIMEOUT_MS:-60000}"
KEEP_TMP="${KEEP_TMP:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue                 PASS only if the redundant non-forced
                                 useTasks_snapshot_replace IS observed after
                                 preload_bootstrap_sync (baseline mode).
  --workflows N                  Number of seeded workflows (default: ${WORKFLOW_COUNT}).
  --tasks-per-workflow N         Tasks per seeded workflow (default: ${TASKS_PER_WORKFLOW}).
  --settle-ms MS                 Renderer settle window after graph visible
                                 (default: ${SETTLE_MS}).
  --launch-timeout-ms MS         Electron launch / page-readiness timeout
                                 (default: ${LAUNCH_TIMEOUT_MS}).
  --keep-tmp                     Leave the temp dir in place after exit.
  -h, --help                     Show this help.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)            EXPECT_ISSUE=1 ;;
    --workflows)               shift; WORKFLOW_COUNT="$1" ;;
    --workflows=*)             WORKFLOW_COUNT="${1#*=}" ;;
    --tasks-per-workflow)      shift; TASKS_PER_WORKFLOW="$1" ;;
    --tasks-per-workflow=*)    TASKS_PER_WORKFLOW="${1#*=}" ;;
    --settle-ms)               shift; SETTLE_MS="$1" ;;
    --settle-ms=*)             SETTLE_MS="${1#*=}" ;;
    --launch-timeout-ms)       shift; LAUNCH_TIMEOUT_MS="$1" ;;
    --launch-timeout-ms=*)     LAUNCH_TIMEOUT_MS="${1#*=}" ;;
    --keep-tmp)                KEEP_TMP=1 ;;
    -h|--help)                 usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot.XXXXXX)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
BARE_REPO="$TMP_DIR/seed-remote.git"
SEED_CLONE="$TMP_DIR/seed-clone"
CONFIG_PATH="$TMP_DIR/config.json"
REPORT_PATH="$TMP_DIR/report.json"
# Helper.mjs must live inside packages/app so Node ESM resolution can find
# @playwright/test via the app's node_modules. NODE_PATH does not work for ESM.
HELPER_PATH="$REPO_ROOT/packages/app/.repro-startup-snapshot-probe.mjs"
HELPER_LOG="$TMP_DIR/probe.log"

cleanup() {
  rm -f "$HELPER_PATH"
  if [[ "$KEEP_TMP" = "1" ]]; then
    echo "repro: KEEP_TMP=1 -- leaving $TMP_DIR in place"
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

if [[ ! -f "$REPO_ROOT/packages/ui/dist/index.html" ]]; then
  echo "repro: building @invoker/ui dist..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)
fi
if [[ ! -f "$REPO_ROOT/packages/surfaces/dist/index.js" ]]; then
  echo "repro: building @invoker/surfaces dist..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/surfaces build >/dev/null)
fi
if [[ ! -f "$REPO_ROOT/packages/app/dist/main.js" ]]; then
  echo "repro: building @invoker/app dist..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build >/dev/null)
fi

# Bare repo with master + main so any incidental WorktreeExecutor clone
# attempts during seeding don't error out on missing branches.
git init --bare "$BARE_REPO" >/dev/null 2>&1
git clone --quiet "$BARE_REPO" "$SEED_CLONE" >/dev/null 2>&1
(
  cd "$SEED_CLONE"
  git -c user.name='Invoker Repro' -c user.email='repro@invoker.dev' \
      commit --allow-empty --quiet -m 'init'
  git push --quiet origin HEAD:refs/heads/master
  git push --quiet origin HEAD:refs/heads/main
)
rm -rf "$SEED_CLONE"

cat > "$CONFIG_PATH" <<'JSON'
{"autoFixRetries":0,"maxConcurrency":1}
JSON

# ── Playwright-driven Electron probe ──────────────────────────
# Phase 1 seeds N workflows via window.invoker.loadPlan (which only
# persists into the orchestrator; no execution kicks off without a
# subsequent invoker:start). Phase 2 relaunches against the same DB,
# waits for the workflow graph to become visible, and reads activity_log
# entries so we can pin down which ui-perf events fired AFTER
# preload_bootstrap_sync.
cat > "$HELPER_PATH" <<'NODE'
import { _electron as electron } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';

const repoRoot = process.env.REPO_ROOT;
const dbDir = process.env.REPRO_DB_DIR;
const configPath = process.env.REPRO_CONFIG_PATH;
const bareRepo = process.env.REPRO_BARE_REPO;
const reportPath = process.env.REPRO_REPORT_PATH;
const workflowCount = Number(process.env.REPRO_WORKFLOW_COUNT ?? '5');
const tasksPerWorkflow = Number(process.env.REPRO_TASKS_PER_WORKFLOW ?? '7');
const settleMs = Number(process.env.REPRO_SETTLE_MS ?? '4000');
const launchTimeoutMs = Number(process.env.REPRO_LAUNCH_TIMEOUT_MS ?? '60000');
const mainEntry = path.join(repoRoot, 'packages', 'app', 'dist', 'main.js');
const repoUrl = `file://${bareRepo}`;

function buildPlanYaml(index) {
  const lines = [
    `name: startup-snapshot-repro-${index}`,
    'onFinish: none',
    `repoUrl: ${repoUrl}`,
    'tasks:',
  ];
  for (let i = 0; i < tasksPerWorkflow; i += 1) {
    const id = `task-${index}-${i}`;
    lines.push(`  - id: ${id}`);
    lines.push(`    description: "Seed ${id}"`);
    lines.push('    command: "true"');
    if (i > 0) {
      lines.push(`    dependencies: ["task-${index}-${i - 1}"]`);
    }
  }
  return lines.join('\n') + '\n';
}

const linuxArgs = process.platform === 'linux'
  ? [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer',
    ]
  : [];

const launchEnv = {
  ...process.env,
  HOME: process.env.HOME,
  INVOKER_DB_DIR: dbDir,
  INVOKER_REPO_CONFIG_PATH: configPath,
  INVOKER_ALLOW_DELETE_ALL: '1',
};

// chdir so @playwright/test (and the bundled electron) resolves from the
// workspace it was installed into.
process.chdir(path.join(repoRoot, 'packages', 'app'));

async function withElectron(label, fn) {
  const app = await electron.launch({
    args: [...linuxArgs, mainEntry],
    env: launchEnv,
    timeout: launchTimeoutMs,
  });
  try {
    return await fn(app);
  } finally {
    try {
      await app.close();
    } catch (err) {
      console.error(`[${label}] electron close failed:`, err);
    }
  }
}

await withElectron('seed', async (app) => {
  const page = await app.firstWindow({ timeout: launchTimeoutMs });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => typeof window.invoker !== 'undefined',
    null,
    { timeout: launchTimeoutMs },
  );
  for (let i = 0; i < workflowCount; i += 1) {
    const yaml = buildPlanYaml(i);
    await page.evaluate(async (planText) => {
      await window.invoker.loadPlan(planText);
    }, yaml);
  }
});

const observed = await withElectron('measure', async (app) => {
  const page = await app.firstWindow({ timeout: launchTimeoutMs });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => typeof window.invoker !== 'undefined',
    null,
    { timeout: launchTimeoutMs },
  );
  await page
    .locator('[data-testid^="workflow-node-"]')
    .first()
    .waitFor({ state: 'visible', timeout: launchTimeoutMs });
  // Let late-firing ui-perf reports (snapshot replace, graph visible)
  // flush before we read the activity_log.
  await page.waitForTimeout(settleMs);
  return await page.evaluate(async () => ({
    activityLogs: await window.invoker.getActivityLogs(),
  }));
});

const uiPerf = observed.activityLogs
  .filter((entry) => entry.source === 'ui-perf')
  .map((entry) => {
    let payload = null;
    try {
      payload = JSON.parse(entry.message);
    } catch {
      payload = null;
    }
    return { id: entry.id, timestamp: entry.timestamp, payload };
  })
  .filter((entry) => entry.payload && typeof entry.payload === 'object');

// Use findLast so we capture phase 2's bootstrap (the measurement
// relaunch), not phase 1's seed-phase bootstrap which precedes it in
// the shared activity_log.
const bootstrap = uiPerf.findLast((e) => e.payload.metric === 'preload_bootstrap_sync');
const graphVisible = uiPerf.findLast((e) => e.payload.metric === 'startup_workflow_graph_visible');

const snapshotReplacesAfterBootstrap = uiPerf
  .filter((e) => e.payload.metric === 'useTasks_snapshot_replace')
  .filter((e) => !bootstrap || e.id > bootstrap.id)
  .map((e) => ({ id: e.id, timestamp: e.timestamp, ...e.payload }));

const report = {
  expectedWorkflowCount: workflowCount,
  expectedTasksPerWorkflow: tasksPerWorkflow,
  preloadBootstrapSync: bootstrap
    ? { id: bootstrap.id, timestamp: bootstrap.timestamp, ...bootstrap.payload }
    : null,
  startupWorkflowGraphVisible: graphVisible
    ? { id: graphVisible.id, timestamp: graphVisible.timestamp, ...graphVisible.payload }
    : null,
  snapshotReplacesAfterBootstrap,
  uiPerfTimeline: uiPerf.map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    metric: e.payload.metric,
  })),
};

writeFileSync(reportPath, JSON.stringify(report, null, 2));
NODE

run_helper() {
  local -a helper_env=(
    REPO_ROOT="$REPO_ROOT"
    HOME="$HOME_DIR"
    REPRO_DB_DIR="$DB_DIR"
    REPRO_CONFIG_PATH="$CONFIG_PATH"
    REPRO_BARE_REPO="$BARE_REPO"
    REPRO_REPORT_PATH="$REPORT_PATH"
    REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
    REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
    REPRO_SETTLE_MS="$SETTLE_MS"
    REPRO_LAUNCH_TIMEOUT_MS="$LAUNCH_TIMEOUT_MS"
  )

  if [[ "$(uname -s)" == "Linux" ]] && command -v xvfb-run >/dev/null 2>&1; then
    env "${helper_env[@]}" xvfb-run --auto-servernum node "$HELPER_PATH"
  else
    env "${helper_env[@]}" node "$HELPER_PATH"
  fi
}

echo "repro: launching Electron probe (workflows=$WORKFLOW_COUNT, tasks=$TASKS_PER_WORKFLOW)..."
if ! run_helper >"$HELPER_LOG" 2>&1; then
  echo "repro: helper failed -- last 100 lines of $HELPER_LOG:" >&2
  tail -n 100 "$HELPER_LOG" >&2 || true
  exit 1
fi

if [[ ! -s "$REPORT_PATH" ]]; then
  echo "repro: helper produced no report at $REPORT_PATH" >&2
  tail -n 100 "$HELPER_LOG" >&2 || true
  exit 1
fi

EXPECT_ISSUE="$EXPECT_ISSUE" python3 - "$REPORT_PATH" <<'PY'
import json
import os
import sys

expect_issue = os.environ.get("EXPECT_ISSUE", "0") == "1"
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    report = json.load(fh)


def show(value):
    return "<missing>" if value is None else value


bootstrap = report.get("preloadBootstrapSync") or {}
graph = report.get("startupWorkflowGraphVisible") or {}
replaces = report.get("snapshotReplacesAfterBootstrap") or []

print("repro-summary:")
print(f"  preload_bootstrap_sync.taskCount: {show(bootstrap.get('taskCount'))}")
print(f"  preload_bootstrap_sync.workflowCount: {show(bootstrap.get('workflowCount'))}")
print(f"  preload_bootstrap_sync.jsonSizeBytes: {show(bootstrap.get('jsonSizeBytes'))}")
print(f"  preload_bootstrap_sync.durationMs: {show(bootstrap.get('durationMs'))}")
print(f"  preload_bootstrap_sync.processElapsedMs: {show(bootstrap.get('processElapsedMs'))}")
print(f"  startup_workflow_graph_visible.nodeCount: {show(graph.get('nodeCount'))}")
print(f"  startup_workflow_graph_visible.edgeCount: {show(graph.get('edgeCount'))}")
print(f"  startup_workflow_graph_visible.elapsedMs: {show(graph.get('elapsedMs'))}")
print(f"  startup_workflow_graph_visible.processElapsedMs: {show(graph.get('processElapsedMs'))}")
print(f"  useTasks_snapshot_replace events after bootstrap: {len(replaces)}")

non_forced = []
for entry in replaces:
    forced = bool(entry.get("forceRefresh"))
    label = "forced" if forced else "non-forced"
    print(
        "  - "
        f"{label} "
        f"requestDurationMs={show(entry.get('requestDurationMs'))} "
        f"replaceDurationMs={show(entry.get('replaceDurationMs'))} "
        f"taskCount={show(entry.get('taskCount'))} "
        f"workflowCount={show(entry.get('workflowCount'))} "
        f"jsonSizeBytes={show(entry.get('jsonSizeBytes'))}"
    )
    if not forced:
        non_forced.append(entry)

if not bootstrap:
    print("repro: FAIL -- preload_bootstrap_sync was not observed", file=sys.stderr)
    sys.exit(2)

if expect_issue:
    if non_forced:
        print(
            f"repro: PASS (--expect-issue) -- observed {len(non_forced)} "
            "redundant non-forced startup snapshot(s) after preload_bootstrap_sync"
        )
        sys.exit(0)
    print(
        "repro: FAIL (--expect-issue) -- no redundant non-forced startup "
        "snapshot observed; the bug appears to be already fixed",
        file=sys.stderr,
    )
    sys.exit(1)

if non_forced:
    print(
        f"repro: FAIL -- {len(non_forced)} redundant non-forced startup "
        "snapshot(s) detected after preload_bootstrap_sync",
        file=sys.stderr,
    )
    sys.exit(1)

print("repro: PASS -- no redundant non-forced startup snapshot after preload_bootstrap_sync")
sys.exit(0)
PY
