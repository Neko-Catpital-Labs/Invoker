import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  E2E_REPO_URL,
  expect,
  injectTaskStates,
  loadPlan,
  test,
} from './fixtures/electron-app.js';
import {
  activityLogWatermark,
  numberOrZero,
  uiPerfPayloadsSince,
} from './fixtures/ui-perf.js';

const TERMINAL_INPUT_BUDGET_MS = 100;
const TERMINAL_ATTACH_BUDGET_MS = 250;
const TERMINAL_OUTPUT_WRITE_BUDGET_MS = 250;
const TERMINAL_RESIZE_BUDGET_MS = 250;
const TERMINAL_SCROLL_BUDGET_MS = 50;
const TERMINAL_OPEN_WALL_BUDGET_MS = 2000;
const TERMINAL_TAB_SWITCH_WALL_BUDGET_MS = 1000;
const TERMINAL_SCROLL_WALL_BUDGET_MS = 2000;
const TERMINAL_SESSION_UPSERT_BUDGET_MS = 250;
const TERMINAL_RENDERER_EVENT_LOOP_LAG_BUDGET_MS = 1000;
const TERMINAL_RENDERER_LONG_TASK_BUDGET_MS = 1500;

const TERMINAL_PRESSURE_BUDGETS = {
  maxInputMs: TERMINAL_INPUT_BUDGET_MS,
  maxAttachMs: TERMINAL_ATTACH_BUDGET_MS,
  maxOutputWriteMs: TERMINAL_OUTPUT_WRITE_BUDGET_MS,
  maxResizeMs: TERMINAL_RESIZE_BUDGET_MS,
  maxScrollMs: TERMINAL_SCROLL_BUDGET_MS,
  maxOpenWallMs: TERMINAL_OPEN_WALL_BUDGET_MS,
  maxTabSwitchWallMs: TERMINAL_TAB_SWITCH_WALL_BUDGET_MS,
  maxScrollWallMs: TERMINAL_SCROLL_WALL_BUDGET_MS,
  maxTerminalSessionUpsertMs: TERMINAL_SESSION_UPSERT_BUDGET_MS,
  maxRendererEventLoopLagMs: TERMINAL_RENDERER_EVENT_LOOP_LAG_BUDGET_MS,
  maxRendererLongTaskMs: TERMINAL_RENDERER_LONG_TASK_BUDGET_MS,
};

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

const SCROLLBACK_PLAN = {
  name: 'Embedded PTY Scrollback',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'scrollback-task',
      description: 'Completed task with scrollback output',
      command: 'echo unused',
      dependencies: [],
    },
  ],
};

const RESPONSIVE_TERMINAL_PLAN = {
  name: 'Embedded PTY Responsiveness',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'terminal-pressure-alpha',
      description: 'Terminal pressure alpha',
      command: 'echo unused',
      dependencies: [],
    },
    {
      id: 'terminal-pressure-beta',
      description: 'Terminal pressure beta',
      command: 'echo unused',
      dependencies: ['terminal-pressure-alpha'],
    },
  ],
};

async function resolveTaskId(page: Page, taskIdSuffix: string): Promise<string> {
  const fullTaskId = await page.evaluate(async (suffix) => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    return tasks.find((candidate: { id: string }) => candidate.id.endsWith(`/${suffix}`) || candidate.id.endsWith(suffix))?.id ?? null;
  }, taskIdSuffix);
  if (!fullTaskId) throw new Error(`${taskIdSuffix} was not loaded`);
  return fullTaskId;
}

