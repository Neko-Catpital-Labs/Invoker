import { test, expect, captureScreenshot } from './fixtures/electron-app.js';

test('workers surface shows read-only worker activity', async ({ page }) => {
  await page.getByTestId('sidebar-workers').click();

  await expect(page.getByTestId('workers-rail')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible();
  await expect(page.getByText('3 workers registered.')).toBeVisible();
  await expect(page.getByTestId('worker-process-list')).toBeVisible();
  await expect(page.getByTestId('worker-row-autofix')).toBeVisible();
  await expect(page.getByTestId('worker-row-pr-status')).toBeVisible();
  await expect(page.getByTestId('worker-row-ci-failure')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start process' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop process' })).toHaveCount(0);

  await captureScreenshot(page, 'workers-read-only-surface');
});
