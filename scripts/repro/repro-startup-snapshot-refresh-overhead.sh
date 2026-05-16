#!/usr/bin/env bash
# Repro for the redundant post-bootstrap startup snapshot request.
#
# Background:
#   On launch, preload.ts pushes the full task/workflow state into the
#   renderer via __INVOKER_BOOTSTRAP__ (single sync IPC), and emits a
#   `preload_bootstrap_sync` ui-perf metric.  useTasks then *also* fires a
#   plain `getTasks(false)` from its mount effect, producing a second full
#   snapshot reported as `useTasks_snapshot_replace` with forceRefresh=false.
#   On non-trivial DBs the second request costs roughly 65–164ms and moves
#   ~377KB after the graph is already visible.
#
# What this script does:
#   1. Provisions an isolated INVOKER_DB_DIR and a local bare repo so the
#      seed plans validate without network access.
#   2. Launches the real Electron app once via @playwright/test's _electron
#      driver and loads N workflows (each with M tasks) via the IPC bridge.
#   3. Relaunches Electron against the seeded DB, waits for the workflow
#      graph to render, then snapshots the ui-perf activity_log entries.
#   4. Analyzes the entries emitted after the latest `preload_bootstrap_sync`
#      and reports the bootstrap counts/size, the snapshot replace timings,
#      whether the snapshot was force-refreshed, and the graph-visible
#      timing/node-edge counts.
#
# Exit code policy:
#   --expect-issue  (current baseline, bug present):
#       Exits 0 when a non-forced `useTasks_snapshot_replace` IS observed
#       after `preload_bootstrap_sync` (the redundant request reproduced).
#       Exits 1 otherwise.
#   (default, post-optimization expectation):
#       Exits 0 when NO non-forced `useTasks_snapshot_replace` is observed
#       after `preload_bootstrap_sync`.
#       Exits 1 otherwise.
#
# Tunables (env):
#   REPRO_WORKFLOW_COUNT       (default 12)  number of seeded workflows
#   REPRO_TASKS_PER_WORKFLOW   (default 8)   tasks per seeded workflow
#   REPRO_STARTUP_TIMEOUT_MS   (default 30000) per-phase electron timeout
#   REPRO_POST_GRAPH_SETTLE_MS (default 2500) how long to wait after the
#                                             graph is visible before
#                                             snapshotting activity_log
#   REPRO_KEEP_TMP=1                          retain temp dir for debugging

set -euo pipefail

EXPECT_ISSUE=0
SHOW_HELP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help) SHOW_HELP=1 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ "$SHOW_HELP" == "1" ]]; then
  awk 'NR==1{next} /^set -euo pipefail/{exit} {sub(/^# ?/, ""); print}' "$0"
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
DB_DIR="$TMP_DIR/home"
CONFIG_PATH="$TMP_DIR/config.json"
BARE_REPO="$TMP_DIR/repo.git"
WORK_CLONE="$TMP_DIR/repo-clone"
DRIVER_FILE="$TMP_DIR/driver.mjs"
OUT_FILE="$TMP_DIR/result.json"
DRIVER_LOG="$TMP_DIR/driver.log"

WORKFLOW_COUNT="${REPRO_WORKFLOW_COUNT:-12}"
TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-8}"
STARTUP_TIMEOUT_MS="${REPRO_STARTUP_TIMEOUT_MS:-30000}"
POST_GRAPH_SETTLE_MS="${REPRO_POST_GRAPH_SETTLE_MS:-2500}"

cleanup() {
  if [[ "${REPRO_KEEP_TMP:-0}" == "1" ]]; then
    echo "[repro] kept temp dir: $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

cat > "$CONFIG_PATH" <<'JSON'
{"autoFixRetries":0,"disableAutoRunOnStartup":true,"maxConcurrency":1}
JSON

# Local bare repo so parsePlan's repoUrl validation passes without network.
GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Invoker Repro}"
GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-repro@invoker.dev}"
GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
git init --bare "$BARE_REPO" >/dev/null
git clone "$BARE_REPO" "$WORK_CLONE" >/dev/null 2>&1
(
  cd "$WORK_CLONE"
  git commit --allow-empty -m "init" >/dev/null
  git push origin HEAD:refs/heads/master >/dev/null 2>&1
  git push origin HEAD:refs/heads/main >/dev/null 2>&1
)
rm -rf "$WORK_CLONE"
REPO_URL="file://$BARE_REPO"

pushd "$ROOT_DIR" >/dev/null
if [[ ! -f packages/app/dist/main.js ]]; then
  echo "[repro] building @invoker/app ..." >&2
  pnpm --filter @invoker/app build >&2
fi
popd >/dev/null

# ESM resolution: symlink packages/app/node_modules so the driver in TMP_DIR
# can import @playwright/test the same way packages/app's e2e tests do.
ln -s "$ROOT_DIR/packages/app/node_modules" "$TMP_DIR/node_modules"

