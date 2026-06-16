import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';

const CODEX_RESUME_PLAN = {
  name: 'Embedded PTY Resume',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'codex-resume',
      description: 'Completed Codex resume task',
      command: 'echo unused',
      executionAgent: 'codex',
      dependencies: [],
    },
  ],
};

const CLAUDE_RESUME_PLAN = {
  name: 'Embedded Claude PTY Resume',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'claude-resume',
      description: 'Completed Claude resume task',
      command: 'echo unused',
      executionAgent: 'claude',
      dependencies: [],
    },
  ],
};

test.describe('Embedded terminal PTY', () => {
  test('completed Codex resume terminal gets a real TTY in the drawer', async ({ page, testDir }) => {
    await loadPlan(page, CODEX_RESUME_PLAN);
    const workspacePath = path.join(testDir, 'codex-resume-workspace');
    mkdirSync(workspacePath, { recursive: true });
    const agentSessionId = 'codex-session-e2e-tty';
    const sessionDir = path.join(testDir, 'agent-sessions');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, `${agentSessionId}.jsonl`),
      '{"type":"thread.started","thread_id":"codex-session-e2e-tty"}\n{"type":"task_complete","last_agent_message":"done"}\n',
      'utf8',
    );

    await injectTaskStates(page, [
      {
        taskId: 'codex-resume',
        changes: {
          status: 'completed',
          config: {
            runnerKind: 'worktree',
            executionAgent: 'codex',
          },
          execution: {
            workspacePath,
            agentSessionId,
            lastAgentSessionId: agentSessionId,
            agentName: 'codex',
            lastAgentName: 'codex',
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
    ]);

    const tasksResult = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    const task = tasks.find((candidate) => candidate.id.endsWith('/codex-resume'));
    const fullTaskId = task?.id;
    expect(fullTaskId).toBeTruthy();
    expect(task?.execution?.agentSessionId).toBe(agentSessionId);
    expect(task?.execution?.agentName).toBe('codex');

    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="codex-resume"]')
      .first();
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('Codex resume task node has no bounding box');
    await taskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('terminal-session-command')).toContainText('codex');
    await expect(page.getByTestId('terminal-session-command')).toContainText(`resume ${agentSessionId}`);
    const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
    await expect(terminalPane).toBeVisible();
    await expect(terminalPane.getByText(`TTY OK: codex resume ${agentSessionId}`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('stdin is not a terminal')).toHaveCount(0);
    await expect(page.getByText('No deferred tool marker found')).toHaveCount(0);
  });

  test('completed Claude resume terminal gets a real TTY in the drawer', async ({ page, testDir }) => {
    await loadPlan(page, CLAUDE_RESUME_PLAN);
    const workspacePath = path.join(testDir, 'claude-resume-workspace');
    mkdirSync(workspacePath, { recursive: true });
    const agentSessionId = 'claude-session-e2e-tty';

    await injectTaskStates(page, [
      {
        taskId: 'claude-resume',
        changes: {
          status: 'completed',
          config: {
            runnerKind: 'worktree',
            executionAgent: 'claude',
          },
          execution: {
            workspacePath,
            agentSessionId,
            lastAgentSessionId: agentSessionId,
            agentName: 'claude',
            lastAgentName: 'claude',
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
    ]);

    const tasksResult = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    const task = tasks.find((candidate) => candidate.id.endsWith('/claude-resume'));
    const fullTaskId = task?.id;
    expect(fullTaskId).toBeTruthy();
    expect(task?.execution?.agentSessionId).toBe(agentSessionId);
    expect(task?.execution?.agentName).toBe('claude');

    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="claude-resume"]')
      .first();
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('Claude resume task node has no bounding box');
    await taskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('terminal-session-command')).toContainText('--resume');
    await expect(page.getByTestId('terminal-session-command')).toContainText(agentSessionId);
    await expect(page.getByTestId('terminal-session-command')).toContainText('--dangerously-skip-permissions');
    const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
    await expect(terminalPane).toBeVisible();
    await expect(terminalPane.getByText(`TTY OK: claude resume ${agentSessionId}`)).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('stdin is not a terminal')).toHaveCount(0);
    await expect(page.getByText('No deferred tool marker found')).toHaveCount(0);
  });
});
