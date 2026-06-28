#!/usr/bin/env bash
# Repro: redundant non-forced useTasks_snapshot_replace after preload bootstrap.
#
# Seeds an isolated Invoker DB with multiple workflows/tasks, relaunches the
# Electron app, captures ui-perf entries from the activity_log, and asserts the
# presence (or absence) of a redundant non-forced startup snapshot refresh.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#
#   --expect-issue   Pass when the baseline bug reproduces (non-forced
#                    useTasks_snapshot_replace observed after
#                    preload_bootstrap_sync). Without it, the script passes
#                    only when no redundant non-forced startup snapshot fires.
#
# Env overrides:
#   WORKFLOW_COUNT          number of workflows to seed (default: 10)
#   TASKS_PER_WORKFLOW      tasks per seeded workflow (default: 10)
#   STARTUP_TIMEOUT_MS      ms to wait for graph + perf entries (default: 30000)
#   POST_GRAPH_WAIT_MS      ms to wait after graph visible before reading logs
#                           (default: 2500)
#   INVOKER_REPRO_KEEP_TMP  1 to keep the temp directory after the run.

set -euo pipefail

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      echo "repro: unknown argument: $arg" >&2
      exit 64
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-10}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-10}"
STARTUP_TIMEOUT_MS="${STARTUP_TIMEOUT_MS:-30000}"
POST_GRAPH_WAIT_MS="${POST_GRAPH_WAIT_MS:-2500}"
KEEP_TMP="${INVOKER_REPRO_KEEP_TMP:-0}"

for cmd in node git python3 pnpm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "repro: required command not found: $cmd" >&2
    exit 2
  fi
done

if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && ! command -v xvfb-run >/dev/null 2>&1; then
  echo "repro: Linux without DISPLAY requires xvfb-run; please install it." >&2
  exit 2
fi

ensure_built() {
  local missing=0
  [ -f "$REPO_ROOT/packages/app/dist/main.js" ] || missing=1
  [ -f "$REPO_ROOT/packages/ui/dist/index.html" ] || missing=1
  [ -f "$REPO_ROOT/packages/surfaces/dist/index.js" ] || missing=1
  if [ "$missing" -ne 0 ]; then
    echo "repro: building Invoker packages (missing dist artifacts)" >&2
    pnpm --filter @invoker/core build >&2
    pnpm --filter @invoker/persistence build >&2
    pnpm --filter @invoker/executors build >&2
    pnpm --filter @invoker/surfaces build >&2
    pnpm --filter @invoker/ui build >&2
    pnpm --filter @invoker/app build >&2
  fi
}

ensure_built

