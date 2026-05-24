#!/usr/bin/env bash
# Deterministic repro for the redundant post-bootstrap startup snapshot
# request (a non-forced `useTasks_snapshot_replace` fired right after
# `preload_bootstrap_sync`, despite the bootstrap already populating the
# renderer). On the current baseline this redundant fetch costs ~65–164ms
# of IPC + replace time and moves ~377KB of JSON after the graph is
# already visible.
#
# The script seeds an isolated DB with multiple workflows/tasks, then
# launches the real Electron app a second time against that DB and
# captures `ui-perf` entries from `activity_log` to verify whether the
# redundant request happened.
#
# Modes:
#   default          -- expects the optimization in place; exits 0 only
#                       when no non-forced `useTasks_snapshot_replace`
#                       is observed after `preload_bootstrap_sync`.
#   --expect-issue   -- expects the current baseline; exits 0 only when
#                       the redundant non-forced snapshot IS observed.
#
# Environment knobs:
#   WORKFLOW_COUNT          (default 12)  workflows seeded into the DB
#   TASKS_PER_WORKFLOW      (default 6)   tasks per seeded workflow
#   STARTUP_TIMEOUT_MS      (default 30000) graph-visible wait timeout
#   POST_VISIBLE_SETTLE_MS  (default 1500) extra wait for ui-perf flush
#
# Required artefacts: built Invoker app
#   (packages/{ui,surfaces,app}/dist/...). The script builds whatever
#   is missing.

set -euo pipefail

EXPECT_ISSUE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    -h|--help)
      sed -n '2,29p' "$0"
      exit 0
      ;;
    *)
      echo "repro: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
DB_DIR="$TMP_DIR/invoker"
CONFIG_PATH="$TMP_DIR/config.json"
REMOTE_REPO="$TMP_DIR/remote.git"
SEED_OUT="$TMP_DIR/seed.json"
MEASURE_OUT="$TMP_DIR/measure.json"
DRIVER_PATH="$ROOT_DIR/packages/app/.repro-snapshot-driver.cjs"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-12}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-6}"
STARTUP_TIMEOUT_MS="${STARTUP_TIMEOUT_MS:-30000}"
POST_VISIBLE_SETTLE_MS="${POST_VISIBLE_SETTLE_MS:-1500}"

cleanup() {
  rm -rf "$TMP_DIR" || true
  rm -f "$DRIVER_PATH" || true
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/ui/dist/index.html ]]; then
  echo "repro: building @invoker/ui ..." >&2
  pnpm --filter @invoker/ui build >/dev/null
fi
if [[ ! -f packages/surfaces/dist/index.js ]]; then
  echo "repro: building @invoker/surfaces ..." >&2
  pnpm --filter @invoker/surfaces build >/dev/null
fi
if [[ ! -f packages/app/dist/main.js || ! -f packages/app/dist/preload.js ]]; then
  echo "repro: building @invoker/app ..." >&2
  pnpm --filter @invoker/app build >/dev/null
fi

PLAYWRIGHT_PKG="$ROOT_DIR/packages/app/node_modules/@playwright/test"
if [[ ! -d "$PLAYWRIGHT_PKG" ]]; then
  echo "repro: missing $PLAYWRIGHT_PKG (run 'pnpm install' in packages/app)" >&2
  exit 2
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1

# Disable auto-run so seeded plans stay pending and never spawn worktrees
# during either Electron launch. Lets the second startup load the
# persisted workflow/task rows verbatim.
cat > "$CONFIG_PATH" <<EOF
{"disableAutoRunOnStartup": true, "autoFixRetries": 0, "maxConcurrency": 1}
EOF

# ── Node driver ───────────────────────────────────────────────────────────
# Written into packages/app/ so require('@playwright/test') resolves via
# the package's local node_modules. Cleanup trap removes it on exit.
cat > "$DRIVER_PATH" <<'NODE'
/* eslint-disable */
'use strict';
const path = require('node:path');
const fs = require('node:fs');

