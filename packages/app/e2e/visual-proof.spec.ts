/**
 * E2E: Visual proof capture.
 *
 * Captures screenshots at key UI states for before/after comparison in PRs.
 * When CAPTURE_MODE env var is set, screenshots are saved to disk via captureScreenshot
 * (used by scripts/ui-visual-proof.sh for merge-gate proof).
 * Always validates UI state via DOM assertions so it doubles as a regression test.
 * Committed PNG baselines are asserted via assertPageScreenshot / toHaveScreenshot.
 */

import {
  test,
  expect,
  TEST_PLAN,
  loadPlan,
  selectFirstWorkflow,
  injectTaskStates,
  captureScreenshot,
  assertPageScreenshot,
  E2E_REPO_URL,
} from './fixtures/electron-app.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { Locator, Page } from '@playwright/test';
import type { DraftPlanSummary, PlanningChatSendResponse } from '@invoker/contracts';

/** Plan for queue-semantics visual proof: enough tasks to fill Action Queue and Backlog. */
const QUEUE_SEMANTICS_PLAN = {
  name: 'Queue Semantics Visual Proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'qs-running', description: 'Running task (executing)', command: 'echo run', dependencies: [] },
    { id: 'qs-fixing', description: 'Fixing with AI task', command: 'echo fix', dependencies: [] },
    { id: 'qs-needs-input', description: 'Needs human input', command: 'echo input', dependencies: [] },
    { id: 'qs-review', description: 'Review ready task', command: 'echo review', dependencies: [] },
    { id: 'qs-approval', description: 'Awaiting approval task', command: 'echo approve', dependencies: [] },
    { id: 'qs-queued', description: 'Queued pending task', command: 'echo queued', dependencies: [] },
    { id: 'qs-blocked', description: 'Blocked by running task', command: 'echo blocked', dependencies: ['qs-running'] },
  ],
};

/** Multi-task DAG for verifying deterministic layout ordering. */
const DAG_DETERMINISM_PLAN = {
  name: 'DAG determinism test',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'task-a', description: 'Task A', command: 'echo a', dependencies: [] },
    { id: 'task-b', description: 'Task B', command: 'echo b', dependencies: [] },
    { id: 'task-c', description: 'Task C (depends on A)', command: 'echo c', dependencies: ['task-a'] },
    { id: 'task-d', description: 'Task D (depends on A, B)', command: 'echo d', dependencies: ['task-a', 'task-b'] },
    { id: 'task-e', description: 'Task E (depends on C, D)', command: 'echo e', dependencies: ['task-c', 'task-d'] },
  ],
};

/** Plan for queue-relationships visual proof: one actionable task with upstream deps and downstream dependents. */
const QUEUE_RELATIONSHIPS_PLAN = {
  name: 'Queue Relationships Visual Proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'qr-upstream', description: 'Upstream dependency (completed)', command: 'echo upstream', dependencies: [] },
    { id: 'qr-middle', description: 'Actionable task with relationships', command: 'echo middle', dependencies: ['qr-upstream'] },
    { id: 'qr-downstream', description: 'Downstream dependent (blocked)', command: 'echo downstream', dependencies: ['qr-middle'] },
  ],
};

/** Minimal plan that produces a merge gate in the DAG. */
const MERGE_GATE_TEXT_VISUAL_PLAN = {
  name: 'Merge gate text visual proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review',
  tasks: [
    {
      id: 'mg-visual-work',
      description: 'Sole task before merge gate',
      command: 'echo ok',
      dependencies: [] as string[],
    },
  ],
};

/** Manual-merge plan: inline approve button would render here on legacy builds. */
const MERGE_GATE_NO_INLINE_APPROVE_PLAN = {
  name: 'Merge gate no inline approve',
  repoUrl: E2E_REPO_URL,
  onFinish: 'merge' as const,
  mergeMode: 'manual',
  tasks: [
    {
      id: 'mg-no-inline-work',
      description: 'Sole task before merge gate',
      command: 'echo ok',
      dependencies: [] as string[],
    },
  ],
};

/** Pull-request workflow for proving workflow selection exposes the merge gate PR in the inspector. */
const REVIEW_READY_WORKFLOW_PR_PLAN = {
  name: 'Review ready workflow PR proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review',
  tasks: [
    {
      id: 'rr-work',
      description: 'Work that produced a pull request',
      command: 'echo review-ready',
      dependencies: [] as string[],
    },
  ],
};

/** Plan for queue-action-surface hardening: combines canonical states, dependency relationships, and destructive actions. */
const QUEUE_HARDENING_PLAN = {
  name: 'Queue Hardening Visual Proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'qh-running', description: 'Running task with downstream', command: 'echo run', dependencies: [] },
    { id: 'qh-fixing', description: 'AI fix in progress', command: 'echo fix', dependencies: [] },
    { id: 'qh-approval', description: 'Awaiting approval task', command: 'echo approve', dependencies: [] },
    { id: 'qh-queued', description: 'Queued pending task', command: 'echo queued', dependencies: [] },
    { id: 'qh-downstream', description: 'Blocked by running task', command: 'echo downstream', dependencies: ['qh-running'] },
  ],
};

