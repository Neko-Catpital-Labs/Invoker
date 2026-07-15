/**
 * Visual proof: home bottom chrome shows queue executing vs queued.
 * Running sidebar keeps the detailed list split.
 */
import {
  test,
  expect,
  E2E_REPO_URL,
  loadPlan,
  startPlan,
  captureScreenshot,
} from './fixtures/electron-app.js';

test.use({
  repoConfig: {
    autoFixRetries: 0,
    maxConcurrency: 1,
  },
});

const QUEUE_SPLIT_PLAN = {
  name: 'Running Queued Split Proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'slot-holder',
      description: 'Occupies the only runner slot',
      command: 'sleep 30 && echo slot-holder-done',
      dependencies: [],
    },
    {
      id: 'waiting-task',
      description: 'Waits for a free runner slot',
      command: 'echo waiting-task-done',
      dependencies: [],
    },
  ],
};

test.describe('queue running vs queued', () => {
  test('home bottom chrome shows executing and queued chips', async ({ page }) => {
    await loadPlan(page, QUEUE_SPLIT_PLAN);
    await startPlan(page);

    await expect.poll(async () => {
      const status = await page.evaluate(async () => await window.invoker.getQueueStatus());
      return {
        running: status?.running?.length ?? 0,
        queued: status?.queued?.length ?? 0,
      };
    }, { timeout: 30000 }).toEqual({ running: 1, queued: 1 });

    // Stay on home — this is the live bottom bar surface.
    await expect(page.getByTestId('sidebar-home')).toBeVisible();
    await expect(page.getByTestId('queue-chip-running')).toHaveTextContent('Executing (1/1)');
    await expect(page.getByTestId('queue-chip-queued')).toHaveTextContent('Queued (1)');
    await captureScreenshot(page, 'home-queue-capacity-chips');

    await page.getByTestId('sidebar-running').click();
    await expect(page.getByTestId('running-queue-section-running')).toContainText('Running (1)');
    await expect(page.getByTestId('running-queue-section-queued')).toContainText('Queued (1)');
    await captureScreenshot(page, 'running-queued-split');
  });
});