cat > "$DRIVER_FILE" <<'EOJS'
import { _electron as electron } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const mainJs = process.env.MAIN_JS;
const dbDir = process.env.INVOKER_DB_DIR;
const configPath = process.env.INVOKER_REPO_CONFIG_PATH;
const outFile = process.env.OUT_FILE;
const repoUrl = process.env.REPRO_REPO_URL;
const workflowCount = Number(process.env.REPRO_WORKFLOW_COUNT);
const tasksPerWorkflow = Number(process.env.REPRO_TASKS_PER_WORKFLOW);
const startupTimeoutMs = Number(process.env.REPRO_STARTUP_TIMEOUT_MS);
const postGraphSettleMs = Number(process.env.REPRO_POST_GRAPH_SETTLE_MS);

function launchArgs() {
  const linuxFlags = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-software-rasterizer',
  ];
  return [...(process.platform === 'linux' ? linuxFlags : []), mainJs];
}

function makeEnv() {
  return {
    ...process.env,
    NODE_ENV: 'test',
    INVOKER_DB_DIR: dbDir,
    INVOKER_REPO_CONFIG_PATH: configPath,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
  };
}

function buildPlanYaml(index) {
  const lines = [
    `name: Startup Snapshot Repro ${index}`,
    `repoUrl: ${repoUrl}`,
    `onFinish: none`,
    `tasks:`,
  ];
  for (let j = 0; j < tasksPerWorkflow; j += 1) {
    lines.push(`  - id: task-${j}`);
    lines.push(`    description: "Task ${index}-${j}"`);
    lines.push(`    command: "echo task-${index}-${j}"`);
    if (j > 0) {
      lines.push(`    dependencies: ["task-${j - 1}"]`);
    }
  }
  return lines.join('\n') + '\n';
}

