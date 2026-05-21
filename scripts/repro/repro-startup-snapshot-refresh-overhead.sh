#!/usr/bin/env bash
set -euo pipefail

# Deterministic reproduction for the redundant post-bootstrap startup snapshot
# request. Seeds an isolated INVOKER_DB_DIR with several workflows, then drives
# Electron via Playwright's `_electron.launch` to relaunch the app fresh and
# capture preload + renderer perf signals from the activity_log.
#
# Without flags: passes when no non-forced useTasks_snapshot_replace fires
# after preload_bootstrap_sync (the expected post-optimization state).
# With --expect-issue: passes when such a redundant snapshot IS observed (the
# current baseline). This lets the same script confirm the regression today and
# the fix tomorrow without editing.
#
# Output JSON is also written to STDOUT for downstream tooling. Re-runnable in
# CI: relies only on the workspace's playwright + electron toolchain.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WORKFLOW_COUNT="${WORKFLOW_COUNT:-12}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-6}"
LAUNCH_TIMEOUT_MS="${LAUNCH_TIMEOUT_MS:-60000}"
POST_VISIBLE_SETTLE_MS="${POST_VISIBLE_SETTLE_MS:-3000}"
EXPECT_ISSUE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue)
      EXPECT_ISSUE=1
      shift
      ;;
    --workflow-count)
      WORKFLOW_COUNT="$2"
      shift 2
      ;;
    --tasks-per-workflow)
      TASKS_PER_WORKFLOW="$2"
      shift 2
      ;;
    -h|--help)
      cat <<USAGE
Usage: $0 [--expect-issue] [--workflow-count N] [--tasks-per-workflow N]

  --expect-issue          Exit 0 only when a redundant non-forced
                          useTasks_snapshot_replace is observed after
                          preload_bootstrap_sync (current baseline).
  --workflow-count N      Number of workflows to seed (default 12).
  --tasks-per-workflow N  Tasks per workflow (default 6).

Environment overrides: WORKFLOW_COUNT, TASKS_PER_WORKFLOW,
LAUNCH_TIMEOUT_MS, POST_VISIBLE_SETTLE_MS, INVOKER_REPRO_KEEP_TMP=1 to retain
the temp dir for inspection.
USAGE
      exit 0
      ;;
    *)
      echo "repro: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