TMP_DIR="$(mktemp -d -t invoker-repro-startup-snapshot-XXXXXX)"
cleanup() {
  if [ "$KEEP_TMP" = "1" ]; then
    echo "repro: keeping temp dir at $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

DB_DIR="$TMP_DIR/invoker-db"
BARE_REPO="$TMP_DIR/bare-repo.git"
SETUP_CLONE="$TMP_DIR/bare-repo-setup"
MARKER_ROOT="$TMP_DIR/e2e-markers"
STUB_DIR="$TMP_DIR/claude-stub"
CONFIG_PATH="$TMP_DIR/repo-config.json"
HELPER_JS="$TMP_DIR/repro-helper.mjs"
RESULT_JSON="$TMP_DIR/result.json"

mkdir -p "$DB_DIR" "$MARKER_ROOT" "$STUB_DIR"

git init --bare "$BARE_REPO" >/dev/null 2>&1
GIT_AUTHOR_NAME="Invoker Repro" GIT_AUTHOR_EMAIL="repro@invoker.dev" \
GIT_COMMITTER_NAME="Invoker Repro" GIT_COMMITTER_EMAIL="repro@invoker.dev" \
  git clone "$BARE_REPO" "$SETUP_CLONE" >/dev/null 2>&1
(
  cd "$SETUP_CLONE"
  GIT_AUTHOR_NAME="Invoker Repro" GIT_AUTHOR_EMAIL="repro@invoker.dev" \
  GIT_COMMITTER_NAME="Invoker Repro" GIT_COMMITTER_EMAIL="repro@invoker.dev" \
    git commit --allow-empty -m init >/dev/null 2>&1
  git push origin HEAD:refs/heads/master >/dev/null 2>&1
  git push origin HEAD:refs/heads/main >/dev/null 2>&1
)
rm -rf "$SETUP_CLONE"

CLAUDE_MARKER="$REPO_ROOT/scripts/e2e-dry-run/fixtures/claude-marker.sh"
if [ -f "$CLAUDE_MARKER" ]; then
  ln -s "$CLAUDE_MARKER" "$STUB_DIR/claude" 2>/dev/null || true
fi

echo '{"autoFixRetries":0}' > "$CONFIG_PATH"

cat > "$HELPER_JS" <<'NODE_EOF'
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const REPO_ROOT = process.env.REPRO_REPO_ROOT;
const RESULT_JSON = process.env.REPRO_RESULT_JSON;
const WORKFLOW_COUNT = Number(process.env.REPRO_WORKFLOW_COUNT);
const TASKS_PER_WORKFLOW = Number(process.env.REPRO_TASKS_PER_WORKFLOW);
const STARTUP_TIMEOUT_MS = Number(process.env.REPRO_STARTUP_TIMEOUT_MS);
const POST_GRAPH_WAIT_MS = Number(process.env.REPRO_POST_GRAPH_WAIT_MS);
const BARE_REPO = process.env.INVOKER_E2E_BARE_REPO;
const FILE_REPO_URL = 'file://' + BARE_REPO;

const requireFromApp = createRequire(path.join(REPO_ROOT, 'packages/app/package.json'));
const { _electron: electron } = requireFromApp('@playwright/test');
const { stringify: yamlStringify } = requireFromApp('yaml');

const MAIN_JS = path.join(REPO_ROOT, 'packages/app/dist/main.js');
const LINUX_FLAGS = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
  : [];

async function launchApp() {
  return electron.launch({
    args: [...LINUX_FLAGS, MAIN_JS],
    env: { ...process.env, TZ: 'UTC' },
  });
}

function buildPlan(idx) {
  const tasks = [];
  for (let i = 0; i < TASKS_PER_WORKFLOW; i += 1) {
    tasks.push({
      id: `task-${idx}-${i}`,
      description: `Snapshot repro task ${idx}-${i}`,
      command: `echo task-${idx}-${i}`,
      dependencies: i === 0 ? [] : [`task-${idx}-${i - 1}`],
    });
  }
  return { name: `Snapshot Refresh Plan ${idx}`, repoUrl: FILE_REPO_URL, onFinish: 'none', tasks };
}

async function seed() {
  const app = await launchApp();
  try {
    const page = await app.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: STARTUP_TIMEOUT_MS });
    for (let idx = 0; idx < WORKFLOW_COUNT; idx += 1) {
      const planText = yamlStringify(buildPlan(idx));
      await page.evaluate(async (text) => { await window.invoker.loadPlan(text); }, planText);
    }
    const seededCount = await page.evaluate(async () => {
      const result = await window.invoker.getTasks(true);
      const list = Array.isArray(result) ? result : result.tasks;
      return list.length;
    });
    const expected = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;
    if (seededCount !== expected) {
      throw new Error(`seed: expected ${expected} tasks, got ${seededCount}`);
    }
    const baselineLogId = await page.evaluate(async () => {
      const rows = await window.invoker.getActivityLogs();
      let maxId = 0;
      for (const row of rows) {
        if (typeof row.id === 'number' && row.id > maxId) maxId = row.id;
      }
      return maxId;
    });
    return baselineLogId;
  } finally {
    await app.close();
  }
}

