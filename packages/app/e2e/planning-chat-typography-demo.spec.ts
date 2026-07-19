import { test, expect, captureScreenshot } from './fixtures/electron-app.js';

const RUNNING_ACTIONS_PLAN = `name: Running Actions Sidebar
onFinish: none
mergeMode: manual
repoUrl: https://github.com/Neko-Catpital-Labs/Invoker.git
tasks:
  - id: define-surface
    description: Add Running Actions entry to the left sidebar Library
    command: echo define-surface
    files:
      packages/ui/src/components/LeftStatusColumn.tsx: modify
    dependsOn: []
  - id: queue-panel
    description: Build Running Actions panel listing active worker/task actions
    command: echo queue-panel
    files:
      packages/ui/src/components/RunningActionsPanel.tsx: create
      packages/ui/src/App.tsx: modify
    dependsOn:
      - define-surface
  - id: wire-status
    description: Wire panel to queue/worker status IPC and attention badges
    command: echo wire-status
    files:
      packages/ui/src/App.tsx: modify
      packages/ui/src/hooks/useQueueStatus.ts: modify
    dependsOn:
      - queue-panel
`;

test.describe('Planning chat typography demo', () => {
  test('running actions sidebar planning session', async ({ page }) => {
    test.setTimeout(240_000);

    const reply = [
      'Good direction. A **Running Actions** surface in the Library would sit beside Needs Attention / Workers / Workflows and show in-flight launches without leaving Home.',
      '',
      'I drafted a focused plan. Review the tasks below — we are **not** submitting yet.',
      '',
      'Gates stay the same: discuss → draft → you review on the graph → Start ready work.',
    ].join('\n');

    await page.evaluate(async ({ planYaml, replyText }) => {
      await window.invoker.setTestPlanningChatResponse({
        planYaml,
        planName: 'Running Actions Sidebar',
        reply: replyText,
      });
    }, { planYaml: RUNNING_ACTIONS_PLAN, replyText: reply });

    await page.getByTestId('sidebar-home').click();
    await expect(page.getByRole('heading', { name: 'Planning chat' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('invoker-terminal-input')).toBeVisible();
    await expect(page.getByTestId('planning-context-panel')).toBeVisible();
    await expect(page.getByTestId('planning-context-panel')).toHaveClass(/w-16/);
    await expect(page.getByTestId('planning-context-panel')).not.toContainText('Phase');
    await expect(page.getByTestId('planning-context-panel')).not.toContainText('Discuss');
    await expect(page.getByTestId('planning-context-panel')).not.toContainText('Review');
    await expect(page.getByTestId('invoker-terminal-harness')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Chat' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Tmux' })).toBeVisible();
    await page.waitForTimeout(2500);
    await captureScreenshot(page, 'demo-planning-empty');

    const input = page.getByTestId('invoker-terminal-input');
    const prompt =
      'Plan a Running Actions surface on the left sidebar (Library) that shows currently running worker/task actions without leaving Home. Draft YAML tasks, but do not submit yet.';
    await input.click();
    await page.waitForTimeout(700);
    await input.pressSequentially(prompt, { delay: 30 });
    await page.waitForTimeout(1200);
    await captureScreenshot(page, 'demo-planning-composer');

    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('invoker-terminal-ready-bar')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('invoker-terminal-transcript')).toContainText('Running Actions', {
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Review draft' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toHaveCount(0);

    const contextPanel = page.getByTestId('planning-context-panel');
    await expect(contextPanel).toHaveClass(/w-16/);
    await expect(contextPanel).not.toContainText('Phase');
    await expect(contextPanel).not.toContainText('● Draft');
    await expect(contextPanel).not.toContainText('○ Run');

    await page.waitForTimeout(2500);
    await captureScreenshot(page, 'demo-planning-draft-ready');

    await page.getByText('View YAML').click();
    await expect(page.getByTestId('invoker-terminal-transcript').locator('pre code')).toContainText(
      'name: Running Actions Sidebar',
      { timeout: 10_000 },
    );
    await page.getByTestId('invoker-terminal-transcript').locator('pre code').scrollIntoViewIfNeeded();
    await page.waitForTimeout(3000);
    await captureScreenshot(page, 'demo-planning-yaml');

    await page.getByRole('button', { name: 'Review draft' }).hover();
    await page.waitForTimeout(2500);
    await captureScreenshot(page, 'demo-planning-draft-ready-hover');

    await page.getByRole('button', { name: 'Review draft' }).click();
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await expect(page.getByTestId('planning-create-workflow')).toBeVisible();
    await page.waitForTimeout(2000);
    await captureScreenshot(page, 'demo-planning-review-draft');

    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });
});
