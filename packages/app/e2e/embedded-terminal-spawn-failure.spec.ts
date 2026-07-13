import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';

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
    await taskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    // The spawn failure must surface as a visible alert, not a silently
    // rejected IPC promise that leaves the terminal drawer blank.
    await expect.poll(() => dialogs.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(dialogs[0]).toContain('Failed to start terminal session');
    expect(dialogs[0]).toContain('posix_spawnp failed');
    await expect(page.getByTestId('terminal-session-command')).toHaveCount(0);
  });
});
