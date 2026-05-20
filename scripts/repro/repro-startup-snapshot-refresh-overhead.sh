#!/usr/bin/env bash
# Repro: redundant post-bootstrap startup snapshot refresh.
#
# After preload_bootstrap_sync delivers a full task/workflow snapshot to the
# renderer, useTasks.fetchAll() still fires a non-forced getTasks() that
# replaces the maps with another full snapshot (~65-164ms request and ~377KB
# of JSON moved with 30 workflows × 8 tasks). This script seeds an isolated
# DB, launches Electron, and inspects ui-perf activity_log entries to assert
# whether that second snapshot is still happening.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh --expect-issue
#
# Exit codes:
#   --expect-issue          0 when a non-forced useTasks_snapshot_replace is
#                             observed after preload_bootstrap_sync (current
#                             baseline). Non-zero otherwise.
#   (no flag)               0 when no redundant non-forced startup snapshot
#                             follows preload_bootstrap_sync (post-fix
#                             expectation). Non-zero otherwise.
#
# Env knobs:
#   WORKFLOW_COUNT          Number of workflows to seed (default 15).
#   TASKS_PER_WORKFLOW      Tasks per workflow (default 8).
#   STARTUP_TIMEOUT_MS      Wait budget for the workflow graph (default 20000).
#   POST_SNAPSHOT_QUIET_MS  Pause after graph-visible before harvesting (default 2500).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REMOTE_REPO="$TMP_DIR/remote.git"
CONFIG_PATH="$TMP_DIR/config.json"
DRIVER_PATH="$TMP_DIR/driver.cjs"
DRIVER_OUTPUT="$TMP_DIR/perf.json"
DRIVER_STDERR="$TMP_DIR/driver.stderr.log"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-15}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-8}"
STARTUP_TIMEOUT_MS="${STARTUP_TIMEOUT_MS:-20000}"
POST_SNAPSHOT_QUIET_MS="${POST_SNAPSHOT_QUIET_MS:-2500}"

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '2,27p' "$0"
      exit 0
      ;;
    *)
      echo "repro: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]] || [[ ! -f packages/app/dist/preload.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi
if [[ ! -f packages/ui/dist/index.html ]]; then
  pnpm --filter @invoker/ui build >/dev/null
fi
if [[ ! -f packages/surfaces/dist/index.js ]]; then
  pnpm --filter @invoker/surfaces build >/dev/null
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"maxConcurrency":1}
EOF

cat > "$DRIVER_PATH" <<'DRIVER'
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const REPO_ROOT = process.env.REPRO_REPO_ROOT;
const DB_DIR = process.env.REPRO_DB_DIR;
const CONFIG_PATH = process.env.REPRO_CONFIG_PATH;
const REMOTE_REPO = process.env.REPRO_REMOTE_REPO;
const STARTUP_TIMEOUT_MS = Number(process.env.REPRO_STARTUP_TIMEOUT_MS || 20000);
const POST_SNAPSHOT_QUIET_MS = Number(process.env.REPRO_POST_SNAPSHOT_QUIET_MS || 2500);
const WORKFLOW_COUNT = Number(process.env.REPRO_WORKFLOW_COUNT || 15);
const TASKS_PER_WORKFLOW = Number(process.env.REPRO_TASKS_PER_WORKFLOW || 8);
const OUTPUT_PATH = process.env.REPRO_OUTPUT_PATH;

const mainJs = path.join(REPO_ROOT, 'packages', 'app', 'dist', 'main.js');

function commonArgs() {
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
  args.push(mainJs);
  return args;
}

function launch(extraEnv) {
  return electron.launch({
    args: commonArgs(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: DB_DIR,
      INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      ...extraEnv,
    },
  });
}

function buildPlanYaml(index) {
  const repoUrl = `file://${REMOTE_REPO}`;
  const lines = [
    `name: startup-snapshot-refresh-repro-${index}`,
    `repoUrl: ${repoUrl}`,
    'onFinish: none',
    'tasks:',
  ];
  for (let t = 0; t < TASKS_PER_WORKFLOW; t += 1) {
    lines.push(`  - id: task-${index}-${t}`);
    lines.push(`    description: Repro task ${index}-${t}`);
    lines.push(`    command: echo repro-${index}-${t}`);
    if (t > 0) {
      lines.push(`    dependencies: [task-${index}-${t - 1}]`);
    }
  }
  return lines.join('\n') + '\n';
}

