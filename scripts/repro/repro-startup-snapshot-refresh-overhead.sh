#!/usr/bin/env bash
# Repro: redundant post-bootstrap startup snapshot request.
#
# The renderer's useTasks hook re-fetches the full snapshot via
# window.invoker.getTasks() right after the preload bootstrap has already
# populated tasks/workflows. The redundant request fires with
# forceRefresh=false and arrives in `activity_log` as a `useTasks_snapshot_replace`
# `ui-perf` entry strictly after `preload_bootstrap_sync` for the same renderer
# session. Production data shows it costs ~65–164ms and ~377KB after the
# graph is already visible.
#
# This script drives an isolated startup fixture, captures `ui-perf` and
# `activity_log` events from the live Electron renderer, and asserts on the
# presence (or absence) of the redundant non-forced snapshot.
#
# Modes:
#   --expect-issue
#     Exit 0 when the redundant non-forced `useTasks_snapshot_replace`
#     after `preload_bootstrap_sync` is observed (current baseline).
#   (default, no flag)
#     Exit 0 only when no such redundant non-forced snapshot is observed
#     (post-optimization).
#
# Optional env / flags:
#   --workflow-count N        (default 4)
#   --tasks-per-workflow N    (default 8)
#   --keep-tmp                Keep the temp INVOKER_DB_DIR and driver script
#   --skip-build              Skip the auto-build step
#
# Exits with code 0 on the expected outcome, 1 on the unexpected outcome,
# and 2 on infrastructure / setup failure.

set -euo pipefail

EXPECT_ISSUE=0
WORKFLOW_COUNT="${WORKFLOW_COUNT:-4}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-8}"
KEEP_TMP=0
SKIP_BUILD=0

usage() {
  sed -n '2,30p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflow-count) WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 64 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REMOTE_REPO="$TMP_DIR/remote.git"
CONFIG_PATH="$TMP_DIR/config.json"
RESULT_JSON="$TMP_DIR/activity-logs.json"
DRIVER_PATH="$TMP_DIR/driver.cjs"
DRIVER_LOG="$TMP_DIR/driver.log"

cleanup() {
  if [[ "$KEEP_TMP" -eq 0 ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "repro: kept temp dir at $TMP_DIR" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  if [[ ! -f packages/ui/dist/index.html ]]; then
    pnpm --filter @invoker/ui build >&2
  fi
  if [[ ! -f packages/surfaces/dist/index.js ]]; then
    pnpm --filter @invoker/surfaces build >&2
  fi
  if [[ ! -f packages/app/dist/main.js || ! -f packages/app/dist/headless-client.js ]]; then
    pnpm --filter @invoker/app build >&2
  fi
fi

if [[ ! -f packages/app/dist/main.js ]]; then
  echo "repro: missing packages/app/dist/main.js (run with build, or pnpm --filter @invoker/app build)" >&2
  exit 2
fi

if [[ ! -d packages/app/node_modules/@playwright/test ]]; then
  echo "repro: missing @playwright/test under packages/app/node_modules (run pnpm install)" >&2
  exit 2
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1
SEED_CLONE="$TMP_DIR/seed-clone"
git clone -q "$REMOTE_REPO" "$SEED_CLONE"
git -C "$SEED_CLONE" -c user.email=repro@invoker.dev -c user.name="Invoker Repro" \
  commit --allow-empty -q -m "init"
git -C "$SEED_CLONE" push -q origin HEAD:refs/heads/master
git -C "$SEED_CLONE" push -q origin HEAD:refs/heads/main
rm -rf "$SEED_CLONE"

cat > "$CONFIG_PATH" <<EOF
{"autoFixRetries":0,"maxConcurrency":1,"disableAutoRunOnStartup":true}
EOF

COMMON_ENV=(
  HOME="$HOME_DIR"
  INVOKER_DB_DIR="$DB_DIR"
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
  INVOKER_HEADLESS_STANDALONE=1
)
export HOME="$HOME_DIR"
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"

echo "repro: seeding $WORKFLOW_COUNT workflow(s) x $TASKS_PER_WORKFLOW task(s) into $DB_DIR" >&2
for i in $(seq 1 "$WORKFLOW_COUNT"); do
  PLAN="$TMP_DIR/plan-$i.yaml"
  {
    echo "name: startup-snapshot-repro-$i"
    echo "onFinish: none"
    echo "repoUrl: file://$REMOTE_REPO"
    echo "tasks:"
    for j in $(seq 1 "$TASKS_PER_WORKFLOW"); do
      echo "  - id: t$j"
      echo "    description: \"task $i/$j\""
      echo "    command: \"echo task-$i-$j\""
      if [[ "$j" -gt 1 ]]; then
        echo "    dependencies:"
        echo "      - t$((j - 1))"
      fi
    done
  } > "$PLAN"

  env "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$PLAN" \
    >"$TMP_DIR/seed-$i.stdout.log" 2>"$TMP_DIR/seed-$i.stderr.log" \
    || {
      echo "repro: seed run $i failed" >&2
      tail -n 40 "$TMP_DIR/seed-$i.stderr.log" >&2 || true
      exit 2
    }
done

# Pause briefly so the seed processes finish flushing their final DB writes.
sleep 1

cat > "$DRIVER_PATH" <<'NODE_EOF'
'use strict';
const fs = require('node:fs');
const { _electron } = require('@playwright/test');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i]] = argv[i + 1];
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { '--db': dbDir, '--config': configPath, '--out': outPath, '--main': mainJs } = args;
  if (!dbDir || !configPath || !outPath || !mainJs) {
    console.error('driver: missing required arg (--db, --config, --out, --main)');
    process.exit(2);
  }

  const launchArgs = [];
  if (process.platform === 'linux') {
    launchArgs.push(
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer',
    );
  }
  launchArgs.push(mainJs);

  const app = await _electron.launch({
    args: launchArgs,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: dbDir,
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_ALLOW_DELETE_ALL: '1',
    },
    timeout: 60_000,
  });

  try {
    const page = await app.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15_000 });
    await page
      .locator('[data-testid^="workflow-node-"]')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    // Allow the post-bootstrap useTasks fetch + ui-perf write to settle.
    await page.waitForTimeout(2000);
    const logs = await page.evaluate(() => window.invoker.getActivityLogs());
    fs.writeFileSync(outPath, JSON.stringify(logs));
  } finally {
    await app.close().catch(() => undefined);
  }
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(2);
});
NODE_EOF

