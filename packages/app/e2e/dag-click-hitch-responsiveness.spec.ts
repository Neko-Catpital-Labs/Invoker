import { expect, test } from './fixtures/electron-app.js';
import type { Page } from '@playwright/test';

const MAX_P95_RTT_MS = 100;
const MAX_SAMPLE_RTT_MS = 250;
const CLICK_SAMPLES = 8;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

async function selectWorkflowForMiniDag(page: Page, workflowId: string) {
  const workflowNode = page.getByTestId(`workflow-node-${workflowId}`);
  const miniDag = page.getByTestId('selected-workflow-mini-dag');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await workflowNode.waitFor({ state: 'attached', timeout: 15_000 });
    await workflowNode.click({ force: true });
    if (await miniDag.isVisible({ timeout: 1500 }).catch(() => false)) {
      return miniDag;
    }
    await workflowNode.dispatchEvent('click', { bubbles: true });
    if (await miniDag.isVisible({ timeout: 1500 }).catch(() => false)) {
      return miniDag;
    }
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);
  }

  await expect(miniDag).toBeVisible({ timeout: 10_000 });
  return miniDag;
}

test('DAG task clicks keep listWorkflows IPC responsive under a fat events table', async ({ page }) => {
  const seeded = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });

  expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);
  expect(seeded.taskCount).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Refresh' }).click();
  const miniDag = await selectWorkflowForMiniDag(page, seeded.workflowId);
  await expect(miniDag.locator('.react-flow__node').first()).toBeAttached({ timeout: 10_000 });

  const taskIds = Array.from({ length: Math.min(seeded.taskCount, CLICK_SAMPLES) }, (_, i) =>
    `${seeded.workflowId}/t${i}`,
  );

  const samples: number[] = [];
  for (const taskId of taskIds) {
    const node = miniDag.locator(`[data-testid="rf__node-${taskId}"]`).first();
    await node.waitFor({ state: 'attached', timeout: 10_000 });
    await node.dispatchEvent('click', { bubbles: true });

    const rtt = await page.evaluate(async () => {
      const started = performance.now();
      await window.invoker.listWorkflows();
      return performance.now() - started;
    });
    samples.push(rtt);
  }

  expect(samples.length).toBeGreaterThanOrEqual(3);
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