function pickPayload(entries, predicate) {
  for (const entry of entries) {
    if (predicate(entry)) return entry;
  }
  return null;
}

async function measure(baselineLogId) {
  const app = await launchApp();
  try {
    const page = await app.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: STARTUP_TIMEOUT_MS });
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: STARTUP_TIMEOUT_MS,
    });
    await page.waitForTimeout(POST_GRAPH_WAIT_MS);
    const rawLogs = await page.evaluate(() => window.invoker.getActivityLogs());
    const uiPerf = [];
    for (const row of rawLogs) {
      if (row.source !== 'ui-perf') continue;
      if (typeof row.id === 'number' && row.id <= baselineLogId) continue;
      try {
        const payload = JSON.parse(row.message);
        uiPerf.push({ id: row.id, timestamp: row.timestamp, ...payload });
      } catch {
        /* skip malformed */
      }
    }
    const preload = pickPayload(uiPerf, (e) => e.metric === 'preload_bootstrap_sync');
    const graphVisible = pickPayload(uiPerf, (e) => e.metric === 'startup_workflow_graph_visible');
    const snapshotReplacePostBootstrap = pickPayload(
      uiPerf,
      (e) => e.metric === 'useTasks_snapshot_replace' && (!preload || e.id > preload.id),
    );
    const snapshotSkipped = pickPayload(uiPerf, (e) => e.metric === 'startup_snapshot_skipped_smaller_than_bootstrap');
    return {
      baselineLogId,
      preload,
      graphVisible,
      snapshotReplacePostBootstrap,
      snapshotSkipped,
      uiPerfEntryCount: uiPerf.length,
    };
  } finally {
    await app.close();
  }
}

const baselineLogId = await seed();
const measurement = await measure(baselineLogId);
fs.writeFileSync(RESULT_JSON, JSON.stringify(measurement, null, 2));
console.error(`repro: wrote measurement to ${RESULT_JSON}`);
NODE_EOF

RUN_ENV=(
  "REPRO_REPO_ROOT=$REPO_ROOT"
  "REPRO_RESULT_JSON=$RESULT_JSON"
  "REPRO_WORKFLOW_COUNT=$WORKFLOW_COUNT"
  "REPRO_TASKS_PER_WORKFLOW=$TASKS_PER_WORKFLOW"
  "REPRO_STARTUP_TIMEOUT_MS=$STARTUP_TIMEOUT_MS"
  "REPRO_POST_GRAPH_WAIT_MS=$POST_GRAPH_WAIT_MS"
  "NODE_ENV=test"
  "TZ=UTC"
  "HOME=$TMP_DIR/home"
  "INVOKER_DB_DIR=$DB_DIR"
  "INVOKER_E2E_BARE_REPO=$BARE_REPO"
  "INVOKER_REPO_CONFIG_PATH=$CONFIG_PATH"
  "INVOKER_E2E_MARKER_ROOT=$MARKER_ROOT"
  "INVOKER_E2E_ENABLE_COMPOSITOR=1"
  "INVOKER_ALLOW_DELETE_ALL=1"
  "INVOKER_CLAUDE_COMMAND=$CLAUDE_MARKER"
  "INVOKER_CLAUDE_FIX_COMMAND=$CLAUDE_MARKER"
  "INVOKER_TEST_RESUME_PENDING_DELAY_MS=60000"
  "INVOKER_TEST_FIXED_NOW=2025-01-01T00:00:00.000Z"
  "PATH=$STUB_DIR:${PATH:-}"
)
mkdir -p "$TMP_DIR/home"

