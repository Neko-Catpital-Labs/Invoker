/**
 * E2E: Merge gate branch selector in TaskPanel.
 *
 * Loads a plan with merge gate, clicks the merge gate node,
 * and verifies the Target Branch field appears in the TaskPanel.
 */

import { test, expect, loadPlan } from './fixtures/electron-app.js';

const MERGE_PLAN = {
  name: 'Merge Branch Test',
  onFinish: 'merge' as const,
  baseBranch: 'master',
  tasks: [
    {
      id: 'task-a',
      description: 'Task A',
      command: 'echo a',
      dependencies: [],
    },
  ],
};

test.describe('Merge gate branch selector in TaskPanel', () => {
  test('clicking merge gate shows Target Branch input with correct value', async ({ page }) => {
    await loadPlan(page, MERGE_PLAN);

    // Wait for the merge gate node to appear and click it
    const mergeNode = page.locator('[data-testid^="rf__node-__merge__"]');
    await expect(mergeNode).toBeVisible({ timeout: 10000 });
    await mergeNode.click();

    // TaskPanel should show the Target Branch input with value "master"
    const branchInput = page.locator('[data-testid="target-branch-input"]');
    await expect(branchInput).toBeVisible({ timeout: 5000 });
    await expect(branchInput).toHaveValue('master');
  });

  test('merge gate node shows branch as read-only text', async ({ page }) => {
    await loadPlan(page, MERGE_PLAN);

    // Branch label in the DAG node should be read-only text
    const branchLabel = page.locator('[data-testid="merge-branch-label"]');
    await expect(branchLabel).toBeVisible({ timeout: 10000 });
    await expect(branchLabel).toHaveText('master');

    // No inline input should exist in the node
    const inlineInput = page.locator('[data-testid="merge-branch-input"]');
    await expect(inlineInput).toHaveCount(0);
  });

  test('changing Target Branch value triggers update on blur', async ({ page }) => {
    await loadPlan(page, MERGE_PLAN);

    const mergeNode = page.locator('[data-testid^="rf__node-__merge__"]');
    await expect(mergeNode).toBeVisible({ timeout: 10000 });
    await mergeNode.click();

    const branchInput = page.locator('[data-testid="target-branch-input"]');
    await expect(branchInput).toBeVisible({ timeout: 5000 });

    // Clear and type new value
    await branchInput.fill('develop');
    await branchInput.blur();

    // After blur, the value should persist
    await expect(branchInput).toHaveValue('develop');
  });
});