const MENU_PROOF_PLAN = {
  ...TEST_PLAN,
  name: 'Menu Proof Workflow',
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review',
};

function workflowNode(page: Page, workflowId: string) {
  return page.getByTestId(`workflow-node-${workflowId}`);
}

function taskNodeCard(page: Page, taskIdSuffix: string) {
  return page.locator(`.react-flow__node[data-testid$="${taskIdSuffix}"] > div`).first();
}

async function openContextMenu(page: Page, locator: Locator) {
  const target = locator.first();
  await expect(target).toBeVisible({ timeout: 10000 });
  const box = await target.boundingBox();
  if (!box) throw new Error('Context menu target has no bounding box');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.click(x, y, { button: 'right' });
  const menu = page.getByRole('menu');
  if (!(await menu.isVisible({ timeout: 3000 }).catch(() => false))) {
    await target.dispatchEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      buttons: 2,
      clientX: x,
      clientY: y,
    });
  }
  await expect(menu).toBeVisible({ timeout: 10000 });
  return menu;
}

async function loadPlanAndSelectWorkflow(page: Page, plan: unknown): Promise<string> {
  const beforeIds = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.map((workflow: { id: string }) => workflow.id);
  });
  await page.evaluate((yaml) => window.invoker.loadPlan(yaml), yamlStringify(plan));
  const workflowId = await page.evaluate(async (knownIds) => {
    const workflows = await window.invoker.listWorkflows();
    const created = workflows.find((workflow: { id: string }) => !knownIds.includes(workflow.id));
    return created?.id ?? workflows[workflows.length - 1]?.id ?? null;
  }, beforeIds);
  expect(workflowId).toBeTruthy();
  const node = workflowNode(page, workflowId!);
  await node.waitFor({ state: 'attached', timeout: 15000 });
  await node.dispatchEvent('click', { bubbles: true });
  await expect(page.getByTestId('selected-workflow-mini-dag')).toBeVisible({ timeout: 10000 });
  return workflowId!;
}

async function setTestPlanningChatResponse(
  page: Page,
  response: PlanningChatSendResponse | PlanningChatSendResponse[],
): Promise<void> {
  await page.evaluate(async (mockResponse) => {
    if (!window.invoker.setTestPlanningChatResponse) {
      throw new Error('setTestPlanningChatResponse test harness is unavailable');
    }
    await window.invoker.setTestPlanningChatResponse(mockResponse);
  }, response);
}

