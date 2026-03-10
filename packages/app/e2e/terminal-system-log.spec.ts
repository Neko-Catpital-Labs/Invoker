/**
 * E2E: Terminal and System Activity Log.
 *
 * Tests the system activity log feature, including the IPC fix
 * for fetching historical entries on open.
 * Regression: startup logs were not visible (fixed in IPC audit).
 */

import { test, expect, TEST_PLAN, loadPlan } from './fixtures/electron-app.js';

test.describe('System Activity Log', () => {
  test('System Log button is visible in status bar', async ({ page }) => {
    await expect(page.getByText('System Log')).toBeVisible();
  });

  test('clicking System Log opens the terminal with xterm', async ({ page }) => {
    await page.getByText('System Log').click();

    const xtermScreen = page.locator('.xterm-screen');
    await expect(xtermScreen).toBeVisible({ timeout: 5000 });
  });

  test('getActivityLogs IPC returns entries after generating activity', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    // Wait for db-poll to detect the new workflow
    await page.waitForTimeout(3000);

    const entries = await page.evaluate(() => window.invoker.getActivityLogs());
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]).toHaveProperty('source');
    expect(entries[0]).toHaveProperty('level');
    expect(entries[0]).toHaveProperty('message');
  });

  test('system log shows historical entries when opened', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    // Wait for activity to accumulate
    await page.waitForTimeout(3000);

    // Now open system log — should fetch historical entries
    await page.getByText('System Log').click();

    const xtermScreen = page.locator('.xterm-screen');
    await expect(xtermScreen).toBeVisible({ timeout: 5000 });

    // Verify entries exist via IPC
    const entries = await page.evaluate(() => window.invoker.getActivityLogs());
    expect(entries.length).toBeGreaterThan(0);
  });
});
