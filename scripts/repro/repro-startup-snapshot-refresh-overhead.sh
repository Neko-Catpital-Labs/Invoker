#!/usr/bin/env bash
# Repro for the redundant post-bootstrap startup snapshot.
#
# Production data shows that after `preload_bootstrap_sync` returns a full
# bootstrap payload (tasks + workflows already on `window.__INVOKER_BOOTSTRAP__`),
# useTasks.ts unconditionally calls `getTasks(false)` on mount, producing a
# second full `getTasks` snapshot of ~65-164ms request and ~377KB on the wire
# AFTER the graph is already visible.
#
# This script reproduces that overhead deterministically against an isolated
# Electron + SQLite startup fixture seeded with many workflows × tasks, and
# extracts the relevant `ui-perf` activity-log entries.
#
# Usage:
#   ./scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue] [--keep-tmp]
#
# Flags:
#   --expect-issue   Exit 0 on the current (buggy) baseline: i.e. when a
#                    non-forced useTasks_snapshot_replace lands AFTER
#                    preload_bootstrap_sync. Useful as a regression gate that
#                    asserts the bug is reproducible.
#   --keep-tmp       Keep the per-run temp dir (DB + driver) for inspection.
#
# Without --expect-issue, the script exits 0 ONLY when no redundant
# non-forced startup snapshot is observed — that is the expected behavior
# after the optimization lands.
#
# Environment overrides:
#   INVOKER_REPRO_WORKFLOWS              workflows seeded into the fixture DB (default 30)
#   INVOKER_REPRO_TASKS_PER_WORKFLOW     tasks per seeded workflow            (default 8)
#   INVOKER_E2E_BARE_REPO                bare repo used as plan.repoUrl       (default /tmp/invoker-e2e-repo.git)

set -euo pipefail

EXPECT_ISSUE=0
KEEP_TMP=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    --keep-tmp) KEEP_TMP=1 ;;
    --help|-h)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *)
      echo "[repro] Unknown arg: $arg (try --help)" >&2
      exit 64
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAIN_JS="$REPO_ROOT/packages/app/dist/main.js"
WORKFLOW_COUNT="${INVOKER_REPRO_WORKFLOWS:-30}"
TASKS_PER_WORKFLOW="${INVOKER_REPRO_TASKS_PER_WORKFLOW:-8}"
BARE_REPO="${INVOKER_E2E_BARE_REPO:-/tmp/invoker-e2e-repo.git}"

command -v node >/dev/null || { echo "[repro] node required" >&2; exit 2; }
command -v python3 >/dev/null || { echo "[repro] python3 required for result formatting" >&2; exit 2; }

if [[ ! -f "$MAIN_JS" ]]; then
  echo "[repro] building @invoker/app (dist/main.js missing)..." >&2
  ( cd "$REPO_ROOT" && pnpm --filter @invoker/ui build && pnpm --filter @invoker/surfaces build && pnpm --filter @invoker/app build ) >&2
fi

# Ensure the bare repo used by E2E plans exists; loadPlan accepts the URL but
# doesn't clone, so an empty bare init is enough.
if [[ ! -d "$BARE_REPO" ]]; then
  echo "[repro] creating bare repo at $BARE_REPO" >&2
  TMP_CLONE="$BARE_REPO.setup"
  rm -rf "$TMP_CLONE"
  git init --bare "$BARE_REPO" >/dev/null
  GIT_AUTHOR_NAME="Invoker Repro" GIT_AUTHOR_EMAIL="repro@invoker.dev" \
  GIT_COMMITTER_NAME="Invoker Repro" GIT_COMMITTER_EMAIL="repro@invoker.dev" \
  bash -c '
    set -e
    git clone "$1" "$2" >/dev/null 2>&1
    cd "$2"
    git commit --allow-empty -m init >/dev/null
    git push origin HEAD:refs/heads/master >/dev/null 2>&1
    git push origin HEAD:refs/heads/main >/dev/null 2>&1
  ' _ "$BARE_REPO" "$TMP_CLONE"
  rm -rf "$TMP_CLONE"
