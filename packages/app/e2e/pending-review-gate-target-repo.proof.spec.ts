import { test, expect, captureScreenshot, loadPlan } from './fixtures/electron-app.js';

const REVIEW_GATE_PROOF_PLAN = {
  name: 'Pending review gate target repo proof',
  repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
  baseBranch: 'master',
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review' as const,
  tasks: [
    {
      id: 'review-gate-proof-task',
      description: 'Single task to generate merge gate',
      command: 'echo proof',
      dependencies: [] as string[],
    },
  ],
};

test('pending review gate target repo row', async ({ page }) => {
  await loadPlan(page, REVIEW_GATE_PROOF_PLAN);
  await page.locator('.react-flow__node[data-testid$="review-gate-proof-task"]').first().waitFor({ state: 'visible', timeout: 15000 });

  const mergeGateTaskId = await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    const mergeTask = tasks.find((task: { id: string }) => task.id.includes('__merge__'));
    return mergeTask?.id ?? null;
  });
  expect(mergeGateTaskId).toBeTruthy();
  const workflowId = String(mergeGateTaskId).replace('__merge__', '');
  await page.evaluate(
    async ({ workflowId: wf }) => {
      await window.invoker.setMergeBranch(wf, 'master');
    },
    { workflowId },
  );

  const mergeGateNode = page.locator(`.react-flow__node[data-testid="${mergeGateTaskId}"], .react-flow__node[data-testid$="${mergeGateTaskId}"]`).first();
  await expect(mergeGateNode).toBeVisible({ timeout: 15000 });
  await mergeGateNode.click();

  await expect(page.getByTestId('workflow-inspector-title')).toBeVisible();
  await expect(page.getByText('Target Branch')).toBeVisible();
  await expect(page.getByTestId('target-branch-input')).toHaveValue('master');
  await expect(page.getByText('PR target repo')).toBeVisible();
  await expect(page.getByText('github.com/Neko-Catpital-Labs/Invoker')).toBeVisible();

  await captureScreenshot(page, 'pending-review-gate-target-repo');
});

test('pending review gate merge mode selector', async ({ page }) => {
  await loadPlan(page, REVIEW_GATE_PROOF_PLAN);
  await page.locator('.react-flow__node[data-testid$="review-gate-proof-task"]').first().waitFor({ state: 'visible', timeout: 15000 });

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
  await expect(page.getByText('Merge mode')).toBeVisible();
  await expect(page.getByTestId('merge-mode-select')).toHaveValue('external_review');
  await expect(page.getByRole('option', { name: 'External review (GitHub)' })).toBeAttached();

  await captureScreenshot(page, 'pending-review-gate-merge-mode-selector');
});
