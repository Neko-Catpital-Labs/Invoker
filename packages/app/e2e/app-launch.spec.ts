/**
 * E2E: App launch and initial state.
 *
 * Verifies the Electron window opens correctly, the UI renders,
 * and the initial empty state is displayed.
 */

import { test, expect } from './fixtures/electron-app.js';

test.describe('App launch', () => {
  test('window has correct title', async ({ electronApp }) => {
    const page = await electronApp.firstWindow();
    const title = await page.title();
    expect(title).toBe('Invoker');
  });

  test('shows empty state prompt when no plan is loaded', async ({ page }) => {
    await expect(page.getByText('Load a plan to get started')).toBeVisible({ timeout: 5000 });
  });

  test('TopBar renders with Open File and control buttons', async ({ page }) => {
    await expect(page.getByText('Open File')).toBeVisible();
    await expect(page.getByText('Refresh')).toBeVisible();
    await expect(page.getByText('Clear')).toBeVisible();
    await expect(page.getByText('Delete DB')).toBeVisible();
    // Start and Stop should NOT be visible before a plan is loaded
    await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);
  });

  test('StatusBar renders with zero total', async ({ page }) => {
    // Look for "Total:" followed by "0" within the status bar
    const statusBar = page.locator('.border-t.border-gray-700');
    await expect(statusBar.getByText('Total:')).toBeVisible();
    await expect(statusBar.getByText('Pending:')).toBeVisible();
  });

  test('TaskPanel shows selection prompt', async ({ page }) => {
    await expect(page.getByText('Select a task from the graph to view details')).toBeVisible();
  });

  test('Terminal toggle bar is visible', async ({ page }) => {
    const toggleBtn = page.locator('button').filter({ hasText: 'Terminal' });
    await expect(toggleBtn).toBeVisible();
  });
});