fi

TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-repro-XXXXXX)"
DRIVER_SCRIPT="$TMP_DIR/driver.cjs"
RESULTS_JSON="$TMP_DIR/results.json"

cleanup() {
  if [[ "$KEEP_TMP" -eq 1 ]]; then
    echo "[repro] artifacts kept at $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cat > "$DRIVER_SCRIPT" <<'NODE_EOF'
"use strict";
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = process.env.INVOKER_REPO_ROOT;
const DB_DIR = process.env.INVOKER_DB_DIR;
const WORKFLOW_COUNT = Number(process.env.INVOKER_REPRO_WORKFLOWS);
const TASKS_PER_WORKFLOW = Number(process.env.INVOKER_REPRO_TASKS_PER_WORKFLOW);
const RESULTS_OUT = process.env.INVOKER_REPRO_RESULTS_OUT;
const BARE_REPO = process.env.INVOKER_E2E_BARE_REPO;

const APP_NODE_MODULES = path.join(REPO_ROOT, "packages", "app", "node_modules");
const { _electron: electron } = require(path.join(APP_NODE_MODULES, "@playwright/test"));
const { stringify: yamlStringify } = require(path.join(APP_NODE_MODULES, "yaml"));

const MAIN_JS = path.join(REPO_ROOT, "packages", "app", "dist", "main.js");
const REPO_URL = "file://" + BARE_REPO;
const CONFIG_PATH = path.join(DB_DIR, "config.json");
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }),
);

function launchArgs() {
  const linux = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-gpu-compositing",
    "--disable-gpu-sandbox",
    "--disable-software-rasterizer",
  ];
  return [...(process.platform === "linux" ? linux : []), MAIN_JS];
}

function launchEnv() {
  return {
    ...process.env,
    NODE_ENV: "test",
    INVOKER_DB_DIR: DB_DIR,
    INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
    INVOKER_ALLOW_DELETE_ALL: "1",
  };
}

function buildPlan(index) {
  return {
    name: "Snapshot Refresh Repro " + index,
    repoUrl: REPO_URL,
    onFinish: "none",
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, function (_, i) {
      return {
        id: "task-" + index + "-" + i,
        description: "Task " + index + "-" + i,
        command: "echo task-" + index + "-" + i,
        dependencies: i === 0 ? [] : ["task-" + index + "-" + (i - 1)],
      };
    }),
  };
}

function parseActivityPayload(message) {
  try { return JSON.parse(message); } catch { return null; }
}

async function seed() {
  const app = await electron.launch({ args: launchArgs(), env: launchEnv() });
  let maxId = 0;
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      function () { return typeof window.invoker !== "undefined"; },
      null,
      { timeout: 30000 },
    );

    for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
      const yaml = yamlStringify(buildPlan(i));
      await page.evaluate(function (y) { return window.invoker.loadPlan(y); }, yaml);
    }

    const seeded = await page.evaluate(function () { return window.invoker.getTasks(true); });
    const tasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    const expected = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;
    if (tasks.length !== expected) {
      throw new Error("seed: expected " + expected + " tasks, got " + tasks.length);
    }

    const logs = await page.evaluate(function () { return window.invoker.getActivityLogs(); });
    for (const e of logs) {
      if (typeof e.id === "number" && e.id > maxId) maxId = e.id;
    }
  } finally {
    await app.close();
  }
  return maxId;
}

