import { expect, test } from './fixtures/electron-app.js';

const MAX_P95_RTT_MS = process.env.CI ? 150 : 100;
const MAX_SAMPLE_RTT_MS = 250;
const HIDDEN_MS = 6_000;
const REFOCUS_SAMPLES = 8;
const SAMPLE_INTERVAL_MS = 100;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function seedHitchFixture(page: import('@playwright/test').Page) {
  const seeded = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });
  expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);
  expect(seeded.workerActionCount).toBeGreaterThan(0);
  return seeded;
}

/**
 * Repro for Cursor→Invoker beachball: while the window is backgrounded,
 * Chromium throttles renderer timers; on show/focus the deferred status polls
 * (worker + queue + action-graph) fire together and stall the main process.
 *
 * This test forces that herd after hide→show and asserts cheap IPC stays under
 * the hitch budget. It should fail until polls are visibility-gated / coalesced.
 */
test('hide→show status-poll herd keeps listWorkflows IPC responsive under a fat DB', async ({
  page,
  electronApp,
}) => {
  await seedHitchFixture(page);

  // Warm the same IPC paths the UI polls every 2s.
  await page.evaluate(async () => {
    await Promise.all([
      window.invoker.getWorkerStatus(),
      window.invoker.getQueueStatus(),
      window.invoker.getActionGraph?.(),
    ]);
  });

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow found');
    win.hide();
  });

  await page.waitForTimeout(HIDDEN_MS);

  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow found');
    win.show();
    win.focus();
  });

  // Isolate which status IPC dominates the refocus herd (diagnostic, not asserted).
  const isolated = await page.evaluate(async () => {
    const time = async (label: string, fn: () => Promise<unknown>) => {
      const started = performance.now();
      await fn();
      return { label, ms: performance.now() - started };
    };
    return {
      worker: await time('getWorkerStatus', () => window.invoker.getWorkerStatus()),
      queue: await time('getQueueStatus', () => window.invoker.getQueueStatus()),
      actionGraph: await time('getActionGraph', () => window.invoker.getActionGraph?.() ?? Promise.resolve(null)),
      list: await time('listWorkflows', () => window.invoker.listWorkflows()),
    };
  });
  // eslint-disable-next-line no-console
  console.log('[focus-switch-hitch] isolated IPC ms', isolated);

  const samples: number[] = [];
  for (let i = 0; i < REFOCUS_SAMPLES; i += 1) {
    const rtt = await page.evaluate(async () => {
      const started = performance.now();
      // Simulate Chromium releasing throttled timers: all status polls + a cheap
      // probe share one main-thread turn (the beachball signature).
      await Promise.all([
        window.invoker.getWorkerStatus(),
        window.invoker.getQueueStatus(),
        window.invoker.getActionGraph?.(),
        window.invoker.listWorkflows(),
      ]);
      return performance.now() - started;
    });
    samples.push(rtt);
    await page.waitForTimeout(SAMPLE_INTERVAL_MS);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1]!;
  // eslint-disable-next-line no-console
  console.log('[focus-switch-hitch] herd RTT ms', { samples, p95, max, isolated });

  expect(
    p95,
    `p95 refocus-herd IPC RTT ${p95.toFixed(1)}ms exceeded ${MAX_P95_RTT_MS}ms `
      + `(max=${max.toFixed(1)}ms, n=${samples.length}, isolated=${JSON.stringify(isolated)})`,
  ).toBeLessThanOrEqual(MAX_P95_RTT_MS);
  expect(
    max,
    `max refocus-herd IPC RTT ${max.toFixed(1)}ms exceeded ${MAX_SAMPLE_RTT_MS}ms `
      + `(p95=${p95.toFixed(1)}ms, n=${samples.length}, isolated=${JSON.stringify(isolated)})`,
  ).toBeLessThanOrEqual(MAX_SAMPLE_RTT_MS);
});