async function seedPhase() {
  const app = await electron.launch({ args: launchArgs(), env: makeEnv() });
  try {
    const page = await app.firstWindow({ timeout: startupTimeoutMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof window.invoker !== 'undefined',
      null,
      { timeout: startupTimeoutMs },
    );
    for (let i = 0; i < workflowCount; i += 1) {
      const planYaml = buildPlanYaml(i);
      await page.evaluate((p) => window.invoker.loadPlan(p), planYaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    const workflows = Array.isArray(seeded) ? [] : (seeded.workflows ?? []);
    return { seededTaskCount: tasks.length, seededWorkflowCount: workflows.length };
  } finally {
    await app.close();
  }
}

async function measurePhase() {
  const app = await electron.launch({ args: launchArgs(), env: makeEnv() });
  try {
    const page = await app.firstWindow({ timeout: startupTimeoutMs });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof window.invoker !== 'undefined',
      null,
      { timeout: startupTimeoutMs },
    );
    const graphStart = Date.now();
    await page
      .locator('[data-testid^="workflow-node-"]')
      .first()
      .waitFor({ state: 'visible', timeout: startupTimeoutMs });
    const graphWaitElapsedMs = Date.now() - graphStart;
    // Let the renderer settle so a redundant post-bootstrap snapshot
    // request has time to round-trip and land in activity_log.
    await page.waitForTimeout(postGraphSettleMs);
    const logs = await page.evaluate(() => window.invoker.getActivityLogs());
    return { logs, graphWaitElapsedMs };
  } finally {
    await app.close();
  }
}

try {
  const seedResult = await seedPhase();
  const measureResult = await measurePhase();
  writeFileSync(
    outFile,
    JSON.stringify({
      seededWorkflowCount: seedResult.seededWorkflowCount,
      seededTaskCount: seedResult.seededTaskCount,
      graphWaitElapsedMs: measureResult.graphWaitElapsedMs,
      postGraphSettleMs,
      logs: measureResult.logs,
    }),
  );
} catch (err) {
  const msg = err && err.stack ? err.stack : String(err);
  process.stderr.write(`[driver] FATAL: ${msg}\n`);
  process.exit(1);
}
EOJS

if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "ERROR: xvfb-run is required on Linux when DISPLAY is unset." >&2
    exit 2
  fi
  RUN_CMD=(xvfb-run --auto-servernum node "$DRIVER_FILE")
else
  RUN_CMD=(node "$DRIVER_FILE")
fi

echo "[repro] driving electron startup (workflows=$WORKFLOW_COUNT, tasksPer=$TASKS_PER_WORKFLOW)..." >&2
set +e
env \
  MAIN_JS="$ROOT_DIR/packages/app/dist/main.js" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
  OUT_FILE="$OUT_FILE" \
  REPRO_REPO_URL="$REPO_URL" \
  REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
  REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  REPRO_STARTUP_TIMEOUT_MS="$STARTUP_TIMEOUT_MS" \
  REPRO_POST_GRAPH_SETTLE_MS="$POST_GRAPH_SETTLE_MS" \
  "${RUN_CMD[@]}" >"$DRIVER_LOG" 2>&1
DRIVER_STATUS=$?
set -e

if [[ "$DRIVER_STATUS" -ne 0 || ! -s "$OUT_FILE" ]]; then
  echo "[repro] electron driver failed (exit=$DRIVER_STATUS). Tail of driver log:" >&2
  tail -n 80 "$DRIVER_LOG" >&2 || true
  exit 1
fi

python3 - "$OUT_FILE" "$EXPECT_ISSUE" <<'PY'
import json
import sys

out_file = sys.argv[1]
expect_issue = bool(int(sys.argv[2]))

with open(out_file, "r", encoding="utf-8") as f:
    data = json.load(f)

logs = data.get("logs") or []
graph_wait_ms = data.get("graphWaitElapsedMs")
post_settle_ms = data.get("postGraphSettleMs")
seeded_task_count = data.get("seededTaskCount")
seeded_workflow_count = data.get("seededWorkflowCount")

ui_perf_entries = []
for row in logs:
    if row.get("source") != "ui-perf":
        continue
    msg = row.get("message")
    if not isinstance(msg, str):
        continue
    try:
        payload = json.loads(msg)
    except Exception:
        continue
    if not isinstance(payload, dict):
        continue
    ui_perf_entries.append((row.get("id"), payload))

# Index the LAST preload_bootstrap_sync — that one belongs to the measure-phase
# launch (the seed launch emitted an earlier one against an empty DB).
bootstrap_idx = None
bootstrap_payload = None
for i, (_, payload) in enumerate(ui_perf_entries):
    if payload.get("metric") == "preload_bootstrap_sync":
        bootstrap_idx = i
        bootstrap_payload = payload

post_bootstrap = []
if bootstrap_idx is not None:
    post_bootstrap = [p for _, p in ui_perf_entries[bootstrap_idx + 1 :]]

snapshot_replaces = [p for p in post_bootstrap if p.get("metric") == "useTasks_snapshot_replace"]
non_forced_replaces = [p for p in snapshot_replaces if not p.get("forceRefresh")]
forced_replaces = [p for p in snapshot_replaces if p.get("forceRefresh")]

# Pick the first non-forced (the redundant mount-time request); fall back to
# the first forced replace so the report still shows real numbers when the
# bug is fixed and the renderer only issues an explicit forced refresh.
first_replace = non_forced_replaces[0] if non_forced_replaces else (forced_replaces[0] if forced_replaces else None)

graph_visible = None
for p in post_bootstrap:
    if p.get("metric") == "startup_workflow_graph_visible":
        graph_visible = p
        break

print("repro-summary:")
print(f"  seeded.workflowCount: {seeded_workflow_count}")
print(f"  seeded.taskCount: {seeded_task_count}")
print(f"  graphWaitElapsedMs (driver-observed): {graph_wait_ms}")
print(f"  postGraphSettleMs: {post_settle_ms}")
if bootstrap_payload is not None:
    print("  preload_bootstrap_sync:")
    print(f"    taskCount: {bootstrap_payload.get('taskCount')}")
    print(f"    workflowCount: {bootstrap_payload.get('workflowCount')}")
    print(f"    jsonSizeBytes: {bootstrap_payload.get('jsonSizeBytes')}")
    print(f"    durationMs: {bootstrap_payload.get('durationMs')}")
else:
    print("  preload_bootstrap_sync: NOT FOUND (driver may have closed before metric flushed)")

if first_replace is not None:
    print("  useTasks_snapshot_replace (first post-bootstrap):")
    print(f"    forceRefresh: {first_replace.get('forceRefresh')}")
    print(f"    requestDurationMs: {first_replace.get('requestDurationMs')}")
    print(f"    replaceDurationMs: {first_replace.get('replaceDurationMs')}")
    print(f"    taskCount: {first_replace.get('taskCount')}")
    print(f"    workflowCount: {first_replace.get('workflowCount')}")
    print(f"    jsonSizeBytes: {first_replace.get('jsonSizeBytes')}")
else:
    print("  useTasks_snapshot_replace: NONE observed after preload_bootstrap_sync")

print(f"  post-bootstrap snapshot_replace counts: total={len(snapshot_replaces)} "
      f"non_forced={len(non_forced_replaces)} forced={len(forced_replaces)}")

if graph_visible is not None:
    print("  startup_workflow_graph_visible:")
    print(f"    elapsedMs: {graph_visible.get('elapsedMs')}")
    print(f"    processElapsedMs: {graph_visible.get('processElapsedMs')}")
    print(f"    nodeCount: {graph_visible.get('nodeCount')}")
    print(f"    edgeCount: {graph_visible.get('edgeCount')}")
else:
    print("  startup_workflow_graph_visible: NOT FOUND in post-bootstrap entries")

redundant_observed = len(non_forced_replaces) > 0

if expect_issue:
    if redundant_observed:
        print("repro: PASS (--expect-issue confirmed redundant non-forced startup snapshot)")
        sys.exit(0)
    print(
        "repro: FAIL (--expect-issue expected a non-forced useTasks_snapshot_replace "
        "after preload_bootstrap_sync but none was observed)",
        file=sys.stderr,
    )
    sys.exit(1)

if not redundant_observed:
    print("repro: PASS (no redundant non-forced startup snapshot observed)")
    sys.exit(0)
print(
    "repro: FAIL (redundant non-forced useTasks_snapshot_replace still observed "
    "after preload_bootstrap_sync)",
    file=sys.stderr,
)
sys.exit(1)
PY