async function measure(seedMaxId) {
  const startedAt = Date.now();
  const app = await electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      function () { return typeof window.invoker !== "undefined"; },
      null,
      { timeout: 30000 },
    );

    // Wait until the workflow graph DOM is visible — the "post-bootstrap"
    // window we care about begins here.
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: "visible",
      timeout: 30000,
    });

    // Wait for any post-bootstrap useTasks_snapshot_replace to land. We poll
    // the persisted activity log so we observe the same event the production
    // perf data was captured from. If the optimization is present, no such
    // event will land — give it a generous quiesce window before giving up.
    const quiesceDeadline = Date.now() + 10000;
    while (Date.now() < quiesceDeadline) {
      const logs = await page.evaluate(function () { return window.invoker.getActivityLogs(); });
      const sawReplace = logs.some(function (e) {
        if (e.source !== "ui-perf" || (typeof e.id === "number" && e.id <= seedMaxId)) return false;
        const p = parseActivityPayload(e.message);
        return p && p.metric === "useTasks_snapshot_replace";
      });
      if (sawReplace) break;
      await page.waitForTimeout(250);
    }
    // One extra settle to let any in-flight replace flush.
    await page.waitForTimeout(500);

    const allLogs = await page.evaluate(function () { return window.invoker.getActivityLogs(); });
    const measureLogs = allLogs
      .filter(function (e) { return typeof e.id !== "number" || e.id > seedMaxId; })
      .filter(function (e) { return e.source === "ui-perf"; })
      .map(function (e) { return { id: e.id, payload: parseActivityPayload(e.message) }; })
      .filter(function (e) { return e.payload && typeof e.payload === "object"; });

    const findOne = function (metric) {
      return measureLogs.find(function (e) { return e.payload.metric === metric; });
    };
    const findAll = function (metric) {
      return measureLogs.filter(function (e) { return e.payload.metric === metric; });
    };

    const preload = findOne("preload_bootstrap_sync");
    const allReplaces = findAll("useTasks_snapshot_replace");
    const allSkipped = findAll("startup_snapshot_skipped_smaller_than_bootstrap");
    const workflowGraph = findOne("startup_workflow_graph_visible");
    const taskGraph = findOne("startup_graph_visible");
    const snapshotApplied = findOne("startup_snapshot_applied");

    const preloadId = preload ? preload.id : -1;
    const postBootstrapNonForcedReplace = allReplaces.find(function (e) {
      return e.id > preloadId && e.payload.forceRefresh === false;
    });

    const result = {
      elapsedMs: Date.now() - startedAt,
      seedMaxActivityLogId: seedMaxId,
      preload: preload ? preload.payload : null,
      replaces: allReplaces.map(function (e) { return { id: e.id, ...e.payload }; }),
      skippedSmallerThanBootstrap: allSkipped.map(function (e) { return e.payload; }),
      workflowGraphVisible: workflowGraph ? workflowGraph.payload : null,
      taskGraphVisible: taskGraph ? taskGraph.payload : null,
      snapshotApplied: snapshotApplied ? snapshotApplied.payload : null,
      postBootstrapNonForcedReplace: postBootstrapNonForcedReplace
        ? { id: postBootstrapNonForcedReplace.id, ...postBootstrapNonForcedReplace.payload }
        : null,
    };
    fs.writeFileSync(RESULTS_OUT, JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

(async function main() {
  const seedMaxId = await seed();
  await measure(seedMaxId);
})().catch(function (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(2);
});
NODE_EOF

echo "[repro] DB dir : $TMP_DIR" >&2
echo "[repro] config : workflows=$WORKFLOW_COUNT tasks_per_workflow=$TASKS_PER_WORKFLOW" >&2
echo "[repro] launching driver..." >&2

run_driver() {
  INVOKER_REPO_ROOT="$REPO_ROOT" \
  INVOKER_DB_DIR="$TMP_DIR" \
  INVOKER_REPRO_WORKFLOWS="$WORKFLOW_COUNT" \
  INVOKER_REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  INVOKER_REPRO_RESULTS_OUT="$RESULTS_JSON" \
  INVOKER_E2E_BARE_REPO="$BARE_REPO" \
    "$@" node "$DRIVER_SCRIPT"
}

if [[ -n "${DISPLAY:-}" ]]; then
  run_driver
else
  command -v xvfb-run >/dev/null || {
    echo "[repro] xvfb-run required when DISPLAY is unset" >&2
    exit 2
  }
  run_driver xvfb-run --auto-servernum
fi

if [[ ! -f "$RESULTS_JSON" ]]; then
  echo "[repro] FAIL: driver did not produce $RESULTS_JSON" >&2
  exit 2
fi

python3 - "$RESULTS_JSON" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    r = json.load(f)

preload = r.get("preload") or {}
wg = r.get("workflowGraphVisible") or {}
tg = r.get("taskGraphVisible") or {}
sa = r.get("snapshotApplied") or {}
replaces = r.get("replaces") or []
skipped = r.get("skippedSmallerThanBootstrap") or []
post_repl = r.get("postBootstrapNonForcedReplace")

print("=== repro: post-bootstrap startup snapshot refresh overhead ===")
print(f"  driver elapsedMs : {r.get('elapsedMs','?')}")
print()
print("[preload_bootstrap_sync]")
print(f"  taskCount      = {preload.get('taskCount','?')}")
print(f"  workflowCount  = {preload.get('workflowCount','?')}")
print(f"  jsonSizeBytes  = {preload.get('jsonSizeBytes','?')}")
print(f"  durationMs     = {preload.get('durationMs','?')}")
print()
print("[useTasks_snapshot_replace] (all observed in the measure phase)")
if not replaces:
    print("  (none — no snapshot replace fired after bootstrap)")
for i, p in enumerate(replaces):
    print(f"  #{i} forceRefresh={p.get('forceRefresh')} "
          f"taskCount={p.get('taskCount')} workflowCount={p.get('workflowCount')} "
          f"requestDurationMs={p.get('requestDurationMs')} "
          f"replaceDurationMs={p.get('replaceDurationMs')} "
          f"jsonSizeBytes={p.get('jsonSizeBytes')}")
print()
print("[startup_workflow_graph_visible]  (workflow-level DAG)")
print(f"  nodeCount={wg.get('nodeCount')} edgeCount={wg.get('edgeCount')} "
      f"elapsedMs={wg.get('elapsedMs')} processElapsedMs={wg.get('processElapsedMs')}")
print("[startup_graph_visible]            (task-level DAG)")
print(f"  nodeCount={tg.get('nodeCount')} elapsedMs={tg.get('elapsedMs')} "
      f"processElapsedMs={tg.get('processElapsedMs')}")
print()
print("[startup_snapshot_applied]")
print(f"  forceRefresh={sa.get('forceRefresh')} taskCount={sa.get('taskCount')} "
      f"workflowCount={sa.get('workflowCount')} processElapsedMs={sa.get('processElapsedMs')}")
print()
print("[startup_snapshot_skipped_smaller_than_bootstrap]")
if not skipped:
    print("  (none)")
for p in skipped:
    print(f"  bootstrapTaskCount={p.get('bootstrapTaskCount')} "
          f"snapshotTaskCount={p.get('snapshotTaskCount')} "
          f"requestDurationMs={p.get('requestDurationMs')}")
print()
if post_repl is not None:
    print("[verdict] OBSERVED redundant non-forced snapshot replace after preload_bootstrap_sync:")
    print(f"          forceRefresh={post_repl.get('forceRefresh')} "
          f"requestDurationMs={post_repl.get('requestDurationMs')} "
          f"replaceDurationMs={post_repl.get('replaceDurationMs')} "
          f"jsonSizeBytes={post_repl.get('jsonSizeBytes')}")
else:
    print("[verdict] No redundant non-forced snapshot replace observed after preload_bootstrap_sync.")
PY

HAS_REDUNDANT="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print('1' if d.get('postBootstrapNonForcedReplace') else '0')" "$RESULTS_JSON")"

if [[ "$EXPECT_ISSUE" -eq 1 ]]; then
  if [[ "$HAS_REDUNDANT" -eq 1 ]]; then
    echo "[repro] PASS (--expect-issue): redundant non-forced startup snapshot reproduced."
    exit 0
  fi
  echo "[repro] FAIL (--expect-issue): expected a redundant non-forced replace but none was observed." >&2
  exit 1
fi

if [[ "$HAS_REDUNDANT" -eq 1 ]]; then
  echo "[repro] FAIL: redundant non-forced startup snapshot still occurs after preload bootstrap." >&2
  exit 1
fi
echo "[repro] PASS: no redundant non-forced startup snapshot observed after preload bootstrap."
exit 0