test.describe('Visual proof capture', () => {
  test('empty state', async ({ page }) => {
    await expect(page.getByText('Load a plan to render workflow graph')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('rail-open-file')).toBeVisible();
    await expect(page.getByTestId('rail-settings')).toBeVisible();
    await captureScreenshot(page, 'empty-state');
    await assertPageScreenshot(page, 'empty-state');
  });

  test('planning-terminal revised draft summary replaces initial ready list in same conversation', async ({ page }) => {
    const firstSummary: DraftPlanSummary = {
      planName: 'Initial terminal draft',
      taskCount: 2,
      taskGroups: [
        {
          name: 'Initial scope',
          tasks: [
            { id: 'first-shell', description: 'Add the shell-only planning harness' },
            { id: 'first-assert', description: 'Assert the initial ready bar' },
          ],
        },
      ],
    };
    const revisedSummary: DraftPlanSummary = {
      planName: 'Revised terminal draft',
      taskCount: 3,
      taskGroups: [
        {
          name: 'Harness updates',
          tasks: [
            { id: 'revised-harness', description: 'Queue deterministic planning responses' },
          ],
        },
        {
          name: 'E2E proof',
          tasks: [
            { id: 'revised-submit', description: 'Submit the revised request in the same terminal' },
            { id: 'revised-assert', description: 'Assert the latest ready summary only' },
          ],
        },
      ],
    };

    await setTestPlanningChatResponse(page, {
      reply: 'Initial draft is ready.',
      draftPlanSummary: firstSummary,
    });

    await page.getByRole('button', { name: 'Expand terminal drawer' }).click();
    const input = page.getByTestId('invoker-terminal-input');
    await input.fill('Draft the initial planning proof');
    await page.getByTestId('invoker-terminal-send').click();

    await expect(page.getByTestId('invoker-terminal-ready-plan-name')).toHaveText('Initial terminal draft');
    await expect(page.getByTestId('invoker-terminal-ready-task-count')).toHaveText('2 tasks');
    await expect(page.getByTestId('invoker-terminal-ready-task-list')).toContainText('Initial scope');
    await expect(page.getByTestId('invoker-terminal-ready-task-list')).toContainText('Add the shell-only planning harness');

    await setTestPlanningChatResponse(page, {
      reply: 'Revised draft is ready.',
      draftPlanSummary: revisedSummary,
    });

    await input.fill('Revise that plan with the latest task grouping');
    await page.getByTestId('invoker-terminal-send').click();

    const readyBar = page.getByTestId('invoker-terminal-ready-bar');
    const readyTaskList = page.getByTestId('invoker-terminal-ready-task-list');
    await expect(page.getByTestId('invoker-terminal-ready-plan-name')).toHaveText('Revised terminal draft');
    await expect(page.getByTestId('invoker-terminal-ready-task-count')).toHaveText('3 tasks');
    await expect(readyTaskList).toContainText('Harness updates');
    await expect(readyTaskList).toContainText('E2E proof');
    await expect(readyTaskList).toContainText('Queue deterministic planning responses');
    await expect(readyTaskList).toContainText('Assert the latest ready summary only');
    await expect(readyBar).not.toContainText('Initial terminal draft');
    await expect(readyTaskList).not.toContainText('Initial scope');
    await expect(readyTaskList).not.toContainText('Add the shell-only planning harness');

    const transcript = page.getByTestId('invoker-terminal-messages');
    await expect(transcript.locator('> div')).toHaveCount(4);
    await expect(transcript).toContainText('Draft the initial planning proof');
    await expect(transcript).toContainText('Initial draft is ready.');
    await expect(transcript).toContainText('Revise that plan with the latest task grouping');
    await expect(transcript).toContainText('Revised draft is ready.');

    await captureScreenshot(page, 'planning-terminal-revised-draft-summary');
  });

  test('dag loaded', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-beta"]')).toBeVisible();
    await captureScreenshot(page, 'dag-loaded');
    await assertPageScreenshot(page, 'dag-loaded');
  });

  test('task running', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);
    await captureScreenshot(page, 'task-running');
    await assertPageScreenshot(page, 'task-running');
  });

  test('task complete', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
    ]);
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const alpha = tasks.find((t: { id: string }) => t.id.endsWith('task-alpha'));
    const beta = tasks.find((t: { id: string }) => t.id.endsWith('task-beta'));
    expect(alpha?.status).toBe('completed');
    expect(beta?.status).toBe('completed');
    await captureScreenshot(page, 'task-complete');
    await assertPageScreenshot(page, 'task-complete');
  });

  test('task panel', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click();
    await expect(page.getByTestId('workflow-inspector-title')).toBeVisible();
    await expect(page.getByText('sleep 5 && echo hello-alpha')).toBeVisible();
    await captureScreenshot(page, 'task-panel');
    await assertPageScreenshot(page, 'task-panel');
  });

  test('task panel setup failure renders in Error panel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const setupError = [
      'Executor startup failed (worktree)',
      'ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment (bad pnpm and/or Node.js version)',
      'Expected version: >=20',
    ].join('\n');

    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'failed',
          execution: { error: setupError, exitCode: 1 },
        },
      },
    ]);

    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click();
    const panel = page.locator('aside');
    const errorHeading = page.getByRole('heading', { name: 'Error' });
    const errorPanel = errorHeading.locator('xpath=..');
    await expect(errorHeading).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Workspace Setup Failure' })).toHaveCount(0);
    await expect(errorPanel).toContainText('ERR_PNPM_UNSUPPORTED_ENGINE Unsupported environment');
    await expect(errorPanel).toContainText('Exit code: 1');

    await captureScreenshot(page, 'task-panel-audit-setup-error');
    await assertPageScreenshot(page, 'task-panel-audit-setup-error');
  });

  test('dag before and after task selection', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-beta"]')).toBeVisible();

    // Before: DAG loaded, no task selected
    await assertPageScreenshot(page, 'dag-before-selection');

    // Action: click a task node to open the detail panel
    await page.locator('.react-flow__node[data-testid$="task-beta"]').click();
    await expect(page.getByRole('heading', { name: 'Second test task depending on alpha' })).toBeVisible();

    // After: task panel is open
    await assertPageScreenshot(page, 'dag-after-selection');
  });

  test('stable-layout-and-dag-ordering — deterministic dag layout', async ({ page }) => {
    await loadPlan(page, DAG_DETERMINISM_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-a"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-b"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-c"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-d"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-e"]')).toBeVisible();
    await captureScreenshot(page, 'deterministic-dag-layout');
    await assertPageScreenshot(page, 'deterministic-dag-layout');
  });

  test('status bar — no system log button', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    const statusBar = page.locator('.bg-gray-800.border-t');
    await expect(statusBar).toBeVisible();
    await expect(statusBar.getByText('Total:')).toBeVisible();
    await expect(statusBar.locator('text=System Log')).not.toBeVisible();
    await captureScreenshot(page, 'status-bar-no-system-log');
    await assertPageScreenshot(page, 'status-bar-no-system-log');
  });

  test('fixing-with-ai vs fix-approval colors', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'running',
          execution: { isFixingWithAI: true, startedAt: new Date() },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'awaiting_approval',
          execution: { pendingFixError: 'Test error for color comparison' },
        },
      },
    ]);
    await captureScreenshot(page, 'fixing-vs-fix-approval-colors');
    await assertPageScreenshot(page, 'fixing-vs-fix-approval-colors');
  });

  test('merge-gate-node-text-black — merge gate visible', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MERGE_GATE_TEXT_VISUAL_PLAN);
    await page.locator('.react-flow__node[data-testid$="mg-visual-work"]').first().waitFor({ state: 'visible', timeout: 15000 });
    await expect(page.getByTestId('merge-gate-primary-label')).toBeVisible();
    await captureScreenshot(page, 'merge-gate-node-text-black');
    await assertPageScreenshot(page, 'merge-gate-node-text-black');
  });

  test('merge-gate-no-inline-approve — approval moves from chip to TaskPanel', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MERGE_GATE_NO_INLINE_APPROVE_PLAN);
    await page
      .locator('.react-flow__node[data-testid$="mg-no-inline-work"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });

    const mergeGateTaskId = await page.evaluate(async () => {
      const result = await window.invoker.getTasks();
      const tasks = Array.isArray(result) ? result : result.tasks;
      const mergeTask = tasks.find((task: { id: string }) => task.id.includes('__merge__'));
      return mergeTask?.id ?? null;
    });
    expect(mergeGateTaskId).toBeTruthy();

    await injectTaskStates(page, [
      {
        taskId: mergeGateTaskId!,
        changes: { status: 'awaiting_approval', execution: { startedAt: new Date() } },
      },
    ]);

    const mergeGateNode = page
      .locator(`.react-flow__node[data-testid="${mergeGateTaskId}"], .react-flow__node[data-testid$="${mergeGateTaskId}"]`)
      .first();
    await expect(mergeGateNode).toBeVisible({ timeout: 15000 });
    await expect(mergeGateNode.getByText('APPROVE', { exact: true })).toBeVisible();

    // Inline chip button must be gone — approval lives in the TaskPanel now.
    await expect(mergeGateNode.locator('[data-testid="approve-merge-button"]')).toHaveCount(0);

    await mergeGateNode.click();
    await expect(page.getByRole('heading', { name: /Merge gate for/i })).toBeVisible();
    await expect(page.getByText('Task Status')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve Merge' })).toHaveCount(0);

    await captureScreenshot(page, 'merge-gate-no-inline-approve');
    await assertPageScreenshot(page, 'merge-gate-no-inline-approve');
  });

  test('review-ready workflow exposes pull request in inspector', async ({ page }) => {
    const workflowId = await loadPlanAndSelectWorkflow(page, REVIEW_READY_WORKFLOW_PR_PLAN);
    await page.locator('.react-flow__node[data-testid$="rr-work"]').first().waitFor({ state: 'visible', timeout: 15000 });

    const reviewUrl = 'https://github.com/Neko-Catpital-Labs/Invoker/pull/626';
    await injectTaskStates(page, [
      {
        taskId: 'rr-work',
        changes: {
          status: 'completed',
          execution: { startedAt: new Date(Date.now() - 5000), completedAt: new Date() },
        },
      },
      {
        taskId: `__merge__${workflowId}`,
        changes: {
          status: 'review_ready',
          execution: { startedAt: new Date(Date.now() - 3000), reviewUrl },
        },
      },
    ]);

    await workflowNode(page, workflowId).dispatchEvent('click', { bubbles: true });
    await expect(page.getByTestId('workflow-inspector-title')).toHaveText('Review ready workflow PR proof');
    await expect(page.getByText('Inspector', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('workflow-inspector-status-label')).toContainText('review ready');
    await expect(page.getByRole('link', { name: reviewUrl })).toHaveAttribute('href', reviewUrl);

    await captureScreenshot(page, 'review-ready-workflow-pr-sidebar');
  });

  test('interactive-status-hues — fixing-with-ai, needs-input, awaiting-approval', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'running',
          execution: { isFixingWithAI: true, startedAt: now },
        },
      },
      {
        taskId: 'task-gamma',
        changes: {
          status: 'needs_input',
          config: { isReconciliation: true },
          execution: { startedAt: now },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'awaiting_approval',
          execution: { startedAt: now },
        },
      },
    ]);

    // DOM assertions for the three status labels
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]').getByText('FIXING WITH AI')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-gamma"]').getByText('SELECT')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-beta"]').getByText('APPROVE')).toBeVisible();

    await captureScreenshot(page, 'interactive-status-hues');
    await assertPageScreenshot(page, 'interactive-status-hues');
  });

  test('context menu organization for failed task', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'failed',
          execution: { exitCode: 1, stderr: 'failed for visual proof' },
        },
      },
    ]);

    const menu = await openContextMenu(page, page.locator('.react-flow__node[data-testid$="task-alpha"]'));
    await expect(page.getByRole('menuitem', { name: 'Fix with Claude' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Fix with Codex' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Retry Workflow' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'More' }).click();

    await captureScreenshot(page, 'context-menu-failed-organization');
    await assertPageScreenshot(page, 'context-menu-failed-organization');
  });

  test('workflow context menu organization', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);

    const menu = await openContextMenu(page, page.locator('[data-testid^="workflow-node-"]'));
    await expect(page.getByRole('menuitem', { name: 'Open Workflow' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Retry Workflow' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Copy Workflow ID' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(page.getByRole('menuitem', { name: 'Recreate with Rebase' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Recreate Workflow' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Cancel Workflow' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete Workflow' })).toBeVisible();

    await captureScreenshot(page, 'workflow-context-menu-organization');
  });

  test('context menu keeps danger separator when cancel action is absent', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: {
            startedAt: new Date(Date.now() - 8000),
            completedAt: new Date(),
          },
        },
      },
    ]);

    const menu = await openContextMenu(page, page.locator('.react-flow__node[data-testid$="task-alpha"]'));
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(page.getByRole('menuitem', { name: 'Recreate from Task' })).toBeVisible();

    await captureScreenshot(page, 'context-menu-danger-separator-fallback');
    await assertPageScreenshot(page, 'context-menu-danger-separator-fallback');
  });

  test('context menu dismisses on outside left-click even when bubbling is stopped', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'failed',
          execution: { exitCode: 1, stderr: 'failed for visual proof' },
        },
      },
    ]);

    await page.evaluate(() => {
      document.getElementById('outside-dismiss-target')?.remove();
      const target = document.createElement('button');
      target.id = 'outside-dismiss-target';
      target.setAttribute('aria-label', 'Outside dismiss target');
      Object.assign(target.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        width: '28px',
        height: '28px',
        opacity: '0',
        zIndex: '2147483647',
      });
      target.addEventListener('mousedown', (event) => {
        event.stopPropagation();
      });
      document.body.appendChild(target);
    });

    const menu = await openContextMenu(page, page.locator('.react-flow__node[data-testid$="task-alpha"]'));

    await captureScreenshot(page, 'context-menu-outside-dismiss-open');

    await page.getByRole('button', { name: 'Outside dismiss target' }).click();
    await page.waitForTimeout(200);

    await captureScreenshot(page, 'context-menu-outside-dismiss-after-click');

    await expect(menu).not.toBeVisible();
  });

  test('status filter dims non-matching nodes', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      // task-beta remains pending (no changes)
    ]);

    // Click the "Pending:" status label to filter
    await page.getByText(/Pending:/).click();

    // No debounce — effect is immediate, but allow React render
    await page.waitForTimeout(100);

    // The selected filter keeps matching and non-matching nodes visible in the current DAG.
    const completedNodeCard = taskNodeCard(page, 'task-alpha');
    await expect(completedNodeCard).toBeVisible();

    const pendingNodeCard = taskNodeCard(page, 'task-beta');
    await expect(pendingNodeCard).toBeVisible();

    await captureScreenshot(page, 'status-filter-dimmed-dag');
    await assertPageScreenshot(page, 'status-filter-dimmed-dag');
  });

  test('status bar click-to-isolate and ctrl-click-toggle', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      // task-beta stays pending
    ]);

    // 1. Click "Pending:" to isolate — completed node should dim
    await page.getByText(/Pending:/).click();
    // No debounce — effect is immediate, but allow React render
    await page.waitForTimeout(100);

    const completedCard = taskNodeCard(page, 'task-alpha');
    await expect(completedCard).toBeVisible();
    await captureScreenshot(page, 'statusbar-click-isolate-pending');
    await assertPageScreenshot(page, 'statusbar-click-isolate-pending');

    // 2. Ctrl-click "Completed:" to add it to the active set
    await page.getByText(/Completed:/).click({ modifiers: ['ControlOrMeta'] });
    await page.waitForTimeout(100);

    // Now both pending and completed are active — neither should be dimmed
    await expect(completedCard).toBeVisible();
    const pendingCard = taskNodeCard(page, 'task-beta');
    await expect(pendingCard).toBeVisible();
    await captureScreenshot(page, 'statusbar-ctrl-click-toggle-both');
    await assertPageScreenshot(page, 'statusbar-ctrl-click-toggle-both');

    // 3. Click sole active filter to clear — click "Completed:" (plain click = isolate to completed)
    //    then click it again (sole active = clear all)
    await page.getByText(/Completed:/).click();
    await page.waitForTimeout(100);
    await page.getByText(/Completed:/).click();
    await page.waitForTimeout(100);

    // All filters cleared — nothing dimmed
    await expect(completedCard).toBeVisible();
    await expect(pendingCard).toBeVisible();
    await captureScreenshot(page, 'statusbar-clear-all-filters');
    await assertPageScreenshot(page, 'statusbar-clear-all-filters');
  });

  test('approve-fix modal — no Fix Context panel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-beta',
        changes: {
          status: 'awaiting_approval',
          execution: { pendingFixError: 'Visual proof error line' },
        },
      },
    ]);

    // Click the task-beta node to open task panel
    await page.locator('.react-flow__node[data-testid$="task-beta"]').click();
    await expect(page.getByRole('heading', { name: 'Second test task depending on alpha' })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Approve Fix' })).toHaveCount(0);
    await expect(page.getByText('Fix Context')).not.toBeVisible();

    await captureScreenshot(page, 'approve-fix-modal-simplified');
    await assertPageScreenshot(page, 'approve-fix-modal-simplified');
  });

  test('approve-fix modal — renders current-cycle session log', async ({ page, testDir }) => {
    const sessionId = 'sess-current-codex-approval';
    const sessionDir = path.join(testDir, 'agent-sessions');
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'user_message', text: 'Fix validator merge conflict and keep visual proof checks.' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: 'I resolved the validator conflict and preserved the visual proof checks.' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    await loadPlan(page, TEST_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-beta',
        changes: {
          status: 'awaiting_approval',
          execution: {
            pendingFixError: 'Visual proof error line',
            agentSessionId: sessionId,
            agentName: 'codex',
          },
        },
      },
    ]);

    await page.locator('.react-flow__node[data-testid$="task-beta"]').click();
    await expect(page.getByRole('heading', { name: 'Second test task depending on alpha' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve Fix' })).toHaveCount(0);
    await expect(page.getByText('Second test task depending on alpha')).toBeVisible();

    await captureScreenshot(page, 'approve-fix-modal-with-session-log');
    await assertPageScreenshot(page, 'approve-fix-modal-with-session-log');
  });

  test('queue view concurrency display', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);
    // Navigate to queue tab if there is one, or verify queue section is visible
    await page.getByTestId('rail-queue').click();
    await expect(page.getByText('Running 1 / 6')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Action Queue (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Backlog (3)' })).toBeVisible();
    await captureScreenshot(page, 'queue-view-concurrency');
    await assertPageScreenshot(page, 'queue-view-concurrency');
  });

  test('queue-semantics — action queue with canonical task states', async ({ page }) => {
    await loadPlan(page, QUEUE_SEMANTICS_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'qs-running', changes: { status: 'running', execution: { startedAt: now } } },
      { taskId: 'qs-fixing', changes: { status: 'running', execution: { isFixingWithAI: true, startedAt: now } } },
      { taskId: 'qs-needs-input', changes: { status: 'needs_input', execution: { startedAt: now } } },
      { taskId: 'qs-review', changes: { status: 'review_ready', execution: { startedAt: now } } },
      { taskId: 'qs-approval', changes: { status: 'awaiting_approval', execution: { startedAt: now } } },
      // qs-queued stays pending with no deps → lands in Action Queue queued section
      // qs-blocked stays pending with unmet dep on qs-running → lands in Backlog
    ]);

    // Navigate to queue view
    await page.getByTestId('rail-queue').click();

    // Assert queue section headings are visible
    await expect(page.getByRole('heading', { name: /Action Queue/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Backlog/ })).toBeVisible();

    // Assert at least one canonical task-state label rendered in the action queue rows
    await expect(page.locator('text=running').first()).toBeVisible();

    await captureScreenshot(page, 'queue-semantics-action-states');
    await assertPageScreenshot(page, 'queue-semantics-action-states');
  });

  test('queue-relationships — expanded row context with upstream and downstream', async ({ page }) => {
    await loadPlan(page, QUEUE_RELATIONSHIPS_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      // Upstream task completed — satisfies qr-middle's dependency
      {
        taskId: 'qr-upstream',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      // Middle task running — actionable, appears in Action Queue
      {
        taskId: 'qr-middle',
        changes: {
          status: 'running',
          execution: { startedAt: now },
        },
      },
      // qr-downstream stays pending with unmet dep on qr-middle → lands in Backlog
    ]);

    // Navigate to queue view
    await page.getByTestId('rail-queue').click();

    // Assert queue sections are visible
    await expect(page.getByRole('heading', { name: /Action Queue/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Backlog/ })).toBeVisible();

    // Assert downstream dependent is rendered in Backlog with its dep reference
    await expect(page.getByText('deps: qr-middle')).toBeVisible();

    // Click the middle task row to expand its relationship context in the task panel
    await page.locator('[data-row-id$="/qr-middle"]').click();

    // Assert the expanded relationship headings are visible in the task panel
    await expect(page.getByRole('heading', { name: 'Actionable task with relationships' })).toBeVisible();
    await expect(page.getByText('echo middle')).toBeVisible();

    await captureScreenshot(page, 'queue-relationships-expanded-context');
    await assertPageScreenshot(page, 'queue-relationships-expanded-context');
  });

  test('gate-policy-side-panel — blocked task with satisfied and offender gates', async ({ page }) => {
    // First, load three prerequisite workflows (all with merge gates via onFinish: pull_request)
    const prereq1Plan = {
      name: 'Prereq Workflow 1',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      tasks: [
        { id: 'prereq-task-1', description: 'First prerequisite task', command: 'echo prereq1', dependencies: [] as string[] },
      ],
    };
    const prereq2Plan = {
      name: 'Prereq Workflow 2',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      tasks: [
        { id: 'prereq-task-2', description: 'Second prerequisite task', command: 'echo prereq2', dependencies: [] as string[] },
      ],
    };
    const prereq3Plan = {
      name: 'Prereq Workflow 3',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      tasks: [
        { id: 'prereq-task-3', description: 'Third prerequisite task', command: 'echo prereq3', dependencies: [] as string[] },
      ],
    };

    await page.evaluate((p) => window.invoker.loadPlan(p), yamlStringify(prereq1Plan));
    await page.evaluate((p) => window.invoker.loadPlan(p), yamlStringify(prereq2Plan));
    await page.evaluate((p) => window.invoker.loadPlan(p), yamlStringify(prereq3Plan));
    await page.waitForFunction(() => window.invoker.listWorkflows().then((workflows) => workflows.length >= 3), null, { timeout: 10000 });
    await page.getByRole('button', { name: 'Refresh' }).click();
    await selectFirstWorkflow(page);

    // Get the workflow IDs from the loaded plans
    const workflowIds = await page.evaluate(async () => {
      const workflows = await window.invoker.listWorkflows();
      return workflows.map((workflow: { id: string }) => workflow.id).sort();
    });

    const [wf1, wf2, wf3] = workflowIds;

    // Now load the main plan with external dependencies
    const gatePolicyPlan = {
      name: 'Gate Policy Visual Test',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'gated-task',
          description: 'Task with multiple external gates',
          command: 'echo gated',
          dependencies: [] as string[],
          externalDependencies: [
            { workflowId: wf1!, gatePolicy: 'completed' as const },
            { workflowId: wf2!, gatePolicy: 'completed' as const },
            { workflowId: wf3!, gatePolicy: 'completed' as const },
          ],
        },
      ],
    };

    const gatedWorkflowId = await loadPlanAndSelectWorkflow(page, gatePolicyPlan);
    await page.locator('.react-flow__node[data-testid$="gated-task"]').first().waitFor({ state: 'visible', timeout: 10000 });

    // Set up the gate states:
    // - wf1 merge gate: completed (satisfied)
    // - wf2 merge gate: review_ready (offender, because gatePolicy is 'completed')
    // - wf3 merge gate: completed (satisfied)
    const merge1Id = `__merge__${wf1}`;
    const merge2Id = `__merge__${wf2}`;
    const merge3Id = `__merge__${wf3}`;

    await injectTaskStates(page, [
      {
        taskId: `${wf1}/prereq-task-1`,
        changes: { status: 'completed', execution: { startedAt: new Date(), completedAt: new Date() } },
      },
      {
        taskId: merge1Id,
        changes: { status: 'completed', execution: { startedAt: new Date(), completedAt: new Date() } },
      },
      {
        taskId: `${wf2}/prereq-task-2`,
        changes: { status: 'completed', execution: { startedAt: new Date(), completedAt: new Date() } },
      },
      {
        taskId: merge2Id,
        changes: { status: 'review_ready', execution: { startedAt: new Date() } },
      },
      {
        taskId: `${wf3}/prereq-task-3`,
        changes: { status: 'completed', execution: { startedAt: new Date(), completedAt: new Date() } },
      },
      {
        taskId: merge3Id,
        changes: { status: 'completed', execution: { startedAt: new Date(), completedAt: new Date() } },
      },
    ]);

    // Click the gated task node to open the side panel
    await page.locator('.react-flow__node[data-testid$="gated-task"]').click();
    await expect(page.getByRole('heading', { name: 'Task with multiple external gates' })).toBeVisible();

    await expect(page.getByText('Task Status')).toBeVisible();
    await expect(page.getByText('pending').last()).toBeVisible();

    await captureScreenshot(page, 'redesign-gate-policy-ui-blocked-expanded');

    await page.getByRole('button', { name: /Advanced metadata/ }).click();

    await captureScreenshot(page, 'redesign-gate-policy-ui-edit-mode');
  });

  test('stacked-workflows — root, parallel downstream, and fan-in graph', async ({ page }) => {
    const rootWorkflowId = await loadPlanAndSelectWorkflow(page, {
      name: 'Stack Root Workflow',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      tasks: [
        { id: 'stack-root-task', description: 'Root stack task', command: 'echo root', dependencies: [] as string[] },
      ],
    });

    const downstreamAId = await loadPlanAndSelectWorkflow(page, {
      name: 'Stack Downstream A',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      externalDependencies: [{ workflowId: rootWorkflowId, gatePolicy: 'review_ready' as const }],
      tasks: [
        { id: 'stack-a-task', description: 'Parallel downstream A', command: 'echo a', dependencies: [] as string[] },
      ],
    });

    const downstreamBId = await loadPlanAndSelectWorkflow(page, {
      name: 'Stack Downstream B',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      externalDependencies: [{ workflowId: rootWorkflowId, gatePolicy: 'review_ready' as const }],
      tasks: [
        { id: 'stack-b-task', description: 'Parallel downstream B', command: 'echo b', dependencies: [] as string[] },
      ],
    });

    const fanInId = await loadPlanAndSelectWorkflow(page, {
      name: 'Stack Fan-in Workflow',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      externalDependencies: [
        { workflowId: downstreamAId, gatePolicy: 'review_ready' as const },
        { workflowId: downstreamBId, gatePolicy: 'review_ready' as const },
      ],
      tasks: [
        { id: 'stack-fanin-task', description: 'Fan-in workflow task', command: 'echo fanin', dependencies: [] as string[] },
      ],
    });

    for (const workflowId of [rootWorkflowId, downstreamAId, downstreamBId, fanInId]) {
      await expect(workflowNode(page, workflowId)).toBeVisible();
    }
    await page.getByTestId('workflow-graph-scroll').evaluate((element) => {
      element.scrollTo({ left: 0, top: 0 });
    });
    await page.getByTestId('selected-workflow-mini-dag').evaluate((element) => {
      (element as HTMLElement).style.display = 'none';
    });
    await page.getByRole('button', { name: 'Minimize inspector' }).click();
    await expect(page.getByRole('button', { name: 'Maximize inspector' })).toBeVisible();
    await page.getByRole('button', { name: 'Fit View' }).first().click();
    await page.waitForTimeout(200);
    for (const workflowId of [rootWorkflowId, downstreamAId, downstreamBId, fanInId]) {
      await expect(workflowNode(page, workflowId)).toBeInViewport();
    }

    await captureScreenshot(page, 'stacked-workflows');
  });

  test('terminate-wording — task-level uses Terminate, workflow-level keeps Cancel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);

    // Switch to queue view to verify "Terminate" button text on task rows
    await page.getByTestId('rail-queue').click();
    await expect(page.getByRole('heading', { name: /Action Queue/ })).toBeVisible();
    const terminateButton = page
      .locator('[data-row-id$="/task-alpha"]')
      .getByRole('button', { name: 'Terminate' });
    await expect(terminateButton).toBeVisible();

    // Switch back to DAG view and right-click the running task for context menu
    await page.getByTestId('rail-home').click();
    const menu = await openContextMenu(page, page.locator('.react-flow__node[data-testid$="task-alpha"]'));

    // Expand the More section to reveal Danger items
    await page.getByRole('menuitem', { name: 'More' }).click();

    // Assert task-level action uses "Terminate Task"
    await expect(page.getByRole('menuitem', { name: 'Terminate Task' })).toBeVisible();

    // Task context menu no longer owns workflow-wide actions.
    await expect(page.getByRole('menuitem', { name: 'Cancel Workflow' })).toHaveCount(0);

    await page.keyboard.press('Escape');
    const workflowMenu = await openContextMenu(page, page.locator('[data-testid^="workflow-node-"]'));
    await page.getByRole('menuitem', { name: 'More' }).click();

    // Workflow-level action keeps "Cancel Workflow" (not converted)
    await expect(page.getByRole('menuitem', { name: 'Cancel Workflow' })).toBeVisible();

    await captureScreenshot(page, 'terminate-wording-task-vs-workflow');
    await assertPageScreenshot(page, 'terminate-wording-task-vs-workflow');
  });

  test('queue-action-surface-hardening — composed queue UX with labels, relationships, and terminate', async ({ page }) => {
    await loadPlan(page, QUEUE_HARDENING_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'qh-running', changes: { status: 'running', execution: { startedAt: now } } },
      { taskId: 'qh-fixing', changes: { status: 'running', execution: { isFixingWithAI: true, startedAt: now } } },
      { taskId: 'qh-approval', changes: { status: 'awaiting_approval', execution: { startedAt: now } } },
      // qh-queued stays pending with no deps → Action Queue queued section
      // qh-downstream stays pending with unmet dep on qh-running → Backlog
    ]);

    // Navigate to queue view
    await page.getByTestId('rail-queue').click();

    // Assert canonical Action Queue and Backlog headings
    await expect(page.getByRole('heading', { name: /Action Queue/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Backlog/ })).toBeVisible();

    // Assert canonical action queue labels are present
    await expect(page.locator('text=running').first()).toBeVisible();

    // Assert task-level Terminate wording on running task row
    const terminateButton = page.getByRole('button', { name: 'Terminate' }).first();
    await expect(terminateButton).toBeVisible();

    // Assert downstream dependent shows its dependency in Backlog
    await expect(page.getByText('deps: qh-running')).toBeVisible();

    // Expand relationship section: click the running task row to open task panel
    await page.locator('[data-row-id$="/qh-running"]').click();
    await expect(page.getByRole('heading', { name: 'Running task with downstream' })).toBeVisible();
    await expect(page.getByText('echo run')).toBeVisible();

    await captureScreenshot(page, 'queue-action-surface-hardening');
    await assertPageScreenshot(page, 'queue-action-surface-hardening');
  });
});
