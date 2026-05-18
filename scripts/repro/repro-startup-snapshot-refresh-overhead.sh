#!/usr/bin/env bash
set -euo pipefail

# Deterministic repro for the redundant post-bootstrap startup snapshot request.
#
# After preload writes window.__INVOKER_BOOTSTRAP__, the renderer's useTasks
# hook still calls window.invoker.getTasks(false) on mount, which triggers a
# second full snapshot replace (`useTasks_snapshot_replace` with
# forceRefresh=false) — costing roughly 65-164ms and ~377KB after the graph is
# already visible.
#
# This script launches an isolated Electron startup fixture seeded with
# multiple workflows/tasks, then reads ui-perf entries from `activity_log` to
# detect that redundant snapshot deterministically.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#                                                            [--workflows N]
#                                                            [--tasks-per-workflow N]
#                                                            [--keep-tmp]
#
# Modes:
#   --expect-issue   exit 0 when a non-forced useTasks_snapshot_replace is
#                    observed after preload_bootstrap_sync (current baseline).
#   default          exit 0 only when NO redundant non-forced startup snapshot
#                    is observed (post-optimization).
#
# Always prints:
#   - preload_bootstrap_sync task/workflow counts and jsonSizeBytes
#   - useTasks_snapshot_replace.requestDurationMs / replaceDurationMs / forced
#   - graph visible timing and node/edge counts (workflow + task DAG)

EXPECT_ISSUE=0
WORKFLOW_COUNT="${WORKFLOW_COUNT:-8}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-4}"
KEEP_TMP=0

