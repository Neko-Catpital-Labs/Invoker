import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';
import { parseActivityPayload } from './fixtures/ui-perf.js';

const POLL_WINDOW_MS = 8_000;
const SAMPLE_INTERVAL_MS = 100;
const MAX_P95_RTT_MS = 150;
const MAX_SAMPLE_RTT_MS = 400;

const TERMINAL_HITCH_PLAN = {
  name: 'Terminal upsert hitch',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'terminal-hitch-task',
      description: 'Completed task for terminal upsert hitch',
      command: 'echo unused',
      dependencies: [],
    },
  ],
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function openTerminalForTask(page: Page, taskId: string): Promise<string> {
  const result = await page.evaluate((id) => window.invoker.openTerminal(id), taskId);
  if (!result?.opened) {
    throw new Error(`openTerminal failed: ${result?.reason ?? 'unknown reason'}`);
  }
  await expect
    .poll(() => page.evaluate(() => window.invoker.terminalList().then((rows) => rows.length)))
    .toBeGreaterThan(0);
  const sessions = await page.evaluate(() => window.invoker.terminalList());
  const sessionId = sessions[0]?.sessionId;
  if (!sessionId) throw new Error('No terminal session after openTerminal');
  return sessionId;
}

test.use({
  repoConfig: { autoFixRetries: 0, disableAutoRunOnStartup: true },
});

test('terminal output upserts keep IPC responsive under a fat DB', async ({ page, testDir }) => {
  const seeded = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });
  expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);

  await loadPlan(page, TERMINAL_HITCH_PLAN);

  const workspacePath = path.join(testDir, 'terminal-hitch-workspace');
  mkdirSync(workspacePath, { recursive: true });
  await injectTaskStates(page, [
    {
      taskId: 'terminal-hitch-task',
      changes: {
        status: 'completed',
        config: { runnerKind: 'worktree' },
        execution: {
          workspacePath,
          completedAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      },
    },
  ]);

  const fullTaskId = await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    return tasks.find((task: { id: string }) => task.id.endsWith('/terminal-hitch-task'))?.id ?? null;
  });
  if (!fullTaskId) throw new Error('terminal-hitch-task was not loaded');

  const sessionId = await openTerminalForTask(page, fullTaskId);

  const logWatermark = await page.evaluate(async () => {
    const logs = await window.invoker.getActivityLogs(0, 1);
    return logs.at(-1)?.id ?? 0;
  });

  // Kick off a high-volume PTY dump so emitOutput → upsertTerminalSession fires often.
  const flood = await page.evaluate(async (id) => {
    return window.invoker.terminalWrite(
      id,
      'python3 -c \'import sys; sys.stdout.write(("x"*1024+"\\n")*80); sys.stdout.flush()\'\n',
    );
  }, sessionId);
  expect(flood.ok).toBe(true);

  const samples: number[] = [];
  const deadline = Date.now() + POLL_WINDOW_MS;
  while (Date.now() < deadline) {
    const rtt = await page.evaluate(async (id) => {
      const started = performance.now();
      await Promise.all([
        window.invoker.getWorkerStatus(),
        window.invoker.listWorkflows(),
        window.invoker.terminalWrite(id, ''),
      ]);
      return performance.now() - started;
    }, sessionId);
    samples.push(rtt);
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  expect(samples.length).toBeGreaterThanOrEqual(20);
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1]!;

  expect(
    p95,
    `p95 IPC RTT ${p95.toFixed(1)}ms exceeded ${MAX_P95_RTT_MS}ms (max=${max.toFixed(1)}ms, n=${samples.length})`,
  ).toBeLessThanOrEqual(MAX_P95_RTT_MS);
  expect(
    max,
    `max IPC RTT ${max.toFixed(1)}ms exceeded ${MAX_SAMPLE_RTT_MS}ms (p95=${p95.toFixed(1)}ms, n=${samples.length})`,
  ).toBeLessThanOrEqual(MAX_SAMPLE_RTT_MS);

  const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());
  expect(typeof perf.maxTerminalSessionUpsertMs).toBe('number');
  expect(Number(perf.maxTerminalSessionUpsertMs)).toBeGreaterThan(0);

  const slowRows = await page.evaluate(async (sinceId) => window.invoker.getActivityLogs(sinceId, 2000), logWatermark)
    .then((logs) => logs
      .filter((row) => row.source === 'ui-perf')
      .map((row) => parseActivityPayload(row.message))
      .filter((payload) => payload?.metric === 'terminal_session_upsert_slow'));

  // Burst/throttle telemetry should observe the flood on a fat DB; allow either a
  // slow-row emit or a non-zero upsert max as proof the path was exercised.
  if (slowRows.length === 0) {
    expect(
      Number(perf.maxTerminalSessionUpsertMs),
      `expected maxTerminalSessionUpsertMs > 0 after flood (slowRows=0)`,
    ).toBeGreaterThan(0);
  } else {
    expect(slowRows[0]?.metric).toBe('terminal_session_upsert_slow');
  }
});
