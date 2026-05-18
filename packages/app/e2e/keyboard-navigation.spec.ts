import { test, expect, TEST_PLAN, loadPlan } from './fixtures/electron-app.js';

test.describe('keyboard-first navigation', () => {
  test('opens workflow and task context menus without the mouse', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toContainText('Open Workflow');
    await page.keyboard.press('Escape');

    await page.keyboard.press('Shift');
    await page.keyboard.press('Shift');
    await page.getByTestId('keyboard-search-input').fill('Second test task');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('workflow-inspector-title')).toContainText('Second test task');

    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toContainText('Open Terminal');
  });

  test('search jumps to workflows and tasks from the keyboard', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.keyboard.press('Shift');
    await page.keyboard.press('Shift');
    await page.getByTestId('keyboard-search-input').fill('E2E Test Plan');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('selected-workflow-mini-dag')).toContainText('E2E Test Plan task DAG');

    await page.keyboard.press('Shift');
    await page.keyboard.press('Shift');
    await page.getByTestId('keyboard-search-input').fill('Second test task');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('workflow-inspector-title')).toContainText('Second test task');
  });

  test('expands and collapses the bottom drawer from the keyboard', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible();

    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('terminal-drawer-body')).toBeHidden();
  });
});
