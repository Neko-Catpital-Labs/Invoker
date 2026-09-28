import {
  E2E_REPO_URL,
  captureScreenshot,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';

const PLAN = {
  name: 'Fix Failure Banner',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'latency-storm',
      description: 'Parallel plan intake storm latency budget',
      command: 'pnpm test',
      dependencies: [],
    },
  ],
};

const TASK_ERROR = 'AssertionError: p95=865.2ms budget=200ms lost=none doubled=none timedOut=none nonZero=none';

test.describe('Fix failure banner', () => {
  test('a fix that hit a usage limit shows in its own box above the unchanged task error', async ({ page }) => {
    await loadPlan(page, PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'latency-storm',
        changes: {
          status: 'failed',
          execution: {
            error: TASK_ERROR,
            exitCode: 1,
            completedAt: new Date('2026-09-27T13:23:00.000Z'),
            lastFixFailure: {
              agent: 'claude',
              failureClass: 'agent-usage-limit',
              message: "SSH remote script failed (exit=1, phase=remote_agent_fix)\nSTDOUT:\nYou've hit your weekly limit · resets Oct 1, 1am (UTC)",
              resetsAt: new Date('2026-10-01T01:00:00.000Z'),
              at: new Date('2026-09-27T13:23:00.000Z'),
            },
          },
        },
      },
    ]);

    await page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="latency-storm"]')
      .first()
      .click();

    const banner = page.getByTestId('fix-failure-banner');
    await expect(banner).toContainText("Auto-fix couldn't run", { timeout: 15000 });
    await expect(page.getByTestId('fix-failure-headline')).toContainText('claude hit its usage limit · resets');
    await expect(page.getByText(TASK_ERROR)).toBeVisible();
    await expect(page.getByText(/Fix with Agent failed/)).toHaveCount(0);

    await captureScreenshot(page, 'fix-failure-banner');
  });
});