async function seed() {
  const app = await launch({});
  try {
    const page = await app.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, {
      timeout: STARTUP_TIMEOUT_MS,
    });
    for (let index = 0; index < WORKFLOW_COUNT; index += 1) {
      const yaml = buildPlanYaml(index);
      await page.evaluate((text) => window.invoker.loadPlan(text), yaml);
    }
    const seeded = await page.evaluate(async () => {
      const r = await window.invoker.getTasks(true);
      const tasks = Array.isArray(r) ? r : r.tasks;
      const workflows = Array.isArray(r) ? [] : r.workflows ?? [];
      return { taskCount: tasks.length, workflowCount: workflows.length };
    });
    return seeded;
  } finally {
    await app.close();
  }
}

async function measure() {
  const app = await launch({});
  try {
    const page = await app.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, {
      timeout: STARTUP_TIMEOUT_MS,
    });
    await page
      .locator('[data-testid^="workflow-node-"]').first()
      .waitFor({ state: 'visible', timeout: STARTUP_TIMEOUT_MS });
    await page.waitForTimeout(POST_SNAPSHOT_QUIET_MS);
    const logs = await page.evaluate(() => window.invoker.getActivityLogs());
    return logs;
  } finally {
    await app.close();
  }
}

(async () => {
  const seeded = await seed();
  const activityLogs = await measure();
  fs.writeFileSync(
    OUTPUT_PATH,
    JSON.stringify({ seeded, activityLogs }),
  );
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
DRIVER

export REPRO_REPO_ROOT="$ROOT_DIR"
export REPRO_DB_DIR="$DB_DIR"
export REPRO_CONFIG_PATH="$CONFIG_PATH"
export REPRO_REMOTE_REPO="$REMOTE_REPO"
export REPRO_STARTUP_TIMEOUT_MS="$STARTUP_TIMEOUT_MS"
export REPRO_POST_SNAPSHOT_QUIET_MS="$POST_SNAPSHOT_QUIET_MS"
export REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
export REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
export REPRO_OUTPUT_PATH="$DRIVER_OUTPUT"
export HOME="$HOME_DIR"

DRIVER_CMD=(node "$DRIVER_PATH")
if [[ "$(uname -s)" == "Linux" ]] && command -v xvfb-run >/dev/null 2>&1; then
  DRIVER_CMD=(xvfb-run --auto-servernum "${DRIVER_CMD[@]}")
fi

echo "repro: seeding $WORKFLOW_COUNT workflows × $TASKS_PER_WORKFLOW tasks and capturing startup ui-perf..."
if ! "${DRIVER_CMD[@]}" 2>"$DRIVER_STDERR"; then
  echo "repro: Electron driver failed" >&2
  cat "$DRIVER_STDERR" >&2 || true
  exit 1
fi

popd >/dev/null

EXPECT_ISSUE="$EXPECT_ISSUE" python3 - "$DRIVER_OUTPUT" <<'PY'
import json
import os
import sys

output_path = sys.argv[1]
expect_issue = os.environ.get('EXPECT_ISSUE', '0') == '1'

with open(output_path, 'r', encoding='utf-8') as f:
    bundle = json.load(f)

seeded = bundle.get('seeded') or {}
activity_logs = bundle.get('activityLogs') or []


def parse(entry):
    msg = entry.get('message') or ''
    try:
        return json.loads(msg)
    except Exception:
        return None


ui_perf = []
for entry in activity_logs:
    if entry.get('source') != 'ui-perf':
        continue
    payload = parse(entry)
    if not payload or not isinstance(payload, dict):
        continue
    ui_perf.append({
        'id': entry.get('id') or 0,
        'timestamp': entry.get('timestamp'),
        'payload': payload,
    })

ui_perf.sort(key=lambda row: row['id'])


def find_first(metric, after_id=None):
    for row in ui_perf:
        if row['payload'].get('metric') != metric:
            continue
        if after_id is not None and row['id'] <= after_id:
            continue
        return row
    return None


preload = find_first('preload_bootstrap_sync')
preload_id = preload['id'] if preload else None

snapshot_after_preload = (
    find_first('useTasks_snapshot_replace', after_id=preload_id)
    if preload_id is not None
    else None
)
snapshot_any = find_first('useTasks_snapshot_replace')
snapshot = snapshot_after_preload or snapshot_any

graph_visible = find_first('startup_workflow_graph_visible')
task_graph_visible = find_first('startup_graph_visible')
snapshot_skipped = find_first('startup_snapshot_skipped_smaller_than_bootstrap')


def fmt_num(value, suffix=''):
    if value is None:
        return 'n/a'
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        if isinstance(value, float):
            return f'{value:.1f}{suffix}'
        return f'{value}{suffix}'
    return str(value)


print('repro-summary:')
print(f"  seeded: taskCount={seeded.get('taskCount')} workflowCount={seeded.get('workflowCount')}")

if preload:
    p = preload['payload']
    print(
        '  preload_bootstrap_sync: '
        f"taskCount={p.get('taskCount')} "
        f"workflowCount={p.get('workflowCount')} "
        f"jsonSizeBytes={p.get('jsonSizeBytes')} "
        f"durationMs={fmt_num(p.get('durationMs'), 'ms')}"
    )
else:
    print('  preload_bootstrap_sync: <missing>')

if snapshot:
    p = snapshot['payload']
    forced = bool(p.get('forceRefresh'))
    print(
        '  useTasks_snapshot_replace: '
        f"forceRefresh={str(forced).lower()} "
        f"requestDurationMs={fmt_num(p.get('requestDurationMs'), 'ms')} "
        f"replaceDurationMs={fmt_num(p.get('replaceDurationMs'), 'ms')} "
        f"taskCount={p.get('taskCount')} "
        f"workflowCount={p.get('workflowCount')} "
        f"jsonSizeBytes={p.get('jsonSizeBytes')}"
    )
    print(f"  snapshot_after_preload_bootstrap: {snapshot is snapshot_after_preload}")
else:
    print('  useTasks_snapshot_replace: <missing>')
    print('  snapshot_after_preload_bootstrap: False')

if graph_visible:
    p = graph_visible['payload']
    print(
        '  startup_workflow_graph_visible: '
        f"nodeCount={p.get('nodeCount')} "
        f"edgeCount={p.get('edgeCount')} "
        f"deriveMs={fmt_num(p.get('deriveMs'), 'ms')} "
        f"layoutMs={fmt_num(p.get('layoutMs'), 'ms')} "
        f"elapsedMs={fmt_num(p.get('elapsedMs'), 'ms')} "
        f"processElapsedMs={fmt_num(p.get('processElapsedMs'), 'ms')}"
    )
else:
    print('  startup_workflow_graph_visible: <missing>')

if task_graph_visible:
    p = task_graph_visible['payload']
    print(
        '  startup_graph_visible: '
        f"nodeCount={p.get('nodeCount')} "
        f"elapsedMs={fmt_num(p.get('elapsedMs'), 'ms')}"
    )

if snapshot_skipped:
    p = snapshot_skipped['payload']
    print(
        '  startup_snapshot_skipped_smaller_than_bootstrap: '
        f"bootstrapTaskCount={p.get('bootstrapTaskCount')} "
        f"snapshotTaskCount={p.get('snapshotTaskCount')} "
        f"requestDurationMs={fmt_num(p.get('requestDurationMs'), 'ms')}"
    )

bootstrap_non_empty = (
    bool(preload)
    and (
        (preload['payload'].get('taskCount') or 0) > 0
        or (preload['payload'].get('workflowCount') or 0) > 0
    )
)
forced_after_preload = (
    bool(snapshot_after_preload)
    and bool(snapshot_after_preload['payload'].get('forceRefresh'))
)
redundant = (
    bootstrap_non_empty
    and snapshot_after_preload is not None
    and not forced_after_preload
)

print(f"  forced_after_preload_bootstrap: {str(forced_after_preload).lower()}")
print(f"  redundant_non_forced_post_bootstrap_snapshot: {str(redundant).lower()}")

if expect_issue:
    if redundant:
        print('repro: PASS (baseline issue reproduced — redundant non-forced startup snapshot observed)')
        sys.exit(0)
    print('repro: FAIL (expected redundant non-forced startup snapshot, did not observe)', file=sys.stderr)
    sys.exit(1)

if redundant:
    print('repro: FAIL (redundant non-forced startup snapshot still occurs after bootstrap)', file=sys.stderr)
    sys.exit(1)
print('repro: PASS (no redundant non-forced startup snapshot after preload bootstrap)')
sys.exit(0)
PY
