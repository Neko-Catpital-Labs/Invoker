import { _electron as electron, expect, test } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import * as fs from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as yamlStringify } from 'yaml';
import type { ElectronApplication, Page } from '@playwright/test';

import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const repoRoot = resolveRepoRoot(__dirname);

const WORKFLOW_COUNT = 30;
const PLAN_TASKS_PER_WORKFLOW = 7;
const TASKS_PER_WORKFLOW = 8;
const ITERATIONS = 5;
const RECOVERY_TIMEOUT_MS = 10000;

async function launchElectronApp(testDir: string, extraEnv?: Record<string, string>) {
  const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
  const stubDir = path.join(testDir, 'claude-stub');
  const markerRoot = path.join(testDir, 'e2e-markers');
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const electronUserDataDir = path.join(testDir, 'electron-user-data');
  await fs.mkdir(stubDir, { recursive: true });
  await fs.mkdir(markerRoot, { recursive: true });
  await fs.mkdir(electronUserDataDir, { recursive: true });
  registerTrackedBrowserUserDataDir(electronUserDataDir);
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  try {
    await fs.symlink(claudeMarker, path.join(stubDir, 'claude'));
  } catch {}
  return electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
        : []),
      `--user-data-dir=${electronUserDataDir}`,
      path.resolve(__dirname, '..', 'dist', 'main.js'),
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
          INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_GUI_OWNER_MODE: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_MARKER_ROOT: markerRoot,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ...(extraEnv ?? {}),
      INVOKER_USER_DATA_DIR: electronUserDataDir,
    },
  });
}