TMP_DIR="$(mktemp -d -t invoker-repro-startup-snapshot.XXXXXX)"
cleanup() {
  if [[ "${INVOKER_REPRO_KEEP_TMP:-0}" != "1" ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "repro: keeping tmp dir at $TMP_DIR" >&2
  fi
}
trap cleanup EXIT

DB_DIR="$TMP_DIR/db"
REMOTE_REPO="$TMP_DIR/remote.git"
CLONE_DIR="$TMP_DIR/remote-clone"
CONFIG_PATH="$TMP_DIR/repo-config.json"
DRIVER_PATH="$TMP_DIR/driver.cjs"
DRIVER_CONFIG="$TMP_DIR/driver-config.json"
RESULT_PATH="$TMP_DIR/result.json"
DRIVER_LOG="$TMP_DIR/driver.log"

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

# Build whichever artifacts are missing so the script works on a clean tree.
if [[ ! -f packages/ui/dist/index.html ]]; then
  echo "repro: building @invoker/ui..." >&2
  pnpm --filter @invoker/ui build >&2
fi
if [[ ! -f packages/surfaces/dist/index.js ]]; then
  echo "repro: building @invoker/surfaces..." >&2
  pnpm --filter @invoker/surfaces build >&2
fi
if [[ ! -f packages/app/dist/main.js ]]; then
  echo "repro: building @invoker/app..." >&2
  pnpm --filter @invoker/app build >&2
fi

# Disable AutoRun so seeded plans never actually fire shell commands.
cat > "$CONFIG_PATH" <<'EOF'
{ "autoFixRetries": 0, "disableAutoRunOnStartup": true }
EOF

# Local bare repo so loadPlan does not need network access.
git init --bare "$REMOTE_REPO" >/dev/null
git clone "$REMOTE_REPO" "$CLONE_DIR" >/dev/null 2>&1
(
  cd "$CLONE_DIR"
  git -c user.name=repro -c user.email=repro@invoker.local commit --allow-empty -m init >/dev/null
  git push origin HEAD:refs/heads/master >/dev/null 2>&1
  git push origin HEAD:refs/heads/main >/dev/null 2>&1
)
rm -rf "$CLONE_DIR"

REPO_URL="file://$REMOTE_REPO"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"

cat > "$DRIVER_CONFIG" <<JSON
{
  "mainJs": "$MAIN_JS",
  "dbDir": "$DB_DIR",
  "configPath": "$CONFIG_PATH",
  "repoUrl": "$REPO_URL",
  "workflowCount": $WORKFLOW_COUNT,
  "tasksPerWorkflow": $TASKS_PER_WORKFLOW,
  "launchTimeoutMs": $LAUNCH_TIMEOUT_MS,
  "postVisibleSettleMs": $POST_VISIBLE_SETTLE_MS,
  "resultPath": "$RESULT_PATH"
}
JSON

cat > "$DRIVER_PATH" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const playwrightTestPath = process.env.INVOKER_REPRO_PLAYWRIGHT_PATH;
if (!playwrightTestPath) {
  throw new Error('driver: INVOKER_REPRO_PLAYWRIGHT_PATH not set');
}
// eslint-disable-next-line import/no-dynamic-require
const { _electron } = require(playwrightTestPath);

function buildPlanYaml(idx, tasksPerWorkflow, repoUrl) {
  const tasks = [];
  for (let t = 0; t < tasksPerWorkflow; t += 1) {
    const deps = t === 0 ? '' : `    dependencies: [task-${idx}-${t - 1}]\n`;
    tasks.push(
      `  - id: task-${idx}-${t}\n` +
        `    description: Repro task ${idx}-${t}\n` +
        `    command: ${'"true"'}\n` +
        deps,
    );
  }
  return (
    `name: startup-snapshot-repro-${idx}\n` +
    `repoUrl: ${repoUrl}\n` +
    `onFinish: none\n` +
    `tasks:\n` +
    tasks.join('')
  );
}

function launchArgs(mainJs) {
  const platformArgs =
    process.platform === 'linux'
      ? [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-gpu-compositing',
          '--disable-gpu-sandbox',
          '--disable-software-rasterizer',
        ]
      : [];
  return [...platformArgs, mainJs];
}

function envFor(cfg) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    INVOKER_DB_DIR: cfg.dbDir,
    INVOKER_REPO_CONFIG_PATH: cfg.configPath,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    INVOKER_STARTUP_POLL_DELAY_MS: '0',
  };
}

async function waitForInvoker(page, timeoutMs) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(
    () => typeof window.invoker !== 'undefined' && typeof window.invoker.getTasks === 'function',
    null,
    { timeout: timeoutMs },
  );
}

async function seedDatabase(cfg) {
  const app = await _electron.launch({
    args: launchArgs(cfg.mainJs),
    env: envFor(cfg),
    timeout: cfg.launchTimeoutMs,
  });
  try {
    const page = await app.firstWindow({ timeout: cfg.launchTimeoutMs });
    await waitForInvoker(page, cfg.launchTimeoutMs);

    await page.evaluate(async () => {
      if (window.invoker.deleteAllWorkflows) {
        await window.invoker.deleteAllWorkflows();
      }
    });

    for (let i = 0; i < cfg.workflowCount; i += 1) {
      const yaml = buildPlanYaml(i, cfg.tasksPerWorkflow, cfg.repoUrl);
      await page.evaluate((y) => window.invoker.loadPlan(y), yaml);
    }

    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    // Each plan may add a synthesized merge node, so we don't assert an
    // exact count — just that every plan produced tasks.
    if (seededTasks.length < cfg.workflowCount * cfg.tasksPerWorkflow) {
      throw new Error(
        `Seed mismatch: expected >= ${cfg.workflowCount * cfg.tasksPerWorkflow} tasks, got ${seededTasks.length}`,
      );
    }
  } finally {
    await app.close();
  }
}

