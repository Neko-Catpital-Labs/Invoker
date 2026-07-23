import { test, expect, captureScreenshot } from './fixtures/electron-app.js';

test('workers surface shows the worker control in the details panel', async ({ page }) => {
  await page.getByTestId('sidebar-workers').click();

  await expect(page.getByTestId('workers-rail')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
  await expect(page.getByText(/\d+ workers registered\./)).toBeVisible();
  await expect(page.getByTestId('worker-process-list')).toBeVisible();
  await expect(page.getByTestId('worker-row-autofix')).toBeVisible();
  await expect(page.getByTestId('worker-row-pr-status')).toBeVisible();
  await expect(page.getByTestId('worker-row-ci-failure')).toBeVisible();

  await page.getByTestId('worker-row-pr-status').click();
  await expect(page.getByTestId('worker-detail-start-stop')).toBeVisible();
  await expect(page.locator('[data-testid^="worker-start-stop-"]')).toHaveCount(0);

  await captureScreenshot(page, 'workers-read-only-surface');
});

test('workers surface details control turns one worker off without touching the others', async ({ page }) => {
  await page.getByTestId('sidebar-workers').click();
  await expect(page.getByTestId('worker-process-list')).toBeVisible();

  await page.getByTestId('worker-row-pr-status').click();
  const control = page.getByTestId('worker-detail-start-stop');
  await expect(control).toHaveAttribute('data-action', 'stop');
  await expect(page.getByTestId('worker-lifecycle-pr-status')).toHaveAttribute('data-lifecycle', 'running');
  await captureScreenshot(page, 'workers-detail-control-step-1-running');

  await control.click();

  await expect(page.getByTestId('worker-lifecycle-pr-status')).toHaveAttribute('data-lifecycle', 'stopped');
  await expect(control).toHaveAttribute('data-action', 'start');
  await expect(page.getByTestId('worker-lifecycle-ci-failure')).toHaveAttribute('data-lifecycle', 'running');
  await captureScreenshot(page, 'workers-detail-control-step-2-one-off');

  await control.click();

  await expect(page.getByTestId('worker-lifecycle-pr-status')).toHaveAttribute('data-lifecycle', 'running');
  await expect(control).toHaveAttribute('data-action', 'stop');
  await captureScreenshot(page, 'workers-detail-control-step-3-back-on');
});

test('workers surface details control follows the selected worker', async ({ page }) => {
  await page.getByTestId('sidebar-workers').click();
  await expect(page.getByTestId('worker-process-list')).toBeVisible();

  await page.getByTestId('worker-row-pr-status').click();
  await expect(page.getByTestId('worker-detail-start-stop')).toHaveAttribute('data-action', 'stop');

  await page.getByTestId('worker-row-autofix').click();
  await expect(page.getByTestId('worker-detail-start-stop')).toHaveAttribute('data-action', 'start');
});