async function openTaskTerminalFromMiniDag(page: Page, taskIdSuffix: string): Promise<void> {
  const taskNode = page
    .getByTestId('selected-workflow-mini-dag')
    .locator(`.react-flow__node[data-testid$="${taskIdSuffix}"]`)
    .first();
  const box = await taskNode.boundingBox();
  if (!box) throw new Error(`${taskIdSuffix} task node has no bounding box`);
  await taskNode.locator('> div').dispatchEvent('dblclick', {
    bubbles: true,
    cancelable: true,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
}

test.describe('Embedded terminal PTY', () => {
  test('completed Codex resume terminal gets a real TTY in the drawer', async ({ page, testDir }) => {
    await loadPlan(page, CODEX_RESUME_PLAN);
    const workspacePath = path.join(testDir, 'codex-resume-workspace');
    mkdirSync(workspacePath, { recursive: true });
    const agentSessionId = 'codex-session-e2e-tty';
    const sessionDir = path.join(testDir, 'agent-sessions');
    mkdirSync(sessionDir, { recursive: true });
    const userPrompt = 'Design the checkout session API contract and OpenAPI types.';
    const agentReply = 'Checkout session contract drafted with OpenAPI types.';
    writeFileSync(
      path.join(sessionDir, `${agentSessionId}.jsonl`),
      [
        JSON.stringify({ type: 'thread.started', thread_id: agentSessionId }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'user_message', text: userPrompt },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: agentReply },
        }),
      ].join('\n') + '\n',
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
    await expect(page.getByTestId('terminal-session-command')).toContainText(agentSessionId);
    const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
    await expect(terminalPane).toBeVisible();
    if (process.env.INVOKER_E2E_CODEX_DEMO === '1') {
      // Demo stub must render THIS session's JSONL, not a shared hardcoded script.
      await expect(terminalPane.getByText(userPrompt)).toBeVisible({ timeout: 10000 });
      await expect(terminalPane.getByText(agentReply)).toBeVisible({ timeout: 5000 });
      await expect(terminalPane.getByText(`Codex session: ${agentSessionId}`)).toBeVisible({ timeout: 5000 });
    } else {
      await expect(terminalPane.getByText(`TTY OK: codex resume ${agentSessionId}`)).toBeVisible({ timeout: 10000 });
    }
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

  test('maximized drawer can scroll back through terminal history', async ({ page, testDir }) => {
    await loadPlan(page, SCROLLBACK_PLAN);
    const workspacePath = path.join(testDir, 'scrollback-workspace');
    mkdirSync(workspacePath, { recursive: true });

    await injectTaskStates(page, [
      {
        taskId: 'scrollback-task',
        changes: {
          status: 'completed',
          execution: {
            workspacePath,
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
    ]);

    const tasksResult = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    const task = tasks.find((candidate) => candidate.id.endsWith('/scrollback-task'));
    const fullTaskId = task?.id;
    expect(fullTaskId).toBeTruthy();

    const taskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="scrollback-task"]')
      .first();
    const box = await taskNode.boundingBox();
    if (!box) throw new Error('Scrollback task node has no bounding box');
    await taskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
    const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
    await expect(terminalPane).toBeVisible();
    await terminalPane.click();

    await page.keyboard.type('for i in $(seq 1 160); do printf "inv196-line-%03d\\n" "$i"; done');
    await page.keyboard.press('Enter');
    await expect(terminalPane.getByText('inv196-line-160')).toBeVisible({ timeout: 10000 });

    await page.getByRole('button', { name: 'Maximize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    await expect(page.getByTestId('terminal-drawer')).toHaveClass(/min-h-0/);
    await expect(page.getByTestId('terminal-drawer-body')).toHaveClass(/overflow-hidden/);
    await expect(terminalPane).toHaveClass(/overflow-hidden/);

    const firstLine = terminalPane.getByText('inv196-line-001');
    await expect(firstLine).not.toBeVisible();

    await terminalPane.hover();
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.wheel(0, -800);
      if (await firstLine.isVisible()) break;
    }
    await expect(firstLine).toBeVisible({ timeout: 10000 });
  });

  test('drawer interactions stay responsive while terminal output streams', async ({ page, testDir }) => {
    await loadPlan(page, RESPONSIVE_TERMINAL_PLAN);
    const alphaWorkspace = path.join(testDir, 'terminal-pressure-alpha-workspace');
    const betaWorkspace = path.join(testDir, 'terminal-pressure-beta-workspace');
    mkdirSync(alphaWorkspace, { recursive: true });
    mkdirSync(betaWorkspace, { recursive: true });

    await injectTaskStates(page, [
      {
        taskId: 'terminal-pressure-alpha',
        changes: {
          status: 'completed',
          execution: {
            workspacePath: alphaWorkspace,
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
      {
        taskId: 'terminal-pressure-beta',
        changes: {
          status: 'completed',
          execution: {
            workspacePath: betaWorkspace,
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
    ]);

    const fullAlphaTaskId = await resolveTaskId(page, 'terminal-pressure-alpha');
    const fullBetaTaskId = await resolveTaskId(page, 'terminal-pressure-beta');
    const watermark = await activityLogWatermark(page);

    const alphaOpenStartedAt = Date.now();
    await openTaskTerminalFromMiniDag(page, 'terminal-pressure-alpha');
    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
    const alphaPane = page.getByTestId(`terminal-pane-${fullAlphaTaskId}`);
    await expect(alphaPane).toBeVisible();
    const alphaOpenWallMs = Date.now() - alphaOpenStartedAt;
    await alphaPane.click();

    await page.keyboard.type('for i in $(seq 1 140); do printf "term-live-%03d\\n" "$i"; done');
    await page.keyboard.press('Enter');
    await expect(alphaPane.getByText('term-live-140')).toBeVisible({ timeout: 10000 });

    const betaOpenStartedAt = Date.now();
    await openTaskTerminalFromMiniDag(page, 'terminal-pressure-beta');
    await expect(page.getByTestId(`terminal-tab-${fullBetaTaskId}`)).toHaveAttribute('data-active', 'true', { timeout: 10000 });
    const betaOpenWallMs = Date.now() - betaOpenStartedAt;

    const switchStartedAt = Date.now();
    await page.getByRole('tab', { name: /Terminal pressure alpha/i }).click();
    await expect(page.getByTestId(`terminal-tab-${fullAlphaTaskId}`)).toHaveAttribute('data-active', 'true');
    const switchWallMs = Date.now() - switchStartedAt;

    await page.getByRole('button', { name: 'Maximize terminal drawer' }).click();
    await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'maximized');
    const firstLine = alphaPane.getByText('term-live-001');
    await expect(firstLine).not.toBeVisible();
    const scrollStartedAt = Date.now();
    await alphaPane.hover();
    for (let index = 0; index < 12; index += 1) {
      await page.mouse.wheel(0, -800);
      if (await firstLine.isVisible()) break;
    }
    await expect(firstLine).toBeVisible({ timeout: 10000 });
    const scrollWallMs = Date.now() - scrollStartedAt;

    await expect
      .poll(async () => {
        const payloads = await uiPerfPayloadsSince(page, watermark);
        return payloads.some((payload) => payload.metric === 'embedded_terminal_output_write')
          && payloads.some((payload) => payload.metric === 'embedded_terminal_scroll');
      }, { timeout: 5000 })
      .toBe(true);

    const payloads = await uiPerfPayloadsSince(page, watermark);
    const attachPayloads = payloads.filter((payload) => payload.metric === 'embedded_terminal_attach');
    const inputPayloads = payloads.filter((payload) => payload.metric === 'embedded_terminal_input');
    const outputPayloads = payloads.filter((payload) => payload.metric === 'embedded_terminal_output_write');
    const resizePayloads = payloads.filter((payload) => payload.metric === 'embedded_terminal_resize');
    const scrollPayloads = payloads.filter((payload) => payload.metric === 'embedded_terminal_scroll');
    const perf = await page.evaluate(async () => window.invoker.getUiPerfStats());
    const terminalEvidence = {
      fullAlphaTaskId,
      fullBetaTaskId,
      alphaOpenWallMs,
      betaOpenWallMs,
      switchWallMs,
      scrollWallMs,
      attachPayloads,
      inputPayloads,
      outputPayloads,
      resizePayloads,
      scrollPayloads,
      perf,
      budgets: TERMINAL_PRESSURE_BUDGETS,
    };
    console.log(`EMBEDDED_TERMINAL_PRESSURE_BENCH_RESULT=${JSON.stringify(terminalEvidence)}`);
    const terminalEvidenceMessage = JSON.stringify(terminalEvidence);

    expect(attachPayloads.length, terminalEvidenceMessage).toBeGreaterThanOrEqual(2);
    expect(inputPayloads.length, terminalEvidenceMessage).toBeGreaterThan(0);
    expect(outputPayloads.length, terminalEvidenceMessage).toBeGreaterThan(0);
    expect(scrollPayloads.length, terminalEvidenceMessage).toBeGreaterThan(0);
    expect(
      scrollPayloads.some((payload) =>
        payload.taskId === fullAlphaTaskId
        && payload.active === true
        && payload.drawerState === 'maximized',
      ),
      terminalEvidenceMessage,
    ).toBe(true);
    expect(
      resizePayloads.some((payload) => payload.source === 'active_session' && payload.taskId === fullAlphaTaskId),
      terminalEvidenceMessage,
    ).toBe(true);
    expect(alphaOpenWallMs, terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_OPEN_WALL_BUDGET_MS);
    expect(betaOpenWallMs, terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_OPEN_WALL_BUDGET_MS);
    expect(switchWallMs, terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_TAB_SWITCH_WALL_BUDGET_MS);
    expect(scrollWallMs, terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_SCROLL_WALL_BUDGET_MS);
    expect(
      Math.max(...attachPayloads.map((payload) => Number(payload.durationMs))),
      terminalEvidenceMessage,
    ).toBeLessThanOrEqual(TERMINAL_ATTACH_BUDGET_MS);
    expect(
      Math.max(...inputPayloads.map((payload) => Number(payload.durationMs))),
      terminalEvidenceMessage,
    ).toBeLessThanOrEqual(TERMINAL_INPUT_BUDGET_MS);
    expect(
      Math.max(...outputPayloads.map((payload) => Number(payload.durationMs))),
      terminalEvidenceMessage,
    ).toBeLessThanOrEqual(TERMINAL_OUTPUT_WRITE_BUDGET_MS);
    expect(
      Math.max(...resizePayloads.map((payload) => Number(payload.durationMs))),
      terminalEvidenceMessage,
    ).toBeLessThanOrEqual(TERMINAL_RESIZE_BUDGET_MS);
    expect(
      Math.max(...scrollPayloads.map((payload) => Number(payload.durationMs))),
      terminalEvidenceMessage,
    ).toBeLessThanOrEqual(TERMINAL_SCROLL_BUDGET_MS);

    expect(Number(perf.embeddedTerminalAttachReports), terminalEvidenceMessage).toBeGreaterThanOrEqual(2);
    expect(Number(perf.embeddedTerminalInputReports), terminalEvidenceMessage).toBeGreaterThan(0);
    expect(Number(perf.embeddedTerminalOutputWriteReports), terminalEvidenceMessage).toBeGreaterThan(0);
    expect(Number(perf.embeddedTerminalScrollReports), terminalEvidenceMessage).toBeGreaterThan(0);
    expect(Number(perf.maxEmbeddedTerminalAttachMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_ATTACH_BUDGET_MS);
    expect(Number(perf.maxEmbeddedTerminalInputMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_INPUT_BUDGET_MS);
    expect(Number(perf.maxEmbeddedTerminalOutputWriteMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_OUTPUT_WRITE_BUDGET_MS);
    expect(Number(perf.maxEmbeddedTerminalResizeMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_RESIZE_BUDGET_MS);
    expect(Number(perf.maxEmbeddedTerminalScrollMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_SCROLL_BUDGET_MS);
    expect(numberOrZero(perf.maxTerminalSessionUpsertMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_SESSION_UPSERT_BUDGET_MS);
    expect(numberOrZero(perf.maxRendererEventLoopLagMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_RENDERER_EVENT_LOOP_LAG_BUDGET_MS);
    expect(numberOrZero(perf.maxRendererLongTaskMs), terminalEvidenceMessage).toBeLessThanOrEqual(TERMINAL_RENDERER_LONG_TASK_BUDGET_MS);
  });
});
