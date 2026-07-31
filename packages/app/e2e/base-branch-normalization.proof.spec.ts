import type { Page } from '@playwright/test';
import { test, expect, captureScreenshot, loadPlan } from './fixtures/electron-app.js';

const EXPLICIT_BASE_BRANCH_PLAN = {
  name: 'Explicit base branch proof',
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

const DEFAULT_BASE_BRANCH_PLAN = {
  name: 'Default base branch proof',
  repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review' as const,
  tasks: [
    {
      id: 'default-base-branch-proof-task',
      description: 'Single task to generate merge gate',
      command: 'echo proof',
      dependencies: [] as string[],
    },
  ],
};

test('loading an explicit non-master plan base shows the preserved value', async ({ page }) => {
  await loadPlan(page, EXPLICIT_BASE_BRANCH_PLAN);
  await expectMergeGateBaseRef(page, 'base-branch-proof-task', 'release');

  await captureScreenshot(page, 'base-branch-preserved-release');
});

test('loading a plan without baseBranch defaults the merge gate to master', async ({ page }) => {
  await loadPlan(page, DEFAULT_BASE_BRANCH_PLAN);
  await expectMergeGateBaseRef(page, 'default-base-branch-proof-task', 'master');

  await captureScreenshot(page, 'base-branch-defaulted-to-master');
});

async function expectMergeGateBaseRef(page: Page, taskIdSuffix: string, expectedBaseRef: string): Promise<void> {
  await page.locator(`.react-flow__node[data-testid$="${taskIdSuffix}"]`).first().waitFor({ state: 'visible', timeout: 15000 });

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
  await expect(page.getByTestId('base-ref-input')).toHaveValue(expectedBaseRef);
}
