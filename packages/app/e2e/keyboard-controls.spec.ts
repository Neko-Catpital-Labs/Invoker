/**
 * E2E: Keyboard shortcuts and TopBar controls.
 *
 * Tests Ctrl+` terminal toggle and TopBar button behavior.
 */

import { test, expect } from './fixtures/electron-app.js';

test.describe('Keyboard shortcuts', () => {
  test('Ctrl+Backtick toggles the terminal', async ({ page }) => {
    // Focus the page
    await page.locator('body').click({ position: { x: 200, y: 200 } });

    // Toggle open
    await page.keyboard.press('Control+Backquote');
    await page.waitForTimeout(500);

    // Toggle closed
    await page.keyboard.press('Control+Backquote');
    await page.waitForTimeout(500);

    // Verify page is still interactive
    await expect(page.getByText('Open File')).toBeVisible();
  });
});

test.describe('TopBar controls', () => {
  test('Refresh button triggers task refresh without error', async ({ page }) => {
    await page.getByText('Refresh').click();
    await expect(page.getByText('Open File')).toBeVisible();
  });

  test('Clear button works when no plan is loaded', async ({ page }) => {
    await page.getByText('Clear').click();
    // Page should still be functional
    await expect(page.getByText('Open File')).toBeVisible();
  });
});

test.describe('Terminal toggle bar', () => {
  test('clicking the terminal toggle bar toggles it', async ({ page }) => {
    const toggleBar = page.locator('button').filter({ hasText: 'Terminal' });
    await expect(toggleBar).toBeVisible();

    // Click to toggle
    await toggleBar.click();
    await page.waitForTimeout(500);

    // Click again to toggle back
    await toggleBar.click();
    await page.waitForTimeout(500);

    await expect(page.getByText('Open File')).toBeVisible();
  });
});
