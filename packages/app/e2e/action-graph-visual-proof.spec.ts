import {
  test,
  expect,
  TEST_PLAN,
  captureScreenshot,
} from './fixtures/electron-app.js';
import { stringify as yamlStringify } from 'yaml';

test.describe('Action Graph visual proof', () => {
  test('action graph diagnostics view', async ({ page }) => {
    await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(TEST_PLAN));
    await page.waitForFunction(async () => {
      const graph = await window.invoker.getActionGraph();
      return graph.nodes.length > 0;
    });

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await page.getByTestId('graph-more-button').click();
    await expect(page.getByTestId('graph-more-menu')).toBeVisible();
    await page.getByTestId('rail-action-graph').click();
    await expect(page.getByTestId('action-graph-view')).toBeVisible();
    await expect(
      page.getByTestId('action-graph-node-action:wf-test-1').getByText('E2E Test Plan', { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('action-graph-node-attempt:wf-test-1/task-alpha')).toBeVisible();
    await page.getByTestId('action-graph-node-attempt:wf-test-1/task-alpha').click();
    await expect(page.getByTestId('workflow-inspector-title')).toHaveText('First test task');

    await captureScreenshot(page, 'action-graph-diagnostics-view');
  });
});
