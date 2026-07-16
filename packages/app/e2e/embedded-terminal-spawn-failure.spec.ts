import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';
import { activityLogWatermark, uiPerfPayloadsSince } from './fixtures/ui-perf.js';

const SPAWN_FAILURE_OPEN_WALL_BUDGET_MS = 2000;
const SPAWN_FAILURE_OPEN_REQUEST_BUDGET_MS = 2000;
const SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS = 250;

const SPAWN_FAIL_PLAN = {
  name: 'Embedded PTY Spawn Failure',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'spawn-fail',
      description: 'Completed task whose terminal backend cannot spawn',
      command: 'echo unused',
      dependencies: [],
    },
  ],
};

test.describe('Embedded terminal spawn failure', () => {
  // Inject the synchronous spawn throw node-pty produces when its
  // spawn-helper binary loses its exec bit (how node-pty@1.1.0 ships).
  test.use({ breakTerminalSpawn: true });

  test('a terminal spawn failure surfaces a visible error instead of a blank terminal', async ({ page, testDir }) => {
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      dialog.dismiss().catch(() => {});
    });

    await loadPlan(page, SPAWN_FAIL_PLAN);
    const workspacePath = path.join(testDir, 'spawn-fail-workspace');
    mkdirSync(workspacePath, { recursive: true });

    await injectTaskStates(page, [
      {
        taskId: 'spawn-fail',
        changes: {
          status: 'completed',
          config: { runnerKind: 'worktree' },
          execution: {
            workspacePath,
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
    ]);

    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="spawn-fail"]')
      .first();
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('spawn-fail task node has no bounding box');
    const watermark = await activityLogWatermark(page);
    const openStartedAt = Date.now();
    await taskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    // The spawn failure must surface as a visible alert, not a silently
    // rejected IPC promise that leaves the terminal drawer blank.
    await expect.poll(() => dialogs.length, { timeout: 10000 }).toBeGreaterThan(0);
    const openWallMs = Date.now() - openStartedAt;
    expect(dialogs[0]).toContain('Failed to start terminal session');
    expect(dialogs[0]).toContain('posix_spawnp failed');
    await expect(page.getByTestId('terminal-session-command')).toHaveCount(0);
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
    await expect(page.getByTestId('terminal-drawer-body')).toContainText('Open a terminal from a task to attach.');

    await page.getByRole('button', { name: 'Maximize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    await page.getByRole('button', { name: 'Minimize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');

    await expect
      .poll(async () => {
        const payloads = await uiPerfPayloadsSince(page, watermark);
        const hasRejectedOpen = payloads.some((payload) =>
          payload.metric === 'embedded_terminal_open_request'
          && String(payload.taskId).endsWith('spawn-fail')
          && payload.result === 'rejected'
        );
        const drawerCycleCount = payloads.filter((payload) => payload.metric === 'embedded_terminal_drawer_cycle').length;
        return hasRejectedOpen && drawerCycleCount >= 2;
      }, { timeout: 5000 })
      .toBe(true);

    const payloads = await uiPerfPayloadsSince(page, watermark);
    const openPayload = payloads.find((payload) =>
      payload.metric === 'embedded_terminal_open_request'
      && String(payload.taskId).endsWith('spawn-fail')
      && payload.result === 'rejected'
    );
    const drawerCyclePayloads = payloads.filter((payload) => payload.metric === 'embedded_terminal_drawer_cycle');
    const attachCount = payloads.filter((payload) => payload.metric === 'embedded_terminal_attach').length;
    const evidence = {
      openWallMs,
      openPayload,
      drawerCyclePayloads,
      attachCount,
      budgets: {
        maxOpenWallMs: SPAWN_FAILURE_OPEN_WALL_BUDGET_MS,
        maxOpenRequestMs: SPAWN_FAILURE_OPEN_REQUEST_BUDGET_MS,
        maxDrawerCycleMs: SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS,
      },
    };
    console.log(`EMBEDDED_TERMINAL_SPAWN_FAILURE_BENCH_RESULT=${JSON.stringify(evidence)}`);
    const evidenceMessage = JSON.stringify(evidence);
    expect(openPayload, evidenceMessage).toBeTruthy();
    expect(String(openPayload?.reason), evidenceMessage).toContain('posix_spawnp failed');
    expect(Number(openPayload?.durationMs), evidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_OPEN_REQUEST_BUDGET_MS);
    expect(openWallMs, evidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_OPEN_WALL_BUDGET_MS);
    expect(drawerCyclePayloads.length, evidenceMessage).toBeGreaterThanOrEqual(2);
    expect(
      drawerCyclePayloads.some((payload) => payload.previousState === 'partial' && payload.nextState === 'maximized'),
      evidenceMessage,
    ).toBe(true);
    expect(
      drawerCyclePayloads.some((payload) => payload.previousState === 'maximized' && payload.nextState === 'minimized'),
      evidenceMessage,
    ).toBe(true);
    expect(Math.max(...drawerCyclePayloads.map((payload) => Number(payload.durationMs))), evidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS);
    expect(attachCount).toBe(0);
  });
});
