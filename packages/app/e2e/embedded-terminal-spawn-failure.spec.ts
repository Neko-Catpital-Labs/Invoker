import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';
import {
  activityLogWatermark,
  maxPayloadNumber,
  numberOrZero,
  uiPerfPayloadsSince,
} from './fixtures/ui-perf.js';

const SPAWN_FAILURE_OPEN_WALL_BUDGET_MS = 3000;
const SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS = 1000;
const SPAWN_FAILURE_RENDERER_EVENT_LOOP_LAG_BUDGET_MS = 1000;
const SPAWN_FAILURE_RENDERER_LONG_TASK_BUDGET_MS = 1500;

const SPAWN_FAILURE_RESPONSIVENESS_BUDGETS = {
  maxOpenFailureWallMs: SPAWN_FAILURE_OPEN_WALL_BUDGET_MS,
  maxDrawerCycleWallMs: SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS,
  maxRendererEventLoopLagMs: SPAWN_FAILURE_RENDERER_EVENT_LOOP_LAG_BUDGET_MS,
  maxRendererLongTaskMs: SPAWN_FAILURE_RENDERER_LONG_TASK_BUDGET_MS,
};

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

    const watermark = await activityLogWatermark(page);
    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="spawn-fail"]')
      .first();
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('spawn-fail task node has no bounding box');
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
    const openFailureWallMs = Date.now() - openStartedAt;
    expect(dialogs[0]).toContain('Failed to start terminal session');
    expect(dialogs[0]).toContain('posix_spawnp failed');
    await expect(page.getByTestId('terminal-session-command')).toHaveCount(0);
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
    await expect(page.getByTestId('terminal-drawer-body')).toContainText('Open a terminal from a task to attach.');

    const maximizeStartedAt = Date.now();
    await page.getByRole('button', { name: 'Maximize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    const maximizeWallMs = Date.now() - maximizeStartedAt;
    const minimizeStartedAt = Date.now();
    await page.getByRole('button', { name: 'Minimize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');
    const minimizeWallMs = Date.now() - minimizeStartedAt;

    const payloads = await uiPerfPayloadsSince(page, watermark);
    const perf = await page.evaluate(async () => window.invoker.getUiPerfStats());
    const attachCount = payloads.filter((payload) => payload.metric === 'embedded_terminal_attach').length;
    const spawnFailureEvidence = {
      openFailureWallMs,
      maximizeWallMs,
      minimizeWallMs,
      dialogs,
      attachCount,
      payloads,
      perf,
      budgets: SPAWN_FAILURE_RESPONSIVENESS_BUDGETS,
    };
    console.log(`EMBEDDED_TERMINAL_SPAWN_FAILURE_RESPONSIVENESS_RESULT=${JSON.stringify(spawnFailureEvidence)}`);
    const spawnFailureEvidenceMessage = JSON.stringify(spawnFailureEvidence);

    expect(attachCount, spawnFailureEvidenceMessage).toBe(0);
    expect(openFailureWallMs, spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_OPEN_WALL_BUDGET_MS);
    expect(maximizeWallMs, spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS);
    expect(minimizeWallMs, spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_DRAWER_CYCLE_BUDGET_MS);
    expect(numberOrZero(perf.maxRendererEventLoopLagMs), spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_RENDERER_EVENT_LOOP_LAG_BUDGET_MS);
    expect(numberOrZero(perf.maxRendererLongTaskMs), spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_RENDERER_LONG_TASK_BUDGET_MS);
    expect(maxPayloadNumber(payloads, 'renderer_event_loop_lag', 'lagMs'), spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_RENDERER_EVENT_LOOP_LAG_BUDGET_MS);
    expect(maxPayloadNumber(payloads, 'renderer_long_task', 'durationMs'), spawnFailureEvidenceMessage).toBeLessThanOrEqual(SPAWN_FAILURE_RENDERER_LONG_TASK_BUDGET_MS);
  });
});