async function main() {
  const mode = process.env.REPRO_MODE;
  const outputPath = process.env.REPRO_OUTPUT_PATH;
  const sinceId = Number(process.env.REPRO_SINCE_ID || '0');
  const playwrightPath = process.env.REPRO_PLAYWRIGHT_PATH;
  const mainJs = process.env.REPRO_MAIN_JS;
  const startupTimeoutMs = Number(process.env.REPRO_STARTUP_TIMEOUT_MS || '30000');
  const settleMs = Number(process.env.REPRO_POST_VISIBLE_SETTLE_MS || '1500');
  if (!mode || !outputPath || !playwrightPath || !mainJs) {
    throw new Error('driver: missing REPRO_MODE / REPRO_OUTPUT_PATH / REPRO_PLAYWRIGHT_PATH / REPRO_MAIN_JS');
  }
  const { _electron: electron } = require(playwrightPath);
  const launchArgs = [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
         '--disable-gpu-compositing', '--disable-gpu-sandbox',
         '--disable-software-rasterizer']
      : []),
    mainJs,
  ];
  const env = { ...process.env, NODE_ENV: 'test', TZ: 'UTC' };
  const app = await electron.launch({ args: launchArgs, env });
  try {
    const page = await app.firstWindow({ timeout: startupTimeoutMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: startupTimeoutMs });

    if (mode === 'seed') {
      const workflowCount = Number(process.env.REPRO_WORKFLOW_COUNT || '12');
      const tasksPerWf = Number(process.env.REPRO_TASKS_PER_WORKFLOW || '6');
      const remoteRepo = process.env.REPRO_REMOTE_REPO;
      for (let i = 0; i < workflowCount; i++) {
        const lines = [
          `name: snapshot-repro-${i}`,
          'onFinish: none',
          `repoUrl: file://${remoteRepo}`,
          'tasks:',
        ];
        for (let t = 0; t < tasksPerWf; t++) {
          lines.push(`  - id: t-${t}`);
          lines.push(`    description: Snapshot fixture task ${t}`);
          lines.push(`    command: echo seed-${i}-${t}`);
          if (t > 0) {
            lines.push(`    dependencies: [t-${t - 1}]`);
          }
        }
        await page.evaluate((yaml) => window.invoker.loadPlan(yaml), lines.join('\n'));
      }
      // Wait until persistence has caught up so the next launch sees every row.
      await page.waitForFunction(
        ([expectedTasks, expectedWorkflows]) =>
          window.invoker.getTasks(true).then((r) => {
            const tasks = Array.isArray(r) ? r : r.tasks;
            const wfs = Array.isArray(r) ? [] : r.workflows ?? [];
            return tasks.length >= expectedTasks && wfs.length >= expectedWorkflows;
          }),
        [workflowCount * tasksPerWf, workflowCount],
        { timeout: startupTimeoutMs },
      );
      // Capture the high-water mark of activity_log so the measure phase
      // can filter out entries written by this seed launch.
      const seedLogs = await page.evaluate(() => window.invoker.getActivityLogs());
      const maxSeedId = seedLogs.reduce((acc, entry) => Math.max(acc, entry.id || 0), 0);
      fs.writeFileSync(
        outputPath,
        JSON.stringify({ workflowCount, tasksPerWf, maxSeedId }, null, 2),
      );
    } else if (mode === 'measure') {
      await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
        state: 'visible',
        timeout: startupTimeoutMs,
      });
      // Give the renderer a beat to fire post-bootstrap fetchAll + ui-perf logs.
      await page.waitForTimeout(settleMs);
      const logs = await page.evaluate(() => window.invoker.getActivityLogs());
      const filtered = logs.filter((entry) => (entry.id || 0) > sinceId);
      fs.writeFileSync(outputPath, JSON.stringify({ activityLogs: filtered }, null, 2));
    } else {
      throw new Error(`driver: unknown REPRO_MODE=${mode}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack || err.message) : String(err));
  process.exit(1);
});
NODE

run_driver() {
  local mode="$1" output="$2"
  local since_id="${3:-0}"
  local node_cmd=(env
    REPRO_MODE="$mode"
    REPRO_OUTPUT_PATH="$output"
    REPRO_PLAYWRIGHT_PATH="$PLAYWRIGHT_PKG"
    REPRO_MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
    REPRO_SINCE_ID="$since_id"
    REPRO_STARTUP_TIMEOUT_MS="$STARTUP_TIMEOUT_MS"
    REPRO_POST_VISIBLE_SETTLE_MS="$POST_VISIBLE_SETTLE_MS"
    REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
    REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
    REPRO_REMOTE_REPO="$REMOTE_REPO"
    INVOKER_DB_DIR="$DB_DIR"
    INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
    INVOKER_ALLOW_DELETE_ALL=1
    INVOKER_E2E_ENABLE_COMPOSITOR=1
    HOME="$TMP_DIR/home"
    node "$DRIVER_PATH")

  mkdir -p "$TMP_DIR/home"
  if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]] && command -v xvfb-run >/dev/null; then
    xvfb-run --auto-servernum "${node_cmd[@]}"
  else
    "${node_cmd[@]}"
  fi
}

echo "repro: seeding $WORKFLOW_COUNT workflows × $TASKS_PER_WORKFLOW tasks ..."
run_driver seed "$SEED_OUT"

SINCE_ID="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('maxSeedId', 0))" "$SEED_OUT")"

echo "repro: measuring startup against seeded DB (sinceActivityId=$SINCE_ID) ..."
run_driver measure "$MEASURE_OUT" "$SINCE_ID"

popd >/dev/null

echo "repro: analyzing activity_log ..."
python3 - "$MEASURE_OUT" "$EXPECT_ISSUE" <<'PY'
import json
import sys

measure_path = sys.argv[1]
expect_issue = int(sys.argv[2])

with open(measure_path, 'r', encoding='utf-8') as f:
    data = json.load(f)
entries = data.get('activityLogs', [])

def parse_payload(entry):
    if entry.get('source') not in ('ui-perf', 'ui-perf-main', 'startup-phase'):
        return None
    try:
        return json.loads(entry.get('message', ''))
    except Exception:
        return None

records = []
for entry in entries:
    payload = parse_payload(entry)
    if payload is None:
        continue
    records.append({
        'id': entry.get('id'),
        'timestamp': entry.get('timestamp'),
        'source': entry.get('source'),
        'metric': payload.get('metric'),
        'payload': payload,
    })

def find_first(metric):
    for record in records:
        if record['metric'] == metric:
            return record
    return None

def find_last(metric):
    found = None
    for record in records:
        if record['metric'] == metric:
            found = record
    return found

preload = find_first('preload_bootstrap_sync')
bootstrap_state = find_first('startup_bootstrap_state')
snapshot_replaces = [r for r in records if r['metric'] == 'useTasks_snapshot_replace']
first_replace = snapshot_replaces[0] if snapshot_replaces else None
graph_visible = (
    find_last('startup_workflow_graph_visible')
    or find_last('startup_graph_visible')
)

# A "redundant" replace is a non-forced snapshot replace that landed
# after preload_bootstrap_sync. Order is by activity_log id (monotonic).
def is_redundant(replace, preload_record):
    if not replace or not preload_record:
        return False
    if bool(replace['payload'].get('forceRefresh')):
        return False
    return (replace['id'] or 0) > (preload_record['id'] or 0)

redundant_replace = None
for replace in snapshot_replaces:
    if is_redundant(replace, preload):
        redundant_replace = replace
        break

def fmt(value, suffix=''):
    if value is None:
        return 'n/a'
    if isinstance(value, float):
        return f'{value:.1f}{suffix}'
    return f'{value}{suffix}'

print('repro-startup-snapshot-summary:')
if bootstrap_state:
    bp = bootstrap_state['payload']
    print(f"  bootstrap.taskCount: {fmt(bp.get('taskCount'))}")
    print(f"  bootstrap.workflowCount: {fmt(bp.get('workflowCount'))}")
else:
    print('  bootstrap.taskCount: n/a (no startup_bootstrap_state entry)')
    print('  bootstrap.workflowCount: n/a')
if preload:
    pp = preload['payload']
    print(f"  preload.taskCount: {fmt(pp.get('taskCount'))}")
    print(f"  preload.workflowCount: {fmt(pp.get('workflowCount'))}")
    print(f"  preload.jsonSizeBytes: {fmt(pp.get('jsonSizeBytes'))}")
    print(f"  preload.durationMs: {fmt(pp.get('durationMs'), 'ms')}")
else:
    print('  preload.*: n/a (no preload_bootstrap_sync entry)')
if first_replace:
    rp = first_replace['payload']
    print(f"  useTasks_snapshot_replace.forceRefresh: {bool(rp.get('forceRefresh'))}")
    print(f"  useTasks_snapshot_replace.requestDurationMs: {fmt(rp.get('requestDurationMs'), 'ms')}")
    print(f"  useTasks_snapshot_replace.replaceDurationMs: {fmt(rp.get('replaceDurationMs'), 'ms')}")
    print(f"  useTasks_snapshot_replace.jsonSizeBytes: {fmt(rp.get('jsonSizeBytes'))}")
    print(f"  useTasks_snapshot_replace.taskCount: {fmt(rp.get('taskCount'))}")
    print(f"  useTasks_snapshot_replace.workflowCount: {fmt(rp.get('workflowCount'))}")
else:
    print('  useTasks_snapshot_replace.*: n/a (no replace observed)')
print(f"  useTasks_snapshot_replace.count: {len(snapshot_replaces)}")
if graph_visible:
    gp = graph_visible['payload']
    print(f"  graph.metric: {graph_visible['metric']}")
    print(f"  graph.elapsedMs: {fmt(gp.get('elapsedMs'), 'ms')}")
    print(f"  graph.processElapsedMs: {fmt(gp.get('processElapsedMs'), 'ms')}")
    print(f"  graph.nodeCount: {fmt(gp.get('nodeCount'))}")
    print(f"  graph.edgeCount: {fmt(gp.get('edgeCount'))}")
else:
    print('  graph.*: n/a (no startup_(workflow_)?graph_visible entry)')

if redundant_replace:
    rp = redundant_replace['payload']
    print('  redundant_post_bootstrap_replace: YES')
    print(f"    forceRefresh: {bool(rp.get('forceRefresh'))}")
    print(f"    requestDurationMs: {fmt(rp.get('requestDurationMs'), 'ms')}")
    print(f"    replaceDurationMs: {fmt(rp.get('replaceDurationMs'), 'ms')}")
    print(f"    jsonSizeBytes: {fmt(rp.get('jsonSizeBytes'))}")
else:
    print('  redundant_post_bootstrap_replace: NO')

# Exit policy:
#   --expect-issue : exit 0 iff redundant replace observed (proves baseline bug).
#   default        : exit 0 iff no redundant replace observed (proves fix).
if expect_issue:
    if redundant_replace is None:
        print('repro: FAIL (--expect-issue): redundant non-forced snapshot NOT observed', file=sys.stderr)
        sys.exit(1)
    print('repro: PASS (--expect-issue): redundant non-forced snapshot reproduced')
    sys.exit(0)
else:
    if redundant_replace is not None:
        print('repro: FAIL: redundant non-forced snapshot still observed after bootstrap', file=sys.stderr)
        sys.exit(1)
    print('repro: PASS: no redundant non-forced snapshot observed after bootstrap')
    sys.exit(0)
PY