LAUNCHER=()
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "repro: GUI driver requires xvfb-run on headless Linux. Install xvfb or set DISPLAY." >&2
    exit 2
  fi
  LAUNCHER=(xvfb-run --auto-servernum)
fi

NODE_BIN="${NODE:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
  echo "repro: node not found in PATH" >&2
  exit 2
fi

echo "repro: launching Electron via Playwright driver" >&2
set +e
env "${COMMON_ENV[@]}" \
  NODE_PATH="$ROOT_DIR/packages/app/node_modules:$ROOT_DIR/node_modules" \
  "${LAUNCHER[@]}" \
  "$NODE_BIN" "$DRIVER_PATH" \
    --db "$DB_DIR" \
    --config "$CONFIG_PATH" \
    --out "$RESULT_JSON" \
    --main "$ROOT_DIR/packages/app/dist/main.js" \
  >"$DRIVER_LOG" 2>&1
DRIVER_EXIT=$?
set -e

if [[ "$DRIVER_EXIT" -ne 0 || ! -s "$RESULT_JSON" ]]; then
  echo "repro: driver failed (exit=$DRIVER_EXIT). Tail of driver log:" >&2
  tail -n 80 "$DRIVER_LOG" >&2 || true
  exit 2
fi

popd >/dev/null

python3 - "$RESULT_JSON" "$EXPECT_ISSUE" <<'PY'
import json
import sys

result_path, expect_issue_arg = sys.argv[1], sys.argv[2]
expect_issue = expect_issue_arg == "1"

with open(result_path, "r", encoding="utf-8") as f:
    entries = json.load(f)

ui_perf = []
for entry in entries:
    if entry.get("source") != "ui-perf":
        continue
    raw = entry.get("message", "{}")
    try:
        payload = json.loads(raw)
    except Exception:
        continue
    payload["_log_id"] = entry.get("id")
    payload["_log_ts"] = entry.get("timestamp")
    ui_perf.append(payload)

