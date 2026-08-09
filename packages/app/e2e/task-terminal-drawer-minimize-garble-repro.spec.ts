/**
 * Reproduces the same bug class one more time: TerminalDrawer.tsx used to
 * unmount its entire body (every open task terminal, not just one) whenever
 * the drawer was minimized (`{showBody && (...)}`, showBody = state !==
 * 'minimized'). Minimizing then restoring the drawer destroyed and
 * recreated every xterm.js Terminal, replaying each session's raw output
 * log into a fresh instance.
 *
 * Fixed by keeping the body always mounted and toggling `display: none`
 * instead (mirroring the fix already applied to the planning terminal and
 * the App.tsx surface router). This spec proves it the same rigorous way:
 * capture the terminal's actual rendered buffer text, minimize/restore,
 * compare.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { E2E_REPO_URL, expect, injectTaskStates, loadPlan, test } from './fixtures/electron-app.js';

const SCROLLBACK_PLAN = {
  name: 'Task Terminal Drawer Minimize Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'drawer-minimize-task',
      description: 'Completed task for drawer minimize repro',
      command: 'echo unused',
      dependencies: [],
    },
  ],
};

async function readTaskTerminalBufferText(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate((targetSessionId) => {
    const term = window.__INVOKER_TEST_TASK_TERMINALS__?.get(targetSessionId);
    if (!term) return null;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  }, sessionId);
}

async function readOutputSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.terminalList();
    return sessions.find((session) => session.sessionId === targetSessionId)?.outputSnapshot ?? '';
  }, sessionId);
}

async function writeToTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, payload }) => {
    return window.invoker.terminalWrite(targetSessionId, payload);
  }, { targetSessionId: sessionId, payload: data });
  expect(result).toMatchObject({ ok: true });
}

const FRAME_MARKER = 'FULLSCREEN_FRAME_READY';
const DRAW_FULL_SCREEN_FRAME =
  "printf '\\033[2J\\033[H'" +
  "; printf '\\033[3;5HTOP LEFT FRAME'" +
  "; printf '\\033[10;20HBOTTOM RIGHT FRAME'" +
  `; printf '\\033[24;1H${FRAME_MARKER}'` +
  // Keep the shell prompt from repainting/reflowing during the legitimate
  // drawer PTY resize; this repro is about preserving the frame.
  '; sleep 3600' +
  '\n';

test.describe('Task terminal drawer minimize garble repro', () => {
  test('task terminal keeps the same rendered content across a minimize -> restore round trip', async ({ page, testDir }) => {
    await loadPlan(page, SCROLLBACK_PLAN);
    const workspacePath = path.join(testDir, 'drawer-minimize-workspace');
    mkdirSync(workspacePath, { recursive: true });

    await injectTaskStates(page, [
      {
        taskId: 'drawer-minimize-task',
        changes: {
          status: 'completed',
          execution: { workspacePath, completedAt: new Date('2025-01-01T00:00:00.000Z') },
        },
      },
    ]);

    const tasksResult = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    const task = tasks.find((candidate) => candidate.id.endsWith('/drawer-minimize-task'));
    const fullTaskId = task?.id;
    expect(fullTaskId).toBeTruthy();

    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="drawer-minimize-task"]')
      .first();
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('drawer-minimize-task node has no bounding box');
    await taskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
    const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
    await expect(terminalPane).toBeVisible({ timeout: 10000 });
    const sessionId = await terminalPane.getAttribute('data-session-id');
    expect(sessionId).toBeTruthy();

    await writeToTerminal(page, sessionId!, DRAW_FULL_SCREEN_FRAME);
    await expect.poll(async () => readOutputSnapshot(page, sessionId!), { timeout: 10000 }).toContain(FRAME_MARKER);
    await page.waitForTimeout(300);

    const renderedBefore = await readTaskTerminalBufferText(page, sessionId!);
    expect(renderedBefore, 'expected the test hook to expose the live task terminal').not.toBeNull();

    // The single cycle button only goes minimized -> partial -> maximized ->
    // minimized; from the initial 'partial' state, reach 'minimized' via
    // 'maximized' first. This used to unmount the terminal body entirely.
    await page.getByRole('button', { name: 'Maximize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    await page.getByRole('button', { name: 'Minimize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'minimized');
    await page.waitForTimeout(300);

    // Restore it.
    await page.getByRole('button', { name: 'Partial terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial');
    await expect(terminalPane).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(300);

    const sessionIdAfter = await terminalPane.getAttribute('data-session-id');
    const renderedAfter = await readTaskTerminalBufferText(page, sessionId!);

    expect(sessionIdAfter, 'the drawer must keep attaching to the same backend session after minimize/restore').toBe(sessionId);
    expect(renderedAfter, 'the rendered terminal content must be identical after a minimize -> restore round trip').toBe(renderedBefore);
  });
});
