import { test, expect, captureScreenshot, loadPlan } from './fixtures/electron-app.js';

const BASE_BRANCH_NORMALIZATION_PLAN = {
  name: 'Base branch normalization proof',
  repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
  baseBranch: 'release',
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review' as const,
  tasks: [
    {
      id: 'base-branch-proof-task',
      description: 'Single task to generate merge gate',
      command: 'echo proof',
      dependencies: [] as string[],
    },
  ],
};

test('loading a non-master plan base shows the normalized master value', async ({ page }) => {
  await loadPlan(page, BASE_BRANCH_NORMALIZATION_PLAN);
  await page.locator('.react-flow__node[data-testid$="base-branch-proof-task"]').first().waitFor({ state: 'visible', timeout: 15000 });

  const mergeGateTaskId = await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    const mergeTask = tasks.find((task: { id: string }) => task.id.includes('__merge__'));
    return mergeTask?.id ?? null;
  });
  expect(mergeGateTaskId).toBeTruthy();

  const mergeGateNode = page.locator(`.react-flow__node[data-testid="${mergeGateTaskId}"], .react-flow__node[data-testid$="${mergeGateTaskId}"]`).first();
  await expect(mergeGateNode).toBeVisible({ timeout: 15000 });
  await mergeGateNode.click();

  await expect(page.getByTestId('workflow-inspector-title')).toBeVisible();
  await expect(page.getByText('Base Ref')).toBeVisible();
  await expect(page.getByTestId('base-ref-input')).toHaveValue('master');

  await captureScreenshot(page, 'base-branch-normalized-to-master');
});