async function captureStartup(cfg) {
  const app = await _electron.launch({
    args: launchArgs(cfg.mainJs),
    env: envFor(cfg),
    timeout: cfg.launchTimeoutMs,
  });
  try {
    const page = await app.firstWindow({ timeout: cfg.launchTimeoutMs });
    await waitForInvoker(page, cfg.launchTimeoutMs);

    await page
      .locator('[data-testid^="workflow-node-"]')
      .first()
      .waitFor({ state: 'visible', timeout: cfg.launchTimeoutMs });

    // Give the renderer a window to issue any post-bootstrap getTasks refresh
    // and have the IPC handler persist the resulting ui-perf activity_log row.
    await page.waitForTimeout(cfg.postVisibleSettleMs);

    const captured = await page.evaluate(async () => {
      const perf = await window.invoker.getUiPerfStats();
      const activityLogs = await window.invoker.getActivityLogs();
      const tasksResult = await window.invoker.getTasks();
      const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
      return { perf, activityLogs, finalTaskCount: tasks.length };
    });
    return captured;
  } finally {
    await app.close();
  }
}

async function main() {
  const cfgPath = process.argv[2];
  if (!cfgPath) throw new Error('driver: missing config path argument');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

  await seedDatabase(cfg);
  const result = await captureStartup(cfg);

  fs.writeFileSync(cfg.resultPath, JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('driver: failed', err && err.stack ? err.stack : err);
  process.exit(1);
});
NODE

# Resolve @playwright/test against packages/app's dep graph so the driver can
# require it from /tmp without relying on shell cwd / NODE_PATH hacks.
PLAYWRIGHT_PATH="$(cd "$ROOT_DIR/packages/app" && node -p "require.resolve('@playwright/test')")"
if [[ -z "$PLAYWRIGHT_PATH" ]]; then
  echo "repro: failed to resolve @playwright/test path" >&2
  exit 1
fi
export INVOKER_REPRO_PLAYWRIGHT_PATH="$PLAYWRIGHT_PATH"

RUN_CMD=(node "$DRIVER_PATH" "$DRIVER_CONFIG")
if [[ "$(uname -s)" == "Linux" ]] && command -v xvfb-run >/dev/null 2>&1; then
  RUN_CMD=(xvfb-run --auto-servernum node "$DRIVER_PATH" "$DRIVER_CONFIG")
fi

echo "repro: launching seed + repro Electron sessions (workflows=$WORKFLOW_COUNT, tasks/workflow=$TASKS_PER_WORKFLOW)..." >&2
(
  cd "$ROOT_DIR/packages/app"
  "${RUN_CMD[@]}"
) >"$DRIVER_LOG" 2>&1 || {
  echo "repro: driver failed; see $DRIVER_LOG" >&2
  tail -n 80 "$DRIVER_LOG" >&2 || true
  exit 1
}

if [[ ! -s "$RESULT_PATH" ]]; then
  echo "repro: driver produced no result JSON; see $DRIVER_LOG" >&2
  tail -n 80 "$DRIVER_LOG" >&2 || true
  exit 1
fi

popd >/dev/null

EXPECT_ISSUE="$EXPECT_ISSUE" python3 - "$RESULT_PATH" <<'PY'
import json
import os
import sys

result_path = sys.argv[1]
expect_issue = os.environ.get("EXPECT_ISSUE", "0") == "1"

with open(result_path, "r", encoding="utf-8") as f:
    data = json.load(f)

activity_logs = data.get("activityLogs", [])


def parse_payload(entry):
    msg = entry.get("message", "")
    try:
        return json.loads(msg)
    except Exception:
        return None


ui_perf_events = []
for entry in activity_logs:
    if entry.get("source") != "ui-perf":
        continue
    payload = parse_payload(entry)
    if payload is None:
        continue
    ui_perf_events.append((entry.get("id", 0), entry.get("timestamp", ""), payload))

ui_perf_events.sort(key=lambda row: row[0])