echo "repro: seeding $WORKFLOW_COUNT workflows × $TASKS_PER_WORKFLOW tasks and measuring startup..." >&2
if [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  env "${RUN_ENV[@]}" xvfb-run --auto-servernum node "$HELPER_JS"
else
  env "${RUN_ENV[@]}" node "$HELPER_JS"
fi

python3 - "$RESULT_JSON" "$EXPECT_ISSUE" <<'PY'
import json
import sys

result_path = sys.argv[1]
expect_issue = sys.argv[2] == '1'

with open(result_path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

preload = data.get('preload')
replace = data.get('snapshotReplacePostBootstrap')
graph = data.get('graphVisible')
skipped = data.get('snapshotSkipped')

def fmt(value):
    return 'n/a' if value is None else value

print('repro-summary:')
print(f"  ui_perf_entries_observed: {data.get('uiPerfEntryCount', 0)}")
if preload is None:
    print('  bootstrap.taskCount: n/a')
    print('  bootstrap.workflowCount: n/a')
    print('  bootstrap.jsonSizeBytes: n/a')
else:
    print(f"  bootstrap.taskCount: {fmt(preload.get('taskCount'))}")
    print(f"  bootstrap.workflowCount: {fmt(preload.get('workflowCount'))}")
    print(f"  bootstrap.jsonSizeBytes: {fmt(preload.get('jsonSizeBytes'))}")
    print(f"  bootstrap.durationMs: {fmt(preload.get('durationMs'))}")

if replace is None:
    print('  useTasks_snapshot_replace.requestDurationMs: n/a (no post-bootstrap replace observed)')
    print('  useTasks_snapshot_replace.replaceDurationMs: n/a (no post-bootstrap replace observed)')
    print('  useTasks_snapshot_replace.forced: n/a')
    print('  useTasks_snapshot_replace.jsonSizeBytes: n/a')
else:
    print(f"  useTasks_snapshot_replace.requestDurationMs: {fmt(replace.get('requestDurationMs'))}")
    print(f"  useTasks_snapshot_replace.replaceDurationMs: {fmt(replace.get('replaceDurationMs'))}")
    print(f"  useTasks_snapshot_replace.forced: {bool(replace.get('forceRefresh'))}")
    print(f"  useTasks_snapshot_replace.jsonSizeBytes: {fmt(replace.get('jsonSizeBytes'))}")
    print(f"  useTasks_snapshot_replace.taskCount: {fmt(replace.get('taskCount'))}")
    print(f"  useTasks_snapshot_replace.workflowCount: {fmt(replace.get('workflowCount'))}")

if graph is None:
    print('  startup_workflow_graph_visible: n/a')
else:
    print(f"  startup_workflow_graph_visible.elapsedMs: {fmt(graph.get('elapsedMs'))}")
    print(f"  startup_workflow_graph_visible.processElapsedMs: {fmt(graph.get('processElapsedMs'))}")
    print(f"  startup_workflow_graph_visible.nodeCount: {fmt(graph.get('nodeCount'))}")
    print(f"  startup_workflow_graph_visible.edgeCount: {fmt(graph.get('edgeCount'))}")

if skipped is not None:
    print(f"  startup_snapshot_skipped_smaller_than_bootstrap.bootstrapTaskCount: {fmt(skipped.get('bootstrapTaskCount'))}")
    print(f"  startup_snapshot_skipped_smaller_than_bootstrap.snapshotTaskCount: {fmt(skipped.get('snapshotTaskCount'))}")

redundant = bool(replace) and not bool(replace.get('forceRefresh'))
print(f"  redundant_post_bootstrap_snapshot: {'yes' if redundant else 'no'}")

if expect_issue:
    if redundant:
        print('repro: PASS (--expect-issue) — baseline reproduces redundant non-forced startup snapshot')
        sys.exit(0)
    print('repro: FAIL (--expect-issue) — no redundant non-forced startup snapshot observed', file=sys.stderr)
    sys.exit(1)
else:
    if redundant:
        print('repro: FAIL — redundant non-forced useTasks_snapshot_replace fired after preload_bootstrap_sync', file=sys.stderr)
        sys.exit(1)
    print('repro: PASS — no redundant non-forced startup snapshot refresh observed')
    sys.exit(0)
PY
