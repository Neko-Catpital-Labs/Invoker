import { test, expect, TEST_PLAN, loadPlan, captureScreenshot } from './fixtures/electron-app.js';

test.describe('command palette visual proof', () => {
  test('opens the command palette with Cmd+K', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.getByTestId('app-sidebar')).toBeVisible();

    await captureScreenshot(page, 'command-palette-closed');

    await page.keyboard.press('Meta+K');
    await expect(page.getByTestId('command-palette')).toHaveAttribute('data-state', 'open');
    await expect(page.getByPlaceholder('Jump to workflow, task, or view…')).toBeVisible();
    await captureScreenshot(page, 'command-palette-open');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('command-palette')).toHaveAttribute('data-state', 'closed');
    await captureScreenshot(page, 'command-palette-closed-after-escape');
  });
});
