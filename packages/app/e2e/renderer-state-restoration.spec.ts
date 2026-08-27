import {
  captureScreenshot,
  expect,
  loadPlan,
  test,
  TEST_PLAN,
  waitForInvokerBridge,
} from './fixtures/electron-app.js';

test('reload restores the selected task and inspector', async ({ page }) => {
  await loadPlan(page, TEST_PLAN);

  const selectedTask = page.locator('.react-flow__node[data-testid$="task-beta"]').first();
  await selectedTask.click();
  await expect(selectedTask.locator('[data-selected="true"]')).toBeVisible();
  await expect(page.getByTestId('workflow-inspector-shell')).toContainText('Second test task depending on alpha');
  await captureScreenshot(page, 'renderer-state-before-reload');

  await page.reload();
  await waitForInvokerBridge(page);

  const restoredTask = page.locator('.react-flow__node[data-testid$="task-beta"]').first();
  await expect(restoredTask.locator('[data-selected="true"]')).toBeVisible();
  await expect(page.getByTestId('workflow-inspector-shell')).toContainText('Second test task depending on alpha');
  await captureScreenshot(page, 'renderer-state-after-reload');
});