usage() {
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT_DIR/packages/app"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
OUTPUT_PATH="$TMP_DIR/activity-log.json"
SPEC_NAME="_repro-startup-snapshot-refresh-overhead.spec.ts"
SPEC_PATH="$APP_DIR/e2e/$SPEC_NAME"

cleanup() {
  rm -f "$SPEC_PATH"
  if [[ "$KEEP_TMP" -eq 0 ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "[repro] keeping tmp dir: $TMP_DIR" >&2
  fi
}
trap cleanup EXIT

if [[ ! -x "$ROOT_DIR/scripts/e2e-dry-run/fixtures/claude-marker.sh" ]]; then
  echo "[repro] missing claude-marker fixture; aborting" >&2
  exit 2
fi

if [[ ! -d "$APP_DIR/node_modules/@playwright/test" ]]; then
  echo "[repro] missing @playwright/test under packages/app/node_modules (run pnpm install)" >&2
  exit 2
fi

# Playwright global-setup builds the UI and app if dist/ is missing — no
# explicit build step needed here. It also creates /tmp/invoker-e2e-repo.git.

cat > "$SPEC_PATH" <<'SPEC'
import { _electron as electron, expect, test } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { stringify as yamlStringify } from 'yaml';
import { resolveRepoRoot } from '@invoker/contracts';
import { E2E_REPO_URL } from './fixtures/electron-app.js';

const repoRoot = resolveRepoRoot(__dirname);
const OUTPUT_PATH = process.env.REPRO_OUTPUT_PATH;
if (!OUTPUT_PATH) throw new Error('REPRO_OUTPUT_PATH must be set');
const WORKFLOW_COUNT = Number(process.env.REPRO_WORKFLOW_COUNT ?? '8');
const TASKS_PER_WORKFLOW = Number(process.env.REPRO_TASKS_PER_WORKFLOW ?? '4');

function buildPlan(index: number) {
  return {
    name: `Snapshot Refresh Repro ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, t) => ({
      id: `task-${index}-${t}`,
      description: `Task ${index}-${t}`,
      command: `echo task-${index}-${t}`,
      dependencies: t === 0 ? [] : [`task-${index}-${t - 1}`],
    })),
  };
}

async function launchElectron(testDir: string) {
  const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
  const stubDir = path.join(testDir, 'claude-stub');
  const markerRoot = path.join(testDir, 'e2e-markers');
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.mkdir(markerRoot, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  try {
    await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
  } catch {
    /* symlink optional */
  }
  return electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
        : []),
      path.resolve(repoRoot, 'packages', 'app', 'dist', 'main.js'),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_MARKER_ROOT: markerRoot,
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
}

test('repro: redundant post-bootstrap startup snapshot', async () => {
  test.setTimeout(120_000);
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-repro-snapshot-'));

  // Phase 1: seed an isolated DB with workflows/tasks via a throwaway launch.
  const seedApp = await launchElectron(testDir);
  try {
    const page = await seedApp.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30_000 });
    for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
      const planYaml = yamlStringify(buildPlan(i));
      await page.evaluate(async (yaml) => { await window.invoker.loadPlan(yaml); }, planYaml);
    }
    const seeded = await page.evaluate(async () => {
      const result = await window.invoker.getTasks(true);
      const tasks = Array.isArray(result) ? result : result.tasks;
      return tasks.length;
    });
    expect(seeded).toBeGreaterThanOrEqual(WORKFLOW_COUNT * TASKS_PER_WORKFLOW);
  } finally {
    await seedApp.close();
  }

  // Phase 2: fresh launch against the seeded DB — observe ui-perf events.
  const app = await launchElectron(testDir);
  let logs: Array<{ id: number; source: string; level: string; message: string; timestamp: string }> = [];
  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30_000 });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({ state: 'visible', timeout: 30_000 });

    // Click the first workflow so the task DAG renders and emits
    // startup_graph_visible (per WorkflowGraph + TaskDAG instrumentation).
    try {
      await page.locator('[data-testid^="workflow-node-"]').first().click({ timeout: 5_000 });
    } catch {
      /* graph click optional — workflow graph visibility is the primary metric */
    }

    // Allow ui-perf events (preload_bootstrap_sync via setTimeout(0), the
    // useTasks_snapshot_replace IPC, and startup_*_graph_visible RAFs) to
    // flush into the activity_log.
    await page.waitForTimeout(2_500);

    logs = await page.evaluate(async () => window.invoker.getActivityLogs());
  } finally {
    await app.close();
  }

  writeFileSync(OUTPUT_PATH, JSON.stringify(logs), 'utf8');
});
SPEC

echo "[repro] generated spec at $SPEC_PATH" >&2
echo "[repro] seeding $WORKFLOW_COUNT workflows × $TASKS_PER_WORKFLOW tasks in isolated DB..." >&2

PLAYWRIGHT_CMD=(npx playwright test "$SPEC_NAME" --reporter=line)
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "[repro] GUI driver requires xvfb-run on headless Linux. Install xvfb or set DISPLAY." >&2
    exit 2
  fi
  PLAYWRIGHT_CMD=(xvfb-run --auto-servernum "${PLAYWRIGHT_CMD[@]}")
fi

REPRO_OUTPUT_PATH="$OUTPUT_PATH" \
  REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
  REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  bash -c "cd '$APP_DIR' && ${PLAYWRIGHT_CMD[*]}"

if [[ ! -s "$OUTPUT_PATH" ]]; then
  echo "[repro] no activity_log captured at $OUTPUT_PATH" >&2
  exit 2
fi

python3 - "$OUTPUT_PATH" "$EXPECT_ISSUE" <<'PY'
import json
import sys

output_path, expect_issue_arg = sys.argv[1], sys.argv[2]
expect_issue = expect_issue_arg == '1'

with open(output_path, 'r', encoding='utf-8') as f:
    entries = json.load(f)

ui_events = []
for entry in entries:
    if entry.get('source') not in ('ui-perf', 'ui-perf-main'):
        continue
    try:
        payload = json.loads(entry.get('message') or '')
    except Exception:
        continue
    ui_events.append({
        '_id': entry.get('id') or 0,
        '_source': entry.get('source'),
        **payload,
    })

ui_events.sort(key=lambda e: e.get('_id', 0))

def find_all(metric):
    return [e for e in ui_events if e.get('metric') == metric]

# The seeding launch and the repro launch share an activity_log, so anchor
# analysis on the LAST preload_bootstrap_sync (the repro launch's).
preload_events = find_all('preload_bootstrap_sync')
bootstrap = preload_events[-1] if preload_events else None
bootstrap_id = bootstrap.get('_id', 0) if bootstrap else 0
snapshot_replaces = [
    e for e in find_all('useTasks_snapshot_replace')
    if e.get('_id', 0) > bootstrap_id
]
workflow_graph_candidates = [
    e for e in find_all('startup_workflow_graph_visible')
    if e.get('_id', 0) > bootstrap_id
]
workflow_graph_visible = workflow_graph_candidates[-1] if workflow_graph_candidates else None
task_graph_candidates = [
    e for e in find_all('startup_graph_visible')
    if e.get('_id', 0) > bootstrap_id
]
task_graph_visible = task_graph_candidates[-1] if task_graph_candidates else None

def fmt(value, suffix=''):
    if value is None:
        return '<missing>'
    if isinstance(value, float):
        return f'{value:.2f}{suffix}'
    return f'{value}{suffix}'

print('repro-summary:')
if bootstrap is None:
    print('  preload_bootstrap_sync: <missing>')
else:
    print(f"  preload_bootstrap_sync.taskCount: {fmt(bootstrap.get('taskCount'))}")
    print(f"  preload_bootstrap_sync.workflowCount: {fmt(bootstrap.get('workflowCount'))}")
    print(f"  preload_bootstrap_sync.jsonSizeBytes: {fmt(bootstrap.get('jsonSizeBytes'))}")
    print(f"  preload_bootstrap_sync.durationMs: {fmt(bootstrap.get('durationMs'), 'ms')}")
    print(f"  preload_bootstrap_sync._id: {bootstrap.get('_id')}")

if not snapshot_replaces:
    print('  useTasks_snapshot_replace: <none>')
else:
    for i, r in enumerate(snapshot_replaces):
        print(f"  useTasks_snapshot_replace[{i}].forceRefresh: {fmt(r.get('forceRefresh'))}")
        print(f"  useTasks_snapshot_replace[{i}].requestDurationMs: {fmt(r.get('requestDurationMs'), 'ms')}")
        print(f"  useTasks_snapshot_replace[{i}].replaceDurationMs: {fmt(r.get('replaceDurationMs'), 'ms')}")
        print(f"  useTasks_snapshot_replace[{i}].taskCount: {fmt(r.get('taskCount'))}")
        print(f"  useTasks_snapshot_replace[{i}].workflowCount: {fmt(r.get('workflowCount'))}")
        print(f"  useTasks_snapshot_replace[{i}].jsonSizeBytes: {fmt(r.get('jsonSizeBytes'))}")
        print(f"  useTasks_snapshot_replace[{i}]._id: {r.get('_id')}")

if workflow_graph_visible is None:
    print('  startup_workflow_graph_visible: <missing>')
else:
    print(f"  startup_workflow_graph_visible.nodeCount: {fmt(workflow_graph_visible.get('nodeCount'))}")
    print(f"  startup_workflow_graph_visible.edgeCount: {fmt(workflow_graph_visible.get('edgeCount'))}")
    print(f"  startup_workflow_graph_visible.elapsedMs: {fmt(workflow_graph_visible.get('elapsedMs'), 'ms')}")
    print(f"  startup_workflow_graph_visible.processElapsedMs: {fmt(workflow_graph_visible.get('processElapsedMs'), 'ms')}")

if task_graph_visible is None:
    print('  startup_graph_visible: <missing>')
else:
    print(f"  startup_graph_visible.nodeCount: {fmt(task_graph_visible.get('nodeCount'))}")
    print(f"  startup_graph_visible.edgeCount: {fmt(task_graph_visible.get('edgeCount'))}")
    print(f"  startup_graph_visible.elapsedMs: {fmt(task_graph_visible.get('elapsedMs'), 'ms')}")

redundant = [r for r in snapshot_replaces if r.get('forceRefresh') is False]

print(f"  redundant_non_forced_snapshot_replaces_after_bootstrap: {len(redundant)}")

if expect_issue:
    if redundant:
        print('repro: PASS (--expect-issue) — observed redundant non-forced useTasks_snapshot_replace after preload_bootstrap_sync')
        sys.exit(0)
    print('repro: FAIL (--expect-issue) — did not observe a redundant non-forced startup snapshot replace')
    sys.exit(1)
else:
    if not redundant:
        print('repro: PASS — no redundant non-forced startup snapshot replace detected')
        sys.exit(0)
    print('repro: FAIL — redundant non-forced startup snapshot replace still occurs')
    sys.exit(1)
PY
