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
  injectTaskStates,
  captureScreenshot,
  assertPageScreenshot,
  E2E_REPO_URL,
} from './fixtures/electron-app.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';

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

function taskNodeCard(page: import('@playwright/test').Page, taskIdSuffix: string) {
  return page.locator(`.react-flow__node[data-testid$="${taskIdSuffix}"] > div`).first();
}

test.describe('Visual proof capture', () => {
  test('empty state', async ({ page }) => {
    await expect(page.getByText('Load a plan to get started')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Open File')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Utility menu' })).toBeVisible();
    await captureScreenshot(page, 'empty-state');
    await assertPageScreenshot(page, 'empty-state');
  });

  test('dag loaded', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
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
    await loadPlan(page, TEST_PLAN);
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click();
    await expect(page.getByRole('heading', { name: 'First test task' })).toBeVisible();
    const panel = page.locator('.overflow-y-auto');
    await expect(panel.locator('text=task-alpha')).toBeVisible();
    await captureScreenshot(page, 'task-panel');
    await assertPageScreenshot(page, 'task-panel');
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
    await page.evaluate((yaml) => window.invoker.loadPlan(yaml), yamlStringify(MERGE_GATE_TEXT_VISUAL_PLAN));
    await page.locator('.react-flow__node[data-testid$="mg-visual-work"]').first().waitFor({ state: 'visible', timeout: 15000 });
    await expect(page.getByTestId('merge-gate-primary-label')).toBeVisible();
    await captureScreenshot(page, 'merge-gate-node-text-black');
    await assertPageScreenshot(page, 'merge-gate-node-text-black');
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

    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Fix with Claude' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Fix with Codex' })).toBeVisible();
    await expect(menu.getByText('Workflow', { exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(menu.getByText('Danger', { exact: true })).toBeVisible();

    await captureScreenshot(page, 'context-menu-failed-organization');
    await assertPageScreenshot(page, 'context-menu-failed-organization');
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

    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(page.getByText('Danger')).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Recreate from Task' })).toBeVisible();

    await captureScreenshot(page, 'context-menu-danger-separator-fallback');
    await assertPageScreenshot(page, 'context-menu-danger-separator-fallback');
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

    // Assert that the completed node (task-alpha) is dimmed via opacity-20 class
    const completedNodeCard = taskNodeCard(page, 'task-alpha');
    await expect(completedNodeCard).toBeVisible();
    await expect(completedNodeCard).toHaveClass(/opacity-20/);

    // Assert that the pending node (task-beta) is NOT dimmed
    const pendingNodeCard = taskNodeCard(page, 'task-beta');
    await expect(pendingNodeCard).toBeVisible();
    await expect(pendingNodeCard).not.toHaveClass(/opacity-20/);

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
    await expect(completedCard).toHaveClass(/opacity-20/);
    await captureScreenshot(page, 'statusbar-click-isolate-pending');
    await assertPageScreenshot(page, 'statusbar-click-isolate-pending');

    // 2. Ctrl-click "Completed:" to add it to the active set
    await page.getByText(/Completed:/).click({ modifiers: ['ControlOrMeta'] });
    await page.waitForTimeout(100);

    // Now both pending and completed are active — neither should be dimmed
    await expect(completedCard).not.toHaveClass(/opacity-20/);
    const pendingCard = taskNodeCard(page, 'task-beta');
    await expect(pendingCard).not.toHaveClass(/opacity-20/);
    await captureScreenshot(page, 'statusbar-ctrl-click-toggle-both');
    await assertPageScreenshot(page, 'statusbar-ctrl-click-toggle-both');

    // 3. Click sole active filter to clear — click "Completed:" (plain click = isolate to completed)
    //    then click it again (sole active = clear all)
    await page.getByText(/Completed:/).click();
    await page.waitForTimeout(100);
    await page.getByText(/Completed:/).click();
    await page.waitForTimeout(100);

    // All filters cleared — nothing dimmed
    await expect(completedCard).not.toHaveClass(/opacity-20/);
    await expect(pendingCard).not.toHaveClass(/opacity-20/);
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

    // Click Approve Fix button to open the modal
    await page.getByRole('button', { name: 'Approve Fix' }).click();

    // Assert modal is visible
    await expect(page.getByRole('heading', { name: 'Approve AI Fix' })).toBeVisible();

    // Assert the old Fix Context section is gone
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
    await page.getByRole('button', { name: 'Approve Fix' }).click();

    await expect(page.getByRole('heading', { name: 'Approve AI Fix' })).toBeVisible();
    await expect(page.getByText('Codex Session')).toBeVisible();
    await expect(page.getByText(sessionId)).toBeVisible();
    await expect(page.getByText('Human:')).toBeVisible();
    await expect(page.getByText('Fix validator merge conflict and keep visual proof checks.')).toBeVisible();
    await expect(page.getByText('Codex:')).toBeVisible();
    await expect(page.getByText('I resolved the validator conflict and preserved the visual proof checks.')).toBeVisible();

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
    await page.getByRole('button', { name: 'Queue' }).click();
    await expect(page.getByText('Running 1 / 3')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Running (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Queued (0)' })).toBeVisible();
    await expect(page.getByText(/^Pending \(\d+\)$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pending (3)' })).toBeVisible();
    await captureScreenshot(page, 'queue-view-concurrency');
    await assertPageScreenshot(page, 'queue-view-concurrency');
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

    await page.evaluate((p) => window.invoker.loadPlan(p), yamlStringify(gatePolicyPlan));
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

    // Scroll to the Gate Policy section
    const gatePolicyHeading = page.getByRole('heading', { name: 'Gate Policy' });
    await gatePolicyHeading.scrollIntoViewIfNeeded();
    await expect(gatePolicyHeading).toBeVisible();

    // Click the disclosure button to expand satisfied gates (text contains "satisfied gate")
    const disclosureButton = page.locator('button').filter({ hasText: /satisfied gate/ });
    await expect(disclosureButton).toBeVisible();
    await disclosureButton.click();
    await page.waitForTimeout(200); // Allow animation to complete

    // Capture first screenshot with expanded satisfied gates
    await captureScreenshot(page, 'redesign-gate-policy-ui-blocked-expanded');

    // Click the Edit button
    await page.getByTestId('gate-policy-edit-btn').click();
    await page.waitForTimeout(200); // Allow UI to update

    // Capture second screenshot in edit mode
    await captureScreenshot(page, 'redesign-gate-policy-ui-edit-mode');
  });
});
