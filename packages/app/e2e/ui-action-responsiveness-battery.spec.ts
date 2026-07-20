import { expect, test, E2E_REPO_URL } from './fixtures/electron-app.js';
import { stringify as yamlStringify } from 'yaml';
import type { Page } from '@playwright/test';

const WORKFLOW_COUNT = 30;
const TASKS_PER_WORKFLOW = 4;
const ACK_BUDGET_MS = 200;
/** Workflow select → selected-workflow-mini-dag must paint in ≤100ms (in-memory filter). */
const WORKFLOW_SELECT_ACK_BUDGET_MS = 100;
const IPC_P95_BUDGET_MS = 200;
const IPC_MAX_BUDGET_MS = 250;
const IPC_SAMPLE_INTERVAL_MS = 100;
const IPC_WINDOW_MS = 8_000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

function buildPlan(index: number) {
  return {
    name: `UI Action Battery Plan ${index}`,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

async function seedLoad(page: Page): Promise<void> {
  const seeded = await page.evaluate(async () => {
    if (!window.invoker.seedMainProcessHitchFixture) {
      throw new Error('seedMainProcessHitchFixture is not exposed (NODE_ENV=test required)');
    }
    return window.invoker.seedMainProcessHitchFixture();
  });
  expect(seeded.eventCount).toBeGreaterThanOrEqual(10_000);

  const plans = Array.from({ length: WORKFLOW_COUNT }, (_, index) => yamlStringify(buildPlan(index)));
  await page.evaluate(async (planTexts) => {
    for (const planText of planTexts) {
      await window.invoker.loadPlan(planText);
    }
  }, plans);
  await page.waitForFunction(
    (expected) => window.invoker.listWorkflows().then((workflows) => workflows.length >= expected),
    WORKFLOW_COUNT,
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('[data-testid^="workflow-node-"]:visible').first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
}

async function measureAck(page: Page, action: () => Promise<void>, assertVisible: () => Promise<void>): Promise<number> {
  const started = await page.evaluate(() => performance.now());
  await action();
  await assertVisible();
  const ended = await page.evaluate(() => performance.now());
  return ended - started;
}

test('UI actions acknowledge within 200ms under fat DB + large graph', async ({ page }) => {
  test.setTimeout(180_000);
  await seedLoad(page);

  const ipcSamples: number[] = [];
  let sampling = true;
  const MIN_IPC_SAMPLES = 15;
  const sampler = (async () => {
    // Sample while the interactions run, and — because seedLoad dominates the
    // wall-clock and dispatchEvent interactions finish fast — keep going until we
    // have a meaningful sample count. Bounded by a hard cap so it always ends.
    const hardDeadline = Date.now() + IPC_WINDOW_MS + 20_000;
    while ((sampling || ipcSamples.length < MIN_IPC_SAMPLES) && Date.now() < hardDeadline) {
      const rtt = await page.evaluate(async () => {
        const started = performance.now();
        await Promise.all([
          window.invoker.listWorkflows(),
          window.invoker.getWorkerStatus(),
        ]);
        return performance.now() - started;
      });
      ipcSamples.push(rtt);
      await page.waitForTimeout(IPC_SAMPLE_INTERVAL_MS);
    }
  })();

  // Sidebar / surface switches
  let ack = await measureAck(
    page,
    async () => { await page.getByTestId('sidebar-workers').click(); },
    async () => { await expect(page.getByTestId('workers-rail')).toBeVisible({ timeout: ACK_BUDGET_MS + 500 }); },
  );
  expect(ack, `sidebar-workers ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);

  // Workers start/stop optimistic ack
  const availableWorkerButton = page.locator('[data-testid^="worker-start-stop-"]:not(:disabled)').first();
  if (await availableWorkerButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    const workerKind = (await availableWorkerButton.getAttribute('data-testid'))?.replace('worker-start-stop-', '');
    if (!workerKind) throw new Error('Worker start/stop button is missing its kind');
    const startAction = await availableWorkerButton.getAttribute('data-action');
    if (startAction === 'start') {
      ack = await measureAck(
        page,
        async () => { await availableWorkerButton.click(); },
        async () => {
          await expect(page.getByTestId(`worker-lifecycle-${workerKind}`)).toHaveAttribute('data-lifecycle', 'running', {
            timeout: ACK_BUDGET_MS + 500,
          });
        },
      );
      expect(ack, `worker start ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);
    }

    const stopButton = page.getByTestId(`worker-start-stop-${workerKind}`);
    ack = await measureAck(
      page,
      async () => { await stopButton.click(); },
      async () => {
        await expect(page.getByTestId(`worker-lifecycle-${workerKind}`)).toHaveAttribute('data-lifecycle', 'stopped', {
          timeout: ACK_BUDGET_MS + 500,
        });
      },
    );
    expect(ack, `worker stop ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);
  }

  // Home / Workers / Plan graph left-hand nav — the sidebar surfaces users actually click.
  ack = await measureAck(
    page,
    async () => { await page.getByTestId('sidebar-home').click(); },
    async () => { await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: ACK_BUDGET_MS + 500 }); },
  );
  expect(ack, `sidebar-home ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);

  ack = await measureAck(
    page,
    async () => { await page.getByTestId('sidebar-workers').click(); },
    async () => { await expect(page.getByTestId('workers-rail')).toBeVisible({ timeout: ACK_BUDGET_MS + 1500 }); },
  );
  expect(ack, `sidebar-workers ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS + 50);

  await page.getByTestId('sidebar-planning').click();
  await expect(page.getByTestId('workflow-graph-surface')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid^="workflow-node-"]:visible').first()).toBeVisible({ timeout: 15_000 });

  // Workflow select. React-flow nodes carry a `transition-all` class and
  // re-render on every status poll, so Playwright never sees them "stable";
  // dispatchEvent fires the interaction without the actionability wait (the
  // same approach the shared fixture uses). The ack is still measured by how
  // fast the target UI (mini-DAG / menu) paints.
  // Select a normal plan workflow, not the fixture's pathological 40-task/huge-
  // event `wf-hitch-fat` node — its mini-DAG react-flow render cost is orthogonal
  // to the "responsive under a fat DB" invariant this test measures.
  const workflowNode = page
    .locator('[data-testid^="workflow-node-"]:visible:not([data-testid="workflow-node-wf-hitch-fat"])')
    .first();
  await workflowNode.waitFor({ state: 'attached', timeout: 15_000 });
  ack = await measureAck(
    page,
    async () => { await workflowNode.dispatchEvent('click', { bubbles: true }); },
    async () => {
      await expect(page.getByTestId('selected-workflow-mini-dag')).toBeVisible({
        timeout: WORKFLOW_SELECT_ACK_BUDGET_MS + 1500,
      });
    },
  );
  expect(ack, `workflow select ack ${ack}ms`).toBeLessThanOrEqual(WORKFLOW_SELECT_ACK_BUDGET_MS);

  // Workflow right-click context menu (must paint within 200ms under load)
  ack = await measureAck(
    page,
    async () => { await workflowNode.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2 }); },
    async () => {
      await expect(page.getByTestId('workflow-context-menu')).toBeVisible({ timeout: ACK_BUDGET_MS + 500 });
    },
  );
  expect(ack, `workflow context menu ack ${ack.toFixed(1)}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);
  await expect(page.getByTestId('workflow-context-menu').getByRole('menuitem', { name: 'Open Workflow' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('workflow-context-menu')).toHaveCount(0);

  // Ensure a workflow is selected so the task mini-DAG is available
  await workflowNode.dispatchEvent('click', { bubbles: true });
  await expect(page.getByTestId('selected-workflow-mini-dag')).toBeVisible({ timeout: 10_000 });
  const taskNode = page.locator('[data-testid="selected-workflow-mini-dag"] .react-flow__node').first();
  await taskNode.waitFor({ state: 'attached', timeout: 10_000 });

  // Task right-click context menu (must paint within 200ms under load)
  ack = await measureAck(
    page,
    async () => { await taskNode.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2 }); },
    async () => {
      await expect(page.getByTestId('task-context-menu')).toBeVisible({ timeout: ACK_BUDGET_MS + 500 });
    },
  );
  expect(ack, `task context menu ack ${ack.toFixed(1)}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);
  await expect(page.getByTestId('task-context-menu').getByRole('menuitem').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('task-context-menu')).toHaveCount(0);

  // Keyboard search
  ack = await measureAck(
    page,
    async () => {
      await page.keyboard.press('Shift');
      await page.keyboard.press('Shift');
    },
    async () => { await expect(page.getByTestId('keyboard-search-overlay')).toBeVisible({ timeout: ACK_BUDGET_MS + 500 }); },
  );
  expect(ack, `search overlay ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS + 50);
  await page.getByTestId('keyboard-search-input').fill('UI Action Battery Plan 0');
  await page.keyboard.press('Escape');

  // Inspector minimize/maximize if present
  const minimize = page.getByRole('button', { name: 'Minimize inspector' });
  if (await minimize.count()) {
    ack = await measureAck(
      page,
      async () => { await minimize.click(); },
      async () => { await expect(page.getByRole('button', { name: 'Maximize inspector' })).toBeVisible({ timeout: ACK_BUDGET_MS + 500 }); },
    );
    expect(ack, `inspector minimize ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS);
    await page.getByRole('button', { name: 'Maximize inspector' }).click();
  }

  // Terminal drawer maximize if available
  const maximizeDrawer = page.getByRole('button', { name: 'Maximize terminal drawer' });
  if (await maximizeDrawer.count()) {
    ack = await measureAck(
      page,
      async () => { await maximizeDrawer.click(); },
      async () => { await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized', { timeout: ACK_BUDGET_MS + 1000 }); },
    );
    expect(ack, `terminal drawer ack ${ack}ms`).toBeLessThanOrEqual(ACK_BUDGET_MS + 50);
  }

  sampling = false;
  await sampler;

  expect(ipcSamples.length).toBeGreaterThanOrEqual(10);
  const sorted = [...ipcSamples].sort((a, b) => a - b);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1]!;
  expect(p95, `concurrent IPC p95 ${p95.toFixed(1)}ms`).toBeLessThanOrEqual(IPC_P95_BUDGET_MS);
  expect(max, `concurrent IPC max ${max.toFixed(1)}ms`).toBeLessThanOrEqual(IPC_MAX_BUDGET_MS);
});
