import { captureScreenshot, expect, test } from './fixtures/electron-app.js';

test.describe('System Setup visual proof', () => {
  test('handoff helper setup modal remains visible long enough to review', async ({ page }) => {
    await expect(page.getByTestId('rail-settings')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('rail-settings').click();

    await expect(page.getByRole('heading', { name: 'System Setup' })).toBeVisible();
    await expect(page.getByText('Invoker AI helpers')).toBeVisible();
    await expect(page.getByText('/invoker-plan-to-invoker "help me plan <change>"')).toBeVisible();

    await page.waitForTimeout(1800);
    await captureScreenshot(page, 'system-setup-handoff-helper-modal');
    await page.waitForTimeout(1200);
  });
});
