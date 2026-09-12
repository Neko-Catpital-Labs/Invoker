import {
  test,
  expect,
  loadPlan,
  startPlan,
  waitForTaskStatus,
  E2E_REPO_URL,
  getTasks,
  findTaskByIdSuffix,
} from './fixtures/electron-app.js';

const PLAN = {
  name: 'E2E Codex Spend Gate Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'gated-codex-task',
      description: 'Codex task blocked by the daily spend gate',
      prompt: 'Repair the failing CI job',
      executionAgent: 'codex',
      dependencies: [],
    },
  ],
};

test.use({ codexSpendGateTripped: true, repoConfig: { autoFixRetries: 0, autoApproveAIFixes: false } });

test.describe('Codex daily spend gate', () => {
  test('a tripped gate fails the Codex task in the app owner', async ({ page }) => {
    await loadPlan(page, PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'gated-codex-task', 'failed', 60000);

    const node = page.locator('.react-flow__node[data-testid$="/gated-codex-task"]');
    await expect(node.locator('text=FAILED')).toBeVisible({ timeout: 10000 });

    const task = findTaskByIdSuffix(await getTasks(page), 'gated-codex-task');
    const errorText = JSON.stringify(task ?? {});
    expect(errorText).toContain('every Codex request fails');
    expect(errorText).toContain('invoker-cli spend-gate reset');

    if (process.env.INVOKER_CODEX_SPEND_GATE_PROOF_DIR) {
      await node.click();
      await page.waitForTimeout(1000);
      await page.screenshot({
        path: `${process.env.INVOKER_CODEX_SPEND_GATE_PROOF_DIR}/codex-spend-gate-task-failed.png`,
        fullPage: false,
      });
    }
  });
});