bootstrap = None
bootstrap_index = -1
# Both the seed-phase launch and the repro-phase launch fire
# preload_bootstrap_sync. The repro one is always the LAST occurrence in
# id-order because the seed launch closes before the repro launch starts.
for idx, (_id, _ts, payload) in enumerate(ui_perf_events):
    if payload.get("metric") == "preload_bootstrap_sync":
        bootstrap = payload
        bootstrap_index = idx

graph_visible = None
# Same reasoning: prefer the repro launch's graph_visible event (the last one).
for _id, _ts, payload in ui_perf_events:
    if payload.get("metric") == "startup_workflow_graph_visible":
        graph_visible = payload

snapshot_replaces_after_bootstrap = []
for idx, (_id, _ts, payload) in enumerate(ui_perf_events):
    if payload.get("metric") != "useTasks_snapshot_replace":
        continue
    if bootstrap_index >= 0 and idx <= bootstrap_index:
        continue
    snapshot_replaces_after_bootstrap.append(payload)

non_forced_redundant = [
    payload for payload in snapshot_replaces_after_bootstrap if not payload.get("forceRefresh", False)
]

primary_snapshot = (
    non_forced_redundant[0]
    if non_forced_redundant
    else (snapshot_replaces_after_bootstrap[0] if snapshot_replaces_after_bootstrap else None)
)


def fmt(value):
    if value is None:
        return "<missing>"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)


print("repro-startup-snapshot-refresh-overhead:")
print("  bootstrap:")
print(f"    taskCount: {fmt(bootstrap.get('taskCount') if bootstrap else None)}")
print(f"    workflowCount: {fmt(bootstrap.get('workflowCount') if bootstrap else None)}")
print(f"    jsonSizeBytes: {fmt(bootstrap.get('jsonSizeBytes') if bootstrap else None)}")
print(f"    durationMs: {fmt(bootstrap.get('durationMs') if bootstrap else None)}")
print("  useTasks_snapshot_replace (first after bootstrap):")
if primary_snapshot is not None:
    print(f"    forceRefresh: {fmt(primary_snapshot.get('forceRefresh'))}")
    print(f"    taskCount: {fmt(primary_snapshot.get('taskCount'))}")
    print(f"    workflowCount: {fmt(primary_snapshot.get('workflowCount'))}")
    print(f"    requestDurationMs: {fmt(primary_snapshot.get('requestDurationMs'))}")
    print(f"    replaceDurationMs: {fmt(primary_snapshot.get('replaceDurationMs'))}")
    print(f"    jsonSizeBytes: {fmt(primary_snapshot.get('jsonSizeBytes'))}")
else:
    print("    <no useTasks_snapshot_replace observed after preload_bootstrap_sync>")
print("  graphVisible:")
if graph_visible is not None:
    print(f"    nodeCount: {fmt(graph_visible.get('nodeCount'))}")
    print(f"    edgeCount: {fmt(graph_visible.get('edgeCount'))}")
    print(f"    elapsedMs: {fmt(graph_visible.get('elapsedMs'))}")
    print(f"    processElapsedMs: {fmt(graph_visible.get('processElapsedMs'))}")
else:
    print("    <startup_workflow_graph_visible not observed>")
print(f"  snapshotReplacesAfterBootstrap: {len(snapshot_replaces_after_bootstrap)}")
print(f"  redundantNonForcedAfterBootstrap: {len(non_forced_redundant)}")
print(f"  expectIssue: {'1' if expect_issue else '0'}")

if expect_issue:
    if len(non_forced_redundant) == 0:
        print("repro: FAIL (expected redundant non-forced snapshot after bootstrap; none observed)")
        sys.exit(1)
    print("repro: PASS (redundant non-forced snapshot reproduced)")
    sys.exit(0)
else:
    if len(non_forced_redundant) > 0:
        print("repro: FAIL (redundant non-forced snapshot still firing after bootstrap)")
        sys.exit(1)
    print("repro: PASS (no redundant non-forced snapshot after bootstrap)")
    sys.exit(0)
PY