ui_perf.sort(key=lambda p: p.get("_log_id") or 0)

bootstrap = next((p for p in ui_perf if p.get("metric") == "preload_bootstrap_sync"), None)
snapshots = [p for p in ui_perf if p.get("metric") == "useTasks_snapshot_replace"]
graph_visible = next((p for p in ui_perf if p.get("metric") == "startup_workflow_graph_visible"), None)

if bootstrap is None:
    print("repro: missing preload_bootstrap_sync ui-perf entry — driver did not capture renderer bootstrap")
    sys.exit(2)

post_bootstrap = [s for s in snapshots if (s.get("_log_id") or 0) > (bootstrap.get("_log_id") or 0)]
non_forced_post = [s for s in post_bootstrap if not s.get("forceRefresh")]
first_snapshot = post_bootstrap[0] if post_bootstrap else (snapshots[0] if snapshots else None)

def fmt(value):
    return "N/A" if value is None else value

print("repro-summary:")
print(f"  bootstrap.taskCount: {fmt(bootstrap.get('taskCount'))}")
print(f"  bootstrap.workflowCount: {fmt(bootstrap.get('workflowCount'))}")
print(f"  bootstrap.jsonSizeBytes: {fmt(bootstrap.get('jsonSizeBytes'))}")
if first_snapshot is not None:
    print(f"  useTasks_snapshot_replace.requestDurationMs: {fmt(first_snapshot.get('requestDurationMs'))}")
    print(f"  useTasks_snapshot_replace.replaceDurationMs: {fmt(first_snapshot.get('replaceDurationMs'))}")
    print(f"  useTasks_snapshot_replace.jsonSizeBytes: {fmt(first_snapshot.get('jsonSizeBytes'))}")
    print(f"  useTasks_snapshot_replace.forceRefresh: {bool(first_snapshot.get('forceRefresh'))}")
else:
    print("  useTasks_snapshot_replace.requestDurationMs: N/A")
    print("  useTasks_snapshot_replace.replaceDurationMs: N/A")
    print("  useTasks_snapshot_replace.jsonSizeBytes: N/A")
    print("  useTasks_snapshot_replace.forceRefresh: N/A")
if graph_visible is not None:
    print(f"  startup_workflow_graph_visible.processElapsedMs: {fmt(graph_visible.get('processElapsedMs'))}")
    print(f"  startup_workflow_graph_visible.elapsedMs: {fmt(graph_visible.get('elapsedMs'))}")
    print(f"  startup_workflow_graph_visible.nodeCount: {fmt(graph_visible.get('nodeCount'))}")
    print(f"  startup_workflow_graph_visible.edgeCount: {fmt(graph_visible.get('edgeCount'))}")
else:
    print("  startup_workflow_graph_visible: N/A")
print(f"  post_bootstrap_snapshot_count: {len(post_bootstrap)}")
print(f"  post_bootstrap_non_forced_snapshot_count: {len(non_forced_post)}")

if expect_issue:
    if non_forced_post:
        print("repro: PASS (--expect-issue: observed redundant non-forced startup snapshot after preload_bootstrap_sync)")
        sys.exit(0)
    print("repro: FAIL (--expect-issue: did NOT observe redundant non-forced startup snapshot — bug appears already fixed)")
    sys.exit(1)

if not non_forced_post:
    print("repro: PASS (no redundant non-forced startup snapshot after preload_bootstrap_sync)")
    sys.exit(0)
print("repro: FAIL (still observing redundant non-forced startup snapshot after preload_bootstrap_sync)")
for snap in non_forced_post:
    print(
        f"  - id={snap.get('_log_id')} ts={snap.get('_log_ts')} "
        f"taskCount={snap.get('taskCount')} workflowCount={snap.get('workflowCount')} "
        f"requestDurationMs={snap.get('requestDurationMs')} "
        f"replaceDurationMs={snap.get('replaceDurationMs')} "
        f"jsonSizeBytes={snap.get('jsonSizeBytes')}"
    )
sys.exit(1)
PY