function buildPlan(index: number) {
  return {
    name: `Gap Bench Plan ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: PLAN_TASKS_PER_WORKFLOW }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

async function waitForWorkflowGraphVisible(page: Page, timeoutMs: number): Promise<void> {
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({
    state: 'visible',
    timeout: timeoutMs,
  });
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

interface IterationResult {
  iteration: number;
  recovery_ms: number;
  gap_to_replace_log_lag_ms: number;
}

interface PerfMarker {
  id: number;
  metric: string;
  ts: number;
}

async function getPerfMarkersSince(page: Page, sinceId: number): Promise<PerfMarker[]> {
  return page.evaluate(async (since: number) => {
    const api = window.invoker as unknown as {
      getActivityLogs: (sinceId?: number, limit?: number) => Promise<Array<{ id: number; timestamp: string; source: string; message: string }>>;
    };
    const logs = await api.getActivityLogs(since, 1000);
    const markers: Array<{ id: number; metric: string; ts: number }> = [];
    for (const l of logs) {
      if (l.source !== 'ui-perf') continue;
      try {
        const p = JSON.parse(l.message) as { metric?: string; ts?: string };
        if (!p?.metric) continue;
        const ms = p.ts ? new Date(p.ts).getTime() : new Date(l.timestamp).getTime();
        markers.push({ id: l.id, metric: p.metric, ts: ms });
      } catch {
        continue;
      }
    }
    return markers;
  }, sinceId);
}

async function getHighestActivityLogId(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = window.invoker as unknown as {
      getActivityLogs: (sinceId?: number, limit?: number) => Promise<Array<{ id: number }>>;
    };
    const logs = await api.getActivityLogs(0, 100000);
    return logs.length > 0 ? logs[logs.length - 1].id : 0;
  });
}

async function runIterationOnce(app: ElectronApplication, page: Page, iteration: number): Promise<IterationResult> {
  const baselineId = await getHighestActivityLogId(page);

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.webContents.send('invoker:task-graph-event', {
      type: 'delta',
      delta: {
        type: 'removed',
        taskId: '__gap_trigger__',
        streamSequence: Number.MAX_SAFE_INTEGER,
      },
    });
  });

  let markers: PerfMarker[] = [];
  const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    markers = await getPerfMarkersSince(page, baselineId);
    const gapIdx = markers.findIndex((m) => m.metric === 'ui_delta_stream_gap_detected');
    if (gapIdx !== -1) {
      const replaceIdx = markers.findIndex(
        (m, i) => i > gapIdx && (m.metric === 'useTasks_snapshot_replace' || m.metric === 'ui_delta_apply'),
      );
      if (replaceIdx !== -1) break;
    }
    await page.waitForTimeout(25);
  }

  const gapIdx = markers.findIndex((m) => m.metric === 'ui_delta_stream_gap_detected');
  const replaceIdx = markers.findIndex(
    (m, i) => i > gapIdx && (m.metric === 'useTasks_snapshot_replace' || m.metric === 'ui_delta_apply'),
  );
  if (gapIdx === -1 || replaceIdx === -1) {
    throw new Error(
      `iteration ${iteration}: missing markers after ${RECOVERY_TIMEOUT_MS}ms. ` +
        `Saw metrics=${JSON.stringify(markers.map((m) => m.metric))}`,
    );
  }

  const recovery_ms = Math.max(0, markers[replaceIdx].ts - markers[gapIdx].ts);
  return {
    iteration,
    recovery_ms,
    gap_to_replace_log_lag_ms: recovery_ms,
  };
}

test('gap-recovery bench: 5 iterations of synthetic-gap → resync at 30 workflows × 8 tasks', async () => {
  test.setTimeout(180000);
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-gap-bench-'));
  const expectedTaskCount = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;

  try {
    const seedApp = await launchElectronApp(testDir);
    try {
      const page = await seedApp.firstWindow({ timeout: 5000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 5000 });

      for (let index = 0; index < WORKFLOW_COUNT; index += 1) {
        const planYaml = yamlStringify(buildPlan(index));
        await page.evaluate(async (planText) => {
          await window.invoker.loadPlan(planText);
        }, planYaml);
      }

      const seeded = await page.evaluate(() => window.invoker.getTasks());
      const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
      expect(seededTasks.length).toBe(expectedTaskCount);
    } finally {
      await seedApp.close();
    }

    const app = await launchElectronApp(testDir, {
      INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000',
    });
    try {
      const page = await app.firstWindow({ timeout: 20000 });
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 5000 });
      await waitForWorkflowGraphVisible(page, 10000);

      await page.waitForTimeout(150);

      const iterations: IterationResult[] = [];
      for (let i = 1; i <= ITERATIONS; i += 1) {
        const result = await runIterationOnce(app, page, i);
        iterations.push(result);
        await page.waitForTimeout(150);
      }

      const recoveries = iterations.map((it) => it.recovery_ms);
      const result = {
        iterations,
        median: {
          recovery_ms: quantile(recoveries, 0.5),
        },
        p95: {
          recovery_ms: quantile(recoveries, 0.95),
        },
        max: {
          recovery_ms: Math.max(...recoveries),
        },
        config: {
          workflowCount: WORKFLOW_COUNT,
          tasksPerWorkflow: TASKS_PER_WORKFLOW,
          expectedTaskCount,
          iterations: ITERATIONS,
        },
      };

      console.log(`GAP_RECOVERY_BENCH_RESULT=${JSON.stringify(result)}`);

      console.log('');
      console.log('=== Gap-recovery bench ===');
      console.log(`Config: ${WORKFLOW_COUNT} workflows × ${TASKS_PER_WORKFLOW} tasks = ${expectedTaskCount} tasks; iterations = ${ITERATIONS}`);
      console.log('');
      console.log('Per-iteration gap → resync recovery (ms):');
      console.log('  iter | recovery_ms');
      for (const it of iterations) {
        console.log(`  ${String(it.iteration).padStart(4)} | ${String(Math.round(it.recovery_ms)).padStart(11)}`);
      }
      console.log('');
      console.log('Aggregate (ms):');
      console.log(`  median: ${Math.round(result.median.recovery_ms)}`);
      console.log(`  p95:    ${Math.round(result.p95.recovery_ms)}`);
      console.log(`  max:    ${Math.round(result.max.recovery_ms)}`);
      console.log('==============================');

      expect(iterations.length).toBe(ITERATIONS);
    } finally {
      await app.close();
    }
  } finally {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {}
  }
});
