import { expect, test } from './fixtures/electron-app.js';

const POLL_WINDOW_MS = 10_000;
const SAMPLE_INTERVAL_MS = 100;
const MAX_P95_RTT_MS = 100;
const MAX_SAMPLE_RTT_MS = 250;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

test('worker-status polling keeps listWorkflows IPC responsive under a fat DB', async ({ page }) => {
  const seeded = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });

  expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);
  expect(seeded.workerActionCount).toBeGreaterThan(0);

  await page.evaluate(async () => {
    await window.invoker.getWorkerStatus();
  });

  const samples: number[] = [];
  const deadline = Date.now() + POLL_WINDOW_MS;
  while (Date.now() < deadline) {
    const rtt = await page.evaluate(async () => {
      const started = performance.now();
      await Promise.all([
        window.invoker.getWorkerStatus(),
        window.invoker.listWorkflows(),
      ]);
      return performance.now() - started;
    });
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
});

test('startWorker/stopWorker accept within 200ms under fat DB with concurrent listWorkflows', async ({ page }) => {
  const seeded = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });

  expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);

  const kind = await page.evaluate(async () => {
    const snapshot = await window.invoker.getWorkerStatus();
    const candidate = snapshot.workers.find((worker) => worker.startable || worker.stoppable || worker.lifecycle === 'running')
      ?? snapshot.workers[0];
    if (!candidate) throw new Error('No workers available for start/stop probe');
    return candidate.kind;
  });

  const ACCEPT_BUDGET_MS = 200;

  const startSample = await page.evaluate(async (workerKind) => {
    const started = performance.now();
    const [startResult] = await Promise.all([
      window.invoker.startWorker(workerKind),
      window.invoker.listWorkflows(),
    ]);
    return { rtt: performance.now() - started, lifecycle: startResult.lifecycle };
  }, kind);

  expect(
    startSample.rtt,
    `startWorker accept RTT ${startSample.rtt.toFixed(1)}ms exceeded ${ACCEPT_BUDGET_MS}ms`,
  ).toBeLessThanOrEqual(ACCEPT_BUDGET_MS);

  const stopSample = await page.evaluate(async (workerKind) => {
    const started = performance.now();
    const [stopResult] = await Promise.all([
      window.invoker.stopWorker(workerKind),
      window.invoker.listWorkflows(),
    ]);
    return { rtt: performance.now() - started, lifecycle: stopResult.lifecycle };
  }, kind);

  expect(
    stopSample.rtt,
    `stopWorker accept RTT ${stopSample.rtt.toFixed(1)}ms exceeded ${ACCEPT_BUDGET_MS}ms`,
  ).toBeLessThanOrEqual(ACCEPT_BUDGET_MS);
});

