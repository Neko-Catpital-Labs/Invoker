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
  getTasks,
  E2E_REPO_URL,
} from './fixtures/electron-app.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import type { Locator, Page } from '@playwright/test';
import { SQLiteAdapter, type WorkerActionWrite } from '@invoker/data-store';
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

const WORKERS_SURFACE_STACKED_PLAN = {
  name: 'Workers Surface',
  repoUrl: E2E_REPO_URL,
  baseBranch: 'master',
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review' as const,
  workflows: [
    {
      name: 'Workers Surface Contracts',
      featureBranch: 'plan/workers-surface-contracts',
      tasks: [
        {
          id: 'define-worker-contracts',
          description: 'Define worker contracts',
          prompt: 'Update shared contracts for workers.',
          dependencies: [],
        },
        {
          id: 'verify-worker-contracts',
          description: 'Verify worker contracts',
          command: 'pnpm test packages/contracts',
          dependencies: ['define-worker-contracts'],
        },
      ],
    },
    {
      name: 'Workers Surface UI',
      featureBranch: 'plan/workers-surface-ui',
      tasks: [
        {
          id: 'build-workers-ui',
          description: 'Build workers UI',
          prompt: 'Implement the workers surface.',
          dependencies: [],
        },
        {
          id: 'verify-workers-ui',
          description: 'Verify workers UI',
          command: 'pnpm test packages/ui',
          dependencies: ['build-workers-ui'],
        },
      ],
    },
  ],
};
const QUEUE_ASSIGNING_PLAN = {
  name: 'Queue assigning proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'assigning-task', description: 'Assigning queue task', command: 'echo assign', dependencies: [] },
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

/** External-review plan whose merge gate is driven to the terminal `closed` status. */
const MERGE_GATE_CLOSED_PLAN = {
  name: 'Merge gate closed status proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'pull_request' as const,
  mergeMode: 'external_review',
  tasks: [
    {
      id: 'mg-closed-work',
      description: 'Sole task before closed merge gate',
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

const TASK_STATUS_PROOF_SPECS = [
  { status: 'pending', taskId: 'proof-task-pending', description: 'Pending', label: 'PENDING' },
  { status: 'running', taskId: 'proof-task-running', description: 'Running', label: 'RUNNING' },
  { status: 'fixing_with_ai', taskId: 'proof-task-fixing', description: 'Fixing with AI', label: 'FIXING WITH AI' },
  { status: 'completed', taskId: 'proof-task-completed', description: 'Completed', label: 'COMPLETED' },
  { status: 'failed', taskId: 'proof-task-failed', description: 'Failed', label: 'FAILED' },
  { status: 'closed', taskId: 'proof-task-closed', description: 'Closed', label: 'CLOSED' },
  { status: 'needs_input', taskId: 'proof-task-needs-input', description: 'Needs input', label: 'NEEDS_INPUT' },
  { status: 'blocked', taskId: 'proof-task-blocked', description: 'Blocked', label: 'BLOCKED' },
  { status: 'review_ready', taskId: 'proof-task-review-ready', description: 'Review ready', label: 'REVIEW_READY' },
  { status: 'awaiting_approval', taskId: 'proof-task-awaiting-approval', description: 'Await approval', label: 'APPROVE' },
  { status: 'stale', taskId: 'proof-task-stale', description: 'Stale', label: 'STALE' },
] as const;

const WORKFLOW_STATUS_PROOF_STATUSES = [
  'pending',
  'running',
  'fixing_with_ai',
  'completed',
  'failed',
  'closed',
  'blocked',
  'review_ready',
  'awaiting_approval',
  'stale',
] as const;

const TASK_STATUS_PROOF_PLAN = {
  name: 'Task status all states proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'proof-task-pending', description: 'Pending', command: 'echo pending', dependencies: [] as string[] },
    { id: 'proof-task-running', description: 'Running', command: 'echo running', dependencies: [] as string[] },
    { id: 'proof-task-fixing', description: 'Fixing with AI', command: 'echo fixing', dependencies: [] as string[] },
    { id: 'proof-task-completed', description: 'Completed', command: 'echo completed', dependencies: ['proof-task-pending'] },
    { id: 'proof-task-failed', description: 'Failed', command: 'echo failed', dependencies: ['proof-task-running'] },
    { id: 'proof-task-closed', description: 'Closed', command: 'echo closed', dependencies: ['proof-task-fixing'] },
    { id: 'proof-task-needs-input', description: 'Needs input', command: 'echo input', dependencies: ['proof-task-completed'] },
    { id: 'proof-task-blocked', description: 'Blocked', command: 'echo blocked', dependencies: ['proof-task-failed'] },
    { id: 'proof-task-stale', description: 'Stale', command: 'echo stale', dependencies: ['proof-task-closed'] },
    { id: 'proof-task-review-ready', description: 'Review ready', command: 'echo review', dependencies: ['proof-task-closed', 'proof-task-stale'] },
    { id: 'proof-task-awaiting-approval', description: 'Await approval', command: 'echo approval', dependencies: ['proof-task-needs-input'] },
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
const TERMINAL_PLANNED_PLAN = {
  ...TEST_PLAN,
  name: 'Terminal Planned Flow',
};


const SSH_TERMINAL_RESUME_PLAN = {
  name: 'SSH Terminal Resume Visual Proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'ssh-resume',
      description: 'Completed SSH resume task',
      command: 'echo done',
      dependencies: [] as string[],
    },
  ],
};

const systemSetupReadinessDiagnostics = (configPath: string) => ({
  platform: 'linux',
  arch: 'x64',
  appVersion: '0.0.0-visual-proof',
  isPackaged: false,
  tools: [
    {
      id: 'git',
      name: 'Git',
      required: true,
      installed: true,
      version: 'git version 2.45.0',
      installHint: 'Install Git',
    },
    {
      id: 'claude',
      name: 'Claude CLI',
      required: false,
      installed: true,
      version: 'claude 2.0.0',
      installHint: 'Install Claude CLI',
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      required: false,
      installed: false,
      installHint: 'Install Codex CLI',
    },
  ],
  bundledSkills: {
    available: false,
    promptRecommended: false,
    managedPrefix: 'invoker-',
    bundledSkillNames: [],
    targets: [],
    commandTargets: [],
    mcpTargets: [],
  },
  cliInstaller: {
    supported: false,
    bundledVersion: '0.0.0-visual-proof',
    upToDate: false,
  },
  readiness: {
    ok: false,
    checks: [
      {
        id: 'config',
        name: 'Config file',
        status: 'ok',
        detail: `Parsed ${configPath}`,
      },
      {
        id: 'planning-tools',
        name: 'Planning tools',
        status: 'warn',
        detail: 'Codex preset is configured, but codex is not on PATH',
        remediation: 'Install Codex CLI before selecting Codex-backed planning presets',
      },
      {
        id: 'default-preset',
        name: 'Default planning preset',
        status: 'error',
        detail: 'Default preset "cursor+codex" needs "codex", which is not on PATH',
        remediation: 'Install codex, or set defaultSlackHarnessPreset to a preset whose tool is installed',
      },
    ],
  },
});
function workflowNode(page: Page, workflowId: string) {
  return page.getByTestId(`rf__node-${workflowId}`).first();
}

function taskNodeCard(page: Page, taskIdSuffix: string) {
  return page.locator(`.react-flow__node[data-testid$="${taskIdSuffix}"] > div`).first();
}

function statusProofWorkflowTaskId(status: string) {
  return `workflow-status-${status.replaceAll('_', '-')}`;
}

function statusProofLabel(status: string) {
  return status.replaceAll('_', ' ');
}

function taskStatusExecution(status: string, now: Date, earlier: Date) {
  switch (status) {
    case 'running':
      return { startedAt: earlier };
    case 'fixing_with_ai':
      return { startedAt: earlier, isFixingWithAI: true };
    case 'completed':
      return { startedAt: earlier, completedAt: now, exitCode: 0 };
    case 'failed':
      return { startedAt: earlier, completedAt: now, exitCode: 1, error: 'status proof failure' };
    case 'needs_input':
      return { startedAt: earlier, inputPrompt: 'Choose a status proof option' };
    case 'blocked':
      return { blockedBy: 'proof-task-failed' };
    case 'review_ready':
      return { startedAt: earlier, reviewUrl: 'https://example.test/status-proof' };
    case 'awaiting_approval':
      return { startedAt: earlier };
    case 'stale':
      return { startedAt: earlier, completedAt: now };
    case 'closed':
      return { completedAt: now };
    default:
      return {};
  }
}

async function minimizeInspectorIfVisible(page: Page) {
  const minimize = page.getByRole('button', { name: 'Minimize inspector' });
  if (await minimize.isVisible({ timeout: 1000 }).catch(() => false)) {
    await minimize.click();
    await expect(page.getByRole('button', { name: 'Maximize inspector' })).toBeVisible({ timeout: 5000 });
  }
}

async function expandSelectedWorkflowMiniDagForProof(page: Page) {
  const panel = page.getByTestId('selected-workflow-mini-dag');
  await expect(panel).toBeVisible({ timeout: 10000 });
  await panel.evaluate((element) => {
    const panelElement = element as HTMLElement;
    panelElement.style.left = '12px';
    panelElement.style.right = 'auto';
    panelElement.style.top = '12px';
    panelElement.style.width = '1040px';
    panelElement.style.height = '620px';
    panelElement.style.backgroundColor = '#111827';
    const content = panelElement.children.item(1) as HTMLElement | null;
    if (content) content.style.height = '590px';
  });
  await panel.getByRole('button', { name: 'Fit View' }).click();
  await page.waitForTimeout(300);
}

async function hideSelectedWorkflowMiniDagIfVisible(page: Page) {
  const panel = page.getByTestId('selected-workflow-mini-dag');
  if (await panel.isVisible({ timeout: 1000 }).catch(() => false)) {
    await panel.evaluate((element) => {
      (element as HTMLElement).style.display = 'none';
    });
  }
}

async function viewportTransform(viewport: Locator): Promise<string> {
  return viewport.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    return htmlElement.style.transform || getComputedStyle(htmlElement).transform || '';
  });
}

async function waitForStableViewportTransform(page: Page, viewport: Locator): Promise<string> {
  let previous = await viewportTransform(viewport);
  for (let i = 0; i < 10; i += 1) {
    await page.waitForTimeout(120);
    const current = await viewportTransform(viewport);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

function selectedTaskCard(miniDag: Locator, taskIdSuffix: string): Locator {
  return miniDag.locator(`.react-flow__node[data-testid$="${taskIdSuffix}"] > div[data-selected="true"]`).first();
}

/** Every DAG_DETERMINISM_PLAN task node must stay visible — the DAG also
 * renders a merge-gate node, so assert the named tasks instead of a count. */
async function expectDeterminismTasksVisible(miniDag: Locator) {
  for (const suffix of ['task-a', 'task-b', 'task-c', 'task-d', 'task-e']) {
    await expect(miniDag.locator(`.react-flow__node[data-testid$="${suffix}"]`)).toBeVisible();
  }
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
async function selectGraphMenuItem(page: Page, testId: string): Promise<void> {
  await page.getByTestId('graph-more-button').click();
  await expect(page.getByTestId('graph-more-menu')).toBeVisible();
  await page.getByTestId(testId).click({ force: true });
}

async function expectQueueViewVisible(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /Worker Actions/ })).toBeVisible();
  await expect(page.getByTestId('running-queue-section-running')).toBeVisible();
  await expect(page.getByTestId('running-queue-section-queued')).toBeVisible();
}


async function selectWorkflowNode(page: Page, workflowId: string): Promise<void> {
  const node = workflowNode(page, workflowId);
  const miniDag = page.getByTestId('selected-workflow-mini-dag');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await node.waitFor({ state: 'attached', timeout: 15000 });
    await node.scrollIntoViewIfNeeded();
    try {
      await node.click({ force: true });
    } catch {
      await node.dispatchEvent('click', { bubbles: true });
    }
    if (!(await miniDag.isVisible({ timeout: 1500 }).catch(() => false))) {
      await node.dispatchEvent('click', { bubbles: true });
    }
    if (await miniDag.isVisible({ timeout: 1500 }).catch(() => false)) {
      return;
    }
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);
  }

  await expect(miniDag).toBeVisible({ timeout: 10000 });
}

async function loadPlanAndSelectWorkflow(page: Page, plan: unknown): Promise<string> {
  const beforeIds = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.map((workflow: { id: string }) => workflow.id);
  });
  await page.evaluate((yaml) => window.invoker.loadPlan(yaml), yamlStringify(plan));
  const workflow = await page.evaluate(async (knownIds) => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.find((candidate: { id: string }) => !knownIds.includes(candidate.id))
      ?? workflows[workflows.length - 1]
      ?? null;
  }, beforeIds);
  expect(workflow?.id).toBeTruthy();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForTimeout(300);
  await selectWorkflowNode(page, workflow!.id);
  return workflow!.id;
}
async function seedActiveLaunchAttempt(dbPath: string, taskId: string, attemptId: string, now: Date): Promise<void> {
  const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  try {
    adapter.saveAttempt({
      id: attemptId,
      nodeId: taskId,
      queuePriority: 0,
      upstreamAttemptIds: [],
      status: 'claimed',
      claimedAt: now,
      lastHeartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    });
  } finally {
    adapter.close();
  }
}
async function seedWorkerTimelineActions(
  dbPath: string,
  workflowId: string,
  taskIds: { alpha: string; beta: string },
): Promise<WorkerActionWrite[]> {
  const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  const actions: WorkerActionWrite[] = [
    {
      id: 'alpha-repair',
      workerKind: 'autofix',
      actionType: 'repair',
      workflowId,
      taskId: taskIds.alpha,
      subjectType: 'task',
      subjectId: taskIds.alpha,
      externalKey: `timeline:${workflowId}:alpha-repair`,
      status: 'completed',
      summary: 'Repair finished cleanly.',
      payload: { reason: 'Autofix picked the failing task.' },
      createdAt: '2024-01-01T00:00:10Z',
      updatedAt: '2024-01-01T00:00:20Z',
      completedAt: '2024-01-01T00:00:20Z',
    },
    {
      id: 'alpha-review',
      workerKind: 'pr-summary-refresh',
      actionType: 'refresh-review',
      workflowId,
      taskId: taskIds.beta,
      subjectType: 'task',
      subjectId: taskIds.beta,
      externalKey: `timeline:${workflowId}:alpha-review`,
      status: 'completed',
      summary: 'Updated review metadata.',
      createdAt: '2024-01-01T00:00:30Z',
      updatedAt: '2024-01-01T00:00:40Z',
      completedAt: '2024-01-01T00:00:40Z',
    },
    {
      id: 'alpha-inspect',
      workerKind: 'autofix',
      actionType: 'inspect',
      workflowId,
      taskId: taskIds.alpha,
      subjectType: 'task',
      subjectId: taskIds.alpha,
      externalKey: `timeline:${workflowId}:alpha-inspect`,
      status: 'running',
      payload: { reason: 'Selected task still has open execution output.' },
      createdAt: '2024-01-01T00:00:50Z',
      updatedAt: '2024-01-01T00:00:55Z',
    },
  ];
  try {
    for (const action of actions) {
      adapter.upsertWorkerAction(action);
    }
    return actions;
  } finally {
    adapter.close();
  }
}

test.describe('Read-only mode visual proof', () => {
  test.use({ guiOwnerMode: 'read-only-status' });

  test('read-only mode banner', async ({ page }) => {
    await expect(page.getByTestId('read-only-mode-banner')).toContainText('Read-only mode.', { timeout: 5000 });
    await expect(page.getByTestId('read-only-mode-banner')).toContainText('This window can browse workflows');
    await captureScreenshot(page, 'read-only-mode-banner');
  });
});

test.describe('Connection lost visual proof', () => {
  test.use({ guiOwnerMode: 'connection-lost-status' });

  test('connection lost banner', async ({ page }) => {
    await expect(page.getByTestId('connection-lost-banner')).toContainText('Connection lost.', { timeout: 5000 });
    await expect(page.getByTestId('connection-lost-banner')).toContainText('lost contact with the write owner');
    await captureScreenshot(page, 'connection-lost-banner');
  });
});

test.describe('Visual proof capture', () => {
  test('history view — task state timeline', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 60_000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now, exitCode: 0 },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'failed',
          execution: {
            startedAt: earlier,
            completedAt: now,
            exitCode: 1,
            error: 'Command exited non-zero',
          },
        },
      },
      {
        taskId: 'task-gamma',
        changes: {
          status: 'fixing_with_ai',
          execution: { startedAt: earlier },
        },
      },
    ]);
    await selectGraphMenuItem(page, 'rail-history');
    await expect(page.getByTestId('history-view')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search history' })).toBeVisible();
    await expect(page.getByText('First test task')).toBeVisible();
    await expect(page.getByTestId('history-view').getByText('Second test task depending on alpha').first()).toBeVisible();
    await expect(page.getByText('Completed').first()).toBeVisible();
    await expect(page.getByText('Failed').first()).toBeVisible();
    await expect(page.getByText('Autofixing').first()).toBeVisible();
    await captureScreenshot(page, 'history-view-task-state-timeline');
  });

  test('empty state', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('What do you want to build?')).toHaveCount(0);
    await expect(page.getByText('What to expect')).toBeVisible();
    await expect(page.getByTestId('workflow-graph-surface').getByText('Your plan will appear here.')).toBeVisible();
    await expect(page.getByTestId('sidebar-home')).toHaveAttribute('aria-label', 'Go home');
    await expect(page.getByTestId('sidebar-planning')).toHaveAttribute('aria-label', 'Planning Terminal');
    await expect(page.getByTestId('sidebar-workflows')).toHaveAttribute('aria-label', 'Workflows');
    await expect(page.getByTestId('sidebar-attention')).toHaveAttribute('aria-label', 'Needs Attention');
    await expect(page.getByTestId('sidebar-running')).toBeAttached();
    await expect(page.getByTestId('rail-settings')).toBeVisible();
    await expect(page.getByTestId('sidebar-home')).toBeVisible();
    await captureScreenshot(page, 'empty-state');
    await captureScreenshot(page, 'empty-graph-state');
    await assertPageScreenshot(page, 'empty-state');
  });

  test('workflow delete propagation', async ({ page }) => {
    const workflowId = await loadPlanAndSelectWorkflow(page, TEST_PLAN);
    await expect(workflowNode(page, workflowId)).toBeVisible();
    await captureScreenshot(page, 'workflow-delete-before');

    await page.evaluate((id) => window.invoker.deleteWorkflow(id), workflowId);

    await page.waitForTimeout(3000);
    await captureScreenshot(page, 'workflow-delete-after-3s');
  });

  test('terminal planning loads graph', async ({ page }) => {
    const plannedYaml = yamlStringify(TERMINAL_PLANNED_PLAN);
    // Mirror the real planner reply shape: prose followed by the full fenced
    // plan YAML. The transcript must render every line of it untruncated
    // (regression: planning terminal plan truncation).
    const fullPlanReply = `I drafted the plan.\n\n\`\`\`yaml\n${plannedYaml}\`\`\``;
    await page.evaluate(async ({ planYaml, planName, reply }) => {
      await window.invoker.setTestPlanningChatResponse({ planYaml, planName, reply });
    }, { planYaml: plannedYaml, planName: 'Terminal Planned Flow', reply: fullPlanReply });

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-60/);
    await expect(page.getByTestId('planning-session-rail')).toHaveClass(/w-64/);
    await expect(page.getByRole('heading', { name: 'Planning Terminal' })).toBeVisible();
    await page.getByTestId('invoker-terminal-input').fill('Add README');
    await page.getByRole('button', { name: 'Send' }).click();

    // The conversation renders in the terminal transcript: the user message,
    // the assistant prose, and the drafted plan YAML from first to last line.
    const transcript = page.getByTestId('invoker-terminal-transcript');
    await expect(transcript).toContainText('Add README');
    await expect(transcript).toContainText('I drafted the plan.');
    await expect(transcript).toContainText('name: Terminal Planned Flow');
    await expect(transcript).toContainText('sleep 5 && echo hello-alpha');
    await expect(transcript).toContainText('sleep 2 && echo hello-gamma');

    await captureScreenshot(page, 'terminal-planned-conversation');

    // Expand the chat and scroll the transcript to the very end: the last
    // YAML line must be reachable, proving nothing was cut off.
    await page.getByRole('button', { name: 'Expand planning chat' }).click();
    await expect(page.getByTestId('invoker-terminal-expanded')).toBeVisible();
    const expandedTranscript = page
      .getByTestId('invoker-terminal-expanded')
      .getByTestId('invoker-terminal-transcript');
    const scrollGap = await expandedTranscript.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollHeight - el.scrollTop - el.clientHeight;
    });
    expect(scrollGap).toBeLessThanOrEqual(1);
    const tailText = await expandedTranscript.evaluate((el) => el.textContent ?? '');
    expect(tailText.trimEnd().endsWith('```')).toBe(true);
    expect(tailText).toContain('command: echo B');
    await captureScreenshot(page, 'terminal-planned-conversation-end');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('invoker-terminal-expanded')).toHaveCount(0);

    await expect(page.getByTestId('invoker-terminal-ready-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Submit to Invoker' }).click();

    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await expect(page.getByTestId('workflow-inspector-title')).toContainText('Terminal Planned Flow');
    await expect(page.getByText('What to expect')).toHaveCount(0);
    await captureScreenshot(page, 'terminal-planned-graph');

    // Returning to the Planning Terminal keeps the full conversation:
    // submitting must not clear or truncate the transcript.
    await page.getByTestId('sidebar-planning').click();
    await expect(transcript).toContainText('Add README');
    await expect(transcript).toContainText('sleep 2 && echo hello-gamma');
    await expect(transcript).toContainText('Plan "Terminal Planned Flow" submitted to Invoker. Review it, then use Start ready work.');
    await captureScreenshot(page, 'terminal-planned-conversation-after-submit');

    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });

  test('terminal planning captures long transcript follow surface', async ({ page }) => {
    const longTranscriptPlan = {
      ...TERMINAL_PLANNED_PLAN,
      name: 'Planning Chat Long Transcript',
      tasks: Array.from({ length: 18 }, (_, index) => {
        const step = String(index + 1).padStart(2, '0');
        const previousStep = String(index).padStart(2, '0');
        return {
          id: `long-transcript-task-${step}`,
          description: `Long transcript visual proof task ${step}`,
          command: `echo long-transcript-${step}`,
          dependencies: index === 0 ? [] : [`long-transcript-task-${previousStep}`],
        };
      }),
    };
    const plannedYaml = yamlStringify(longTranscriptPlan);
    const stepOneReply = `Step 1 response: transcript should stay pinned while a long reply streams in.\n\n${Array.from(
      { length: 24 },
      (_, index) => `Step 1 follow-state line ${String(index + 1).padStart(2, '0')}: keep the planning chat anchored at the newest reply.`,
    ).join('\n')}`;
    const stepTwoReply = `Step 2 response: transcript should stay put after manual page-up.\n\n${Array.from(
      { length: 24 },
      (_, index) => `Step 2 stay-put line ${String(index + 1).padStart(2, '0')}: do not force-scroll the reader back to the bottom.`,
    ).join('\n')}`;
    const stepThreeReply = `Step 3 response: a new planning chat should repin at the bottom.\n\n${Array.from(
      { length: 24 },
      (_, index) => `Step 3 repin line ${String(index + 1).padStart(2, '0')}: switching chats resets follow mode for the new conversation.`,
    ).join('\n')}`;

    const queueReply = async (replyText: string, planName: string) => {
      await page.evaluate(async ({ planYaml, nextPlanName, reply }) => {
        await window.invoker.setTestPlanningChatResponse({
          planYaml,
          planName: nextPlanName,
          reply,
        });
      }, { planYaml: plannedYaml, nextPlanName: planName, reply: replyText });
    };

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByRole('heading', { name: 'Planning Terminal' })).toBeVisible();

    const transcript = page.getByTestId('invoker-terminal-transcript');
    const input = page.getByTestId('invoker-terminal-input');
    const send = page.getByRole('button', { name: 'Send' });
    const sessionList = page.getByTestId('planning-session-list');

    await queueReply(stepOneReply, 'Planning Chat Long Transcript');
    await input.fill('Step 1 — draft a long transcript proof plan');
    await send.click();

    await expect(transcript).toContainText('Step 1 follow-state line 24');
    const stepOneScrollGap = await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(stepOneScrollGap).toBeLessThanOrEqual(32);
    await captureScreenshot(page, 'terminal-planning-long-transcript-step-1-pinned');

    await transcript.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    const stepTwoPreSendScrollGap = await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(stepTwoPreSendScrollGap).toBeGreaterThan(200);

    await queueReply(stepTwoReply, 'Planning Chat Long Transcript');
    await input.fill('Step 2 — keep streaming but stay put');
    await send.click();

    await expect(sessionList).toContainText('Step 2 response: transcript should stay put after manual page-up.');
    const stepTwoScrollGap = await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(stepTwoScrollGap).toBeGreaterThan(200);
    await captureScreenshot(page, 'terminal-planning-long-transcript-step-2-stay-put');

    await page.getByRole('button', { name: 'New' }).click();
    await expect(page.getByText('2 chats')).toBeVisible();
    await queueReply(stepThreeReply, 'Planning Chat Repin Transcript');
    await input.fill('Step 3 — new chat should repin');
    await send.click();

    await expect(transcript).toContainText('Step 3 repin line 24');
    const stepThreeScrollGap = await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(stepThreeScrollGap).toBeLessThanOrEqual(32);
    await captureScreenshot(page, 'terminal-planning-long-transcript-step-3-repin');

    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });

  test('planner retry exhausted surfaces raw error to chat and error card', async ({ page }) => {
    // Reproduces the user-visible surface after all planner retries fail.
    // The exhausted-retry error message is generated by
    // packages/surfaces/src/slack/plan-conversation.ts buildEmptyPlannerOutputError
    // with attemptCount > 1. The visual proof shows that the raw error
    // message (including "after N attempts" and the stderr tail) is rendered
    // both as an error-toned SYSTEM line in the transcript AND as a
    // prominent "Planner could not respond" card with Copy error / Keep
    // chatting affordances, even on a first-message failure with no draft
    // plan available. The Retry submit button is intentionally absent when
    // there is no draft to retry.
    const exhaustedRetryError = 'agent exited 0 but produced no output after 3 attempts — stderr tail: cursor: session expired; run `cursor login` to re-authenticate';
    await page.evaluate(async (throwError) => {
      await window.invoker.setTestPlanningChatResponse({ throwError });
    }, exhaustedRetryError);

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByRole('heading', { name: 'Planning Terminal' })).toBeVisible();
    await page.getByTestId('invoker-terminal-input').fill('Draft me an Invoker plan');
    await page.getByRole('button', { name: 'Send' }).click();

    const submitError = page.getByTestId('invoker-terminal-submit-error');
    await expect(submitError).toBeVisible();
    await expect(submitError).toContainText('Planner could not respond');
    await expect(submitError).toContainText('after 3 attempts');
    await expect(submitError).toContainText('cursor: session expired');
    await expect(submitError.getByRole('button', { name: 'Copy error' })).toBeVisible();
    await expect(submitError.getByRole('button', { name: 'Keep chatting' })).toBeVisible();
    await expect(submitError.getByRole('button', { name: 'Retry submit' })).toHaveCount(0);

    const transcript = page.getByTestId('invoker-terminal-transcript');
    await expect(transcript).toContainText('after 3 attempts');
    await expect(transcript).toContainText('cursor: session expired');

    await captureScreenshot(page, 'planner-retry-exhausted-error');

    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });

  test('planning chat long transcript — scrollable surface with follow pinned to bottom', async ({ page }) => {
    // Render a long planning transcript by sending several user messages and
    // returning a long assistant reply for each turn. This exercises the same
    // setTestPlanningChatResponse helper used by the other planning proofs and
    // produces a scrollable transcript surface suitable for a visual snapshot.
    const longReplyLines = Array.from(
      { length: 30 },
      (_, index) => `Assistant line ${index + 1}: ${'lorem ipsum dolor sit amet '.repeat(4)}`,
    );
    const planYaml = yamlStringify({
      name: 'Long Transcript Visual Proof',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'lt-proof',
          description: 'Long transcript proof task',
          command: 'echo ok',
          dependencies: [] as string[],
        },
      ],
    });

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByRole('heading', { name: 'Planning Terminal' })).toBeVisible();

    const transcript = page.getByTestId('invoker-terminal-transcript');
    await expect(transcript).toBeVisible();

    const sendCount = 5;
    for (let i = 0; i < sendCount; i += 1) {
      const marker = `long-reply-marker-${i + 1}`;
      const reply = [`${marker}`, ...longReplyLines].join('\n');
      await page.evaluate(async ({ planYaml: py, replyText }) => {
        await window.invoker.setTestPlanningChatResponse({ planYaml: py, reply: replyText });
      }, { planYaml: planYaml, replyText: reply });

      await page.getByTestId('invoker-terminal-input').fill(`Prompt ${i + 1}`);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(transcript).toContainText(marker);
    }

    await expect(transcript).toContainText('Prompt 1');
    await expect(transcript).toContainText(`Prompt ${sendCount}`);
    await expect(transcript).toContainText('Assistant line 30');

    const { scrollHeight, clientHeight, scrollTop } = await transcript.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));
    expect(scrollHeight).toBeGreaterThan(clientHeight);
    // Follow mode should have kept the transcript pinned to the bottom after
    // the last assistant reply arrived.
    expect(scrollHeight - scrollTop - clientHeight).toBeLessThanOrEqual(1);

    await captureScreenshot(page, 'planning-chat-long-transcript');

    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });

  test('terminal planning submits Workers Surface as stacked workflows', async ({ page }) => {
    const plannedYaml = yamlStringify(WORKERS_SURFACE_STACKED_PLAN);
    await page.evaluate(async ({ planYaml, planName }) => {
      await window.invoker.setTestPlanningChatResponse({ planYaml, planName, reply: 'I drafted the stacked plan.' });
    }, { planYaml: plannedYaml, planName: 'Workers Surface' });

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByRole('heading', { name: 'Planning Terminal' })).toBeVisible();
    await expect(page.getByText('Still discussing')).toBeVisible();
    await expect(page.getByText('What do you want to build?')).toHaveCount(0);
    await expect(page.getByText('Ask Invoker what you want to build.')).toHaveCount(0);
    await expect(page.getByTestId('invoker-terminal-input')).toBeVisible();
    await page.getByTestId('invoker-terminal-input').fill('Build the Workers Surface');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByTestId('invoker-terminal-ready-bar')).toBeVisible();
    await page.getByRole('button', { name: 'Submit to Invoker' }).click();

    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Workers Surface Contracts/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Workers Surface UI/ })).toBeVisible();
    await expect(page.getByTestId('workflow-inspector-title')).toContainText(/Workers Surface (Contracts|UI)/);
    await captureScreenshot(page, 'stacked-workflows');

    const stack = await page.evaluate(async () => {
      const workflows = await window.invoker.listWorkflows();
      return workflows
        .filter((workflow: any) => workflow.name === 'Workers Surface Contracts' || workflow.name === 'Workers Surface UI')
        .map((workflow: any) => ({
          id: workflow.id,
          name: workflow.name,
          baseBranch: workflow.baseBranch,
          featureBranch: workflow.featureBranch,
          externalDependencies: workflow.externalDependencies,
        }));
    });

    expect(stack).toHaveLength(2);
    const contracts = stack.find((workflow) => workflow.name === 'Workers Surface Contracts');
    const ui = stack.find((workflow) => workflow.name === 'Workers Surface UI');
    expect(contracts).toBeDefined();
    expect(ui).toBeDefined();
    expect(ui!.baseBranch).toBe(contracts!.featureBranch);
    expect(ui!.externalDependencies).toEqual([
      {
        workflowId: contracts!.id,
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
      },
    ]);

    await page.evaluate(async () => {
      await window.invoker.setTestPlanningChatResponse(null);
    });
  });

  test('workflows browser and home return', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await page.getByTestId('sidebar-workflows').click();
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Menu Proof Workflow/ }).first()).toBeVisible();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-60/);
    await expect(page.getByText('Invoker Terminal')).toHaveCount(0);
    await captureScreenshot(page, 'workflows-browser');

    await page.getByTestId('browser-rail-dismiss').click();
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-16/);
  });
  test('needs attention browser focuses the selected task', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'failed',
          execution: { exitCode: 1, stderr: 'failed for browser proof' },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'blocked',
          execution: { blockedBy: 'task-alpha' },
        },
      },
    ]);

    await page.getByTestId('sidebar-attention').click();
    await expect(page.getByTestId('browser-rail')).toHaveClass(/w-64/);
    await expect(page.getByTestId('browser-rail').getByRole('heading', { name: 'Needs Attention' })).toBeVisible();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-60/);
    await expect(page.getByRole('heading', { name: 'First test task' }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Partial terminal drawer' })).toBeVisible();
    await expect(page.getByText('More needs attention')).toHaveCount(0);

    const taskGraphPanel = page.getByTestId('selected-workflow-mini-dag');
    const graphSurface = page.getByTestId('workflow-graph-surface');
    const taskAlphaNode = taskGraphPanel.locator('.react-flow__node[data-testid$="task-alpha"]');
    const taskGraphBox = await taskGraphPanel.boundingBox();
    const graphSurfaceBox = await graphSurface.boundingBox();
    expect(taskGraphBox).not.toBeNull();
    expect(graphSurfaceBox).not.toBeNull();
    expect((taskGraphBox?.height ?? 0) / (graphSurfaceBox?.height ?? 1)).toBeGreaterThan(0.8);
    await expect(taskAlphaNode).toBeVisible();
    await expect(page.getByTestId('workflow-status-chips')).toHaveCount(0);
    await expect(page.getByTestId('terminal-drawer')).toBeVisible();
    await page.waitForTimeout(500);

    await captureScreenshot(page, 'needs-attention-browser');

    await page.getByRole('button', { name: 'Full graph' }).click();
    await expect(page.getByRole('heading', { name: 'Full graph' })).toBeVisible();
    await captureScreenshot(page, 'needs-attention-browser-full-graph');
    await page.getByTestId('graph-maximized-overlay').getByRole('button', { name: 'Close' }).click();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('workflow-inspector-shell')).toHaveClass(/w-96/);
    await captureScreenshot(page, 'needs-attention-browser-narrow');
  });


  test('collapsible workflow browsers', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await page.getByTestId('sidebar-workflows').click();
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-60/);

    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-16/);
    await captureScreenshot(page, 'collapsed-workflow-browsers');

    await page.getByTestId('sidebar-home').click();
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-16/);

    await page.getByTestId('sidebar-workflows').click();
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-16/);

    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect(page.getByTestId('app-sidebar')).toHaveClass(/w-60/);
  });

  test('sidebar-default-width — home to workflows keeps auto-collapsed width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    const sidebar = page.getByTestId('app-sidebar');

    // Capture the full Home -> Workflows -> Home sequence before asserting so a
    // buggy build still records the width snap (regression: Home expanded, then
    // Workflows collapsed).
    await page.getByTestId('sidebar-home').click();
    await captureScreenshot(page, 'sidebar-default-width-1-home');

    await page.getByTestId('sidebar-workflows').click();
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
    await captureScreenshot(page, 'sidebar-default-width-2-workflows');

    await page.getByTestId('sidebar-home').click();
    await captureScreenshot(page, 'sidebar-default-width-3-home-return');

    await page.getByTestId('sidebar-workflows').click();
    await expect(sidebar).toHaveClass(/w-16/);
    await page.getByTestId('sidebar-home').click();
    await expect(sidebar).toHaveClass(/w-16/);
  });

  test('sidebar-collapse-state — manual sidebar width survives left rail navigation', async ({ page }) => {
    const sidebar = page.getByTestId('app-sidebar');

    await page.getByTestId('sidebar-workflows').click();
    await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
    await expect(sidebar).toHaveClass(/w-60/);

    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect(sidebar).toHaveClass(/w-16/);

    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect(sidebar).toHaveClass(/w-60/);
    await captureScreenshot(page, 'sidebar-collapse-state-1-workflows-manually-expanded');

    // Screenshots precede the width assertions so a buggy build still records
    // the snap-back frame (regression: navigation overwrote the manual choice).
    await page.getByTestId('sidebar-attention').click();
    await expect(page.getByRole('heading', { name: 'Needs Attention' })).toBeVisible();
    await captureScreenshot(page, 'sidebar-collapse-state-2-attention-after-navigation');
    await expect(sidebar).toHaveClass(/w-60/);

    for (const surface of ['workers', 'workflows'] as const) {
      await page.getByTestId(`sidebar-${surface}`).click();
      await expect(sidebar).toHaveClass(/w-60/);
    }

    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect(sidebar).toHaveClass(/w-16/);
    await captureScreenshot(page, 'sidebar-collapse-state-3-workflows-manually-collapsed');

    await page.getByTestId('sidebar-home').click();
    await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
    await captureScreenshot(page, 'sidebar-collapse-state-4-home-still-collapsed');
    await expect(sidebar).toHaveClass(/w-16/);

    for (const surface of ['planning', 'workflows'] as const) {
      await page.getByTestId(`sidebar-${surface}`).click();
      await expect(sidebar).toHaveClass(/w-16/);
    }
  });
  test('dag loaded', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-beta"]')).toBeVisible();
    await captureScreenshot(page, 'dag-loaded');
    await assertPageScreenshot(page, 'dag-loaded');
  });

  test('system setup readiness report shows a failing default preset check', async ({ page, electronApp }) => {
    const configPath = await electronApp.evaluate(() => process.env.INVOKER_REPO_CONFIG_PATH);
    if (!configPath) throw new Error('INVOKER_REPO_CONFIG_PATH was not injected into the Electron test app');
    const diagnostics = systemSetupReadinessDiagnostics(configPath);

    await electronApp.evaluate(({ ipcMain }, diagnostics) => {
      ipcMain.removeHandler('invoker:get-system-diagnostics');
      ipcMain.handle('invoker:get-system-diagnostics', () => diagnostics);
    }, diagnostics);

    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
    await expect(page.getByTestId('rail-settings')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('rail-settings').click();

    await expect(page.getByRole('heading', { name: 'System Setup' })).toBeVisible();
    await expect(page.getByText('Readiness')).toBeVisible();
    await expect(page.getByText('Config file')).toBeVisible();
    await expect(page.getByText(`Parsed ${configPath}`)).toBeVisible();
    await expect(page.getByText('Planning tools')).toBeVisible();
    await expect(page.getByText('Default planning preset')).toBeVisible();
    await expect(page.getByText('Default preset "cursor+codex" needs "codex", which is not on PATH')).toBeVisible();
    await expect(page.getByText('Install codex, or set defaultSlackHarnessPreset to a preset whose tool is installed')).toBeVisible();

    await captureScreenshot(page, 'system-setup-readiness');
  });

  test('graph maximize overlay', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await page.getByRole('button', { name: 'Full graph ⤢' }).click();
    await expect(page.getByTestId('graph-maximized-overlay')).toBeVisible();
    await captureScreenshot(page, 'graph-maximized-overlay');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('graph-maximized-overlay')).toHaveCount(0);
  });
  test('task-graph-keyboard-controls-selected — selected workflow mini DAG framing', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    const miniDag = page.getByTestId('selected-workflow-mini-dag');
    await expect(miniDag).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-beta"]')).toBeVisible();
    await captureScreenshot(page, 'task-graph-keyboard-controls-selected');
  });

  test('graph-camera-lock-navigation — task graph remains usable after keyboard and manual camera moves', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, DAG_DETERMINISM_PLAN);
    await minimizeInspectorIfVisible(page);
    await expandSelectedWorkflowMiniDagForProof(page);

    const miniDag = page.getByTestId('selected-workflow-mini-dag');
    const taskGraphRegion = miniDag.locator('[data-keyboard-region="taskGraph"]');
    const viewport = miniDag.locator('.react-flow__viewport').first();
    const pane = miniDag.locator('.react-flow__pane').first();

    await expect(miniDag.locator('.react-flow__node[data-testid$="task-a"]')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-b"]')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-c"]')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-d"]')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-e"]')).toBeVisible();

    await page.keyboard.press(' ');
    await expect(taskGraphRegion).toHaveAttribute('data-keyboard-active', 'true');

    await page.keyboard.press('Home');
    await expect(selectedTaskCard(miniDag, 'task-a')).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('F1');
    await page.waitForTimeout(300);
    const enabledAfterFirstF1 = await page.evaluate(() => {
      const raw = localStorage.getItem('invoker.ui.cameraLockPreference');
      if (!raw) return true;
      try {
        return JSON.parse(raw)?.enabled !== false;
      } catch {
        return true;
      }
    });
    if (!enabledAfterFirstF1) {
      await page.keyboard.press('F1');
      await page.waitForTimeout(300);
    }
    await expect(selectedTaskCard(miniDag, 'task-a')).toBeVisible();

    await page.keyboard.press('ArrowRight');
    await expect(selectedTaskCard(miniDag, 'task-a')).toHaveCount(0);
    await expect(miniDag.locator('.react-flow__node > div[data-selected="true"]')).toBeVisible();

    await pane.hover();
    await page.mouse.wheel(0, 420);
    await page.waitForTimeout(300);
    await expectDeterminismTasksVisible(miniDag);

    await miniDag.locator('.react-flow__node[data-testid$="task-e"]').click();
    await expect(selectedTaskCard(miniDag, 'task-e')).toBeVisible({ timeout: 5000 });
    await expectDeterminismTasksVisible(miniDag);

    const beforeKeyboardMenu = await waitForStableViewportTransform(page, viewport);
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible({ timeout: 5000 });
    await expect(menu).toContainText('Open Terminal');
    expect(await waitForStableViewportTransform(page, viewport)).toBe(beforeKeyboardMenu);

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(menu).toBeVisible();
    expect(await waitForStableViewportTransform(page, viewport)).toBe(beforeKeyboardMenu);

    await captureScreenshot(page, 'graph-camera-lock-navigation');

    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
    expect(await waitForStableViewportTransform(page, viewport)).toBe(beforeKeyboardMenu);
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
  test.describe('timeline worker proof', () => {
    test.use({ guiOwnerMode: 'local' });

    test('timeline workers mode', async ({ page, testDir }) => {
      const workflowId = await loadPlanAndSelectWorkflow(page, TEST_PLAN);
      const tasks = await getTasks(page);
      const alphaTask = tasks.find((task: { id: string; config?: { workflowId?: string } }) => task.id.endsWith('task-alpha'));
      const betaTask = tasks.find((task: { id: string; config?: { workflowId?: string } }) => task.id.endsWith('task-beta'));
      expect(alphaTask?.id).toBeTruthy();
      expect(betaTask?.id).toBeTruthy();
      const timelineWorkflowId = alphaTask?.config?.workflowId ?? workflowId;
      expect(timelineWorkflowId).toBeTruthy();

      const seededActions = await seedWorkerTimelineActions(path.join(testDir, 'invoker.db'), timelineWorkflowId, {
        alpha: alphaTask!.id,
        beta: betaTask!.id,
      });
      const seededAdapter = await SQLiteAdapter.create(path.join(testDir, 'invoker.db'), { ownerCapability: true });
      try {
        expect(seededAdapter.listWorkerActions({ workflowId: timelineWorkflowId }).map((action) => action.id)).toEqual([
          'alpha-inspect',
          'alpha-review',
          'alpha-repair',
        ]);
      } finally {
        seededAdapter.close();
      }
      await page.evaluate((actions) => window.invoker.ingestWorkerActions(actions), seededActions);

      await expect.poll(async () => {
        const response = await page.evaluate((id) => window.invoker.getWorkerDecisions({ workflowId: id, limit: 100, offset: 0 }), timelineWorkflowId);
        return response.actions.map((action) => action.id);
      }).toEqual(['alpha-inspect', 'alpha-review', 'alpha-repair']);

      await selectWorkflowNode(page, timelineWorkflowId);
      await selectGraphMenuItem(page, 'rail-timeline');

      const workerTimelineView = page.getByTestId('worker-timeline-view');
      const workerActionOrder = async () => workerTimelineView
        .locator('[data-testid^="worker-timeline-action-"]')
        .evaluateAll((elements) => elements
          .map((element) => element.getAttribute('data-testid'))
          .filter((value): value is string => Boolean(value)));

      await expect(page.getByTestId('timeline-mode-workers')).toHaveAttribute('aria-pressed', 'true');
      await expect(workerTimelineView).toBeVisible();
      await expect.poll(workerActionOrder).toEqual([
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-review-launched',
        'worker-timeline-action-alpha-review-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
      await captureScreenshot(page, 'timeline-worker-events');
      await assertPageScreenshot(page, 'timeline-worker-events');

      await page.getByTestId('worker-timeline-action-alpha-review-finished').click();
      await expect(page.getByTestId('workflow-inspector-title')).toContainText('Second test task depending on alpha');
      await captureScreenshot(page, 'timeline-worker-events-selected');
      await assertPageScreenshot(page, 'timeline-worker-events-selected');

      await page.getByTestId('worker-timeline-task-search').fill('first');
      await expect.poll(workerActionOrder).toEqual([
        'worker-timeline-action-alpha-repair-launched',
        'worker-timeline-action-alpha-repair-finished',
        'worker-timeline-action-alpha-inspect-launched',
      ]);
      await expect(page.getByTestId('worker-timeline-row-alpha-repair-launched')).toContainText('Autofix');
      await expect(page.getByTestId('worker-timeline-row-alpha-inspect-launched')).toContainText('Autofix');
      await expect(page.getByTestId('worker-timeline-action-alpha-review-launched')).toHaveCount(0);
      await captureScreenshot(page, 'timeline-worker-events-search');
      await assertPageScreenshot(page, 'timeline-worker-events-search');

      await page.getByTestId('timeline-mode-tasks').click();
      await expect(page.getByTestId(`timeline-bar-${alphaTask!.id}`)).toBeVisible();
      await expect(page.getByTestId(`timeline-bar-${betaTask!.id}`)).toBeVisible();
      await captureScreenshot(page, 'timeline-worker-tasks-mode');
      await assertPageScreenshot(page, 'timeline-worker-tasks-mode');
    });
  });

  test('task panel', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').click();
    await expect(page.getByTestId('workflow-inspector-title')).toBeVisible();
    await expect(page.getByText('sleep 5 && echo hello-alpha')).toBeVisible();
    await captureScreenshot(page, 'task-panel');
    await assertPageScreenshot(page, 'task-panel');
  });

  test('embedded-tabbed-terminal — drawer opens partial with active task tab', async ({ page, testDir }) => {
    await loadPlan(page, TEST_PLAN);

    // Materialise a real workspace dir so the main-process executor can resolve
    // a terminal spec and spawn an embedded shell without a remote SSH target.
    const workspacePath = path.join(testDir, 'embedded-terminal-workspace');
    await fs.mkdir(workspacePath, { recursive: true });

    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now, workspacePath },
        },
      },
    ]);

    // Drawer starts minimized.
    await expect(page.getByRole('button', { name: 'Partial terminal drawer' })).toBeVisible();
    await expect(page.getByTestId('terminal-drawer-body')).toHaveCount(0);

    const taskCard = page.locator('[title$="task-alpha"]').first();
    await expect(taskCard).toBeVisible({ timeout: 10000 });
    await taskCard.dispatchEvent('dblclick');

    // Drawer opens partial; one active tab for task-alpha; terminal pane rendered.
    await expect(page.getByRole('button', { name: 'Maximize terminal drawer' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible();
    const tabs = page.getByTestId('terminal-tab-strip').locator('[data-testid^="terminal-tab-"]');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute('data-active', 'true');
    await expect(tabs.first()).toContainText('First test task');
    await expect(page.locator('[data-testid^="terminal-pane-"]').first()).toBeVisible();

    await captureScreenshot(page, 'embedded-tabbed-terminal');
  });

  test('task panel setup failure renders in Error panel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await selectWorkflowNode(page, 'wf-test-1');
    await waitForStableViewportTransform(page, page.getByTestId('workflow-graph-surface').locator('.react-flow__viewport').first());
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

    await page.getByTestId('selected-workflow-mini-dag').locator('.react-flow__node[data-testid$="task-alpha"]').click({ force: true });
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
    await selectWorkflowNode(page, 'wf-test-1');
    await waitForStableViewportTransform(page, page.getByTestId('workflow-graph-surface').locator('.react-flow__viewport').first());

    // Before: DAG loaded, no task selected
    await assertPageScreenshot(page, 'dag-before-selection');

    // Action: click a task node to open the detail panel
    await page.locator('.react-flow__node[data-testid$="task-beta"]').click();
    await expect(page.getByRole('heading', { name: 'Second test task depending on alpha' })).toBeVisible();

    // After: task panel is open
    await assertPageScreenshot(page, 'dag-after-selection');
  });

  test('stable-layout-and-dag-ordering — deterministic dag layout', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, DAG_DETERMINISM_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-a"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-b"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-c"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-d"]')).toBeVisible();
    await expect(page.locator('.react-flow__node[data-testid$="task-e"]')).toBeVisible();
    await waitForStableViewportTransform(page, page.getByTestId('workflow-graph-surface').locator('.react-flow__viewport').first());
    await captureScreenshot(page, 'deterministic-dag-layout');
    await assertPageScreenshot(page, 'deterministic-dag-layout');
  });

  test('status bar — no system log button', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await selectWorkflowNode(page, 'wf-test-1');
    await waitForStableViewportTransform(page, page.getByTestId('workflow-graph-surface').locator('.react-flow__viewport').first());
    const pendingChip = page.getByTestId('workflow-status-pill-pending');
    await expect(pendingChip).toBeVisible();
    await expect(pendingChip).toContainText('pending (1)');
    await expect(page.getByText('System Log')).toHaveCount(0);
    await captureScreenshot(page, 'status-bar-no-system-log');
    await assertPageScreenshot(page, 'status-bar-no-system-log');
  });

  test('fixing-with-ai vs fix-approval colors', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await selectWorkflowNode(page, 'wf-test-1');
    await waitForStableViewportTransform(page, page.getByTestId('workflow-graph-surface').locator('.react-flow__viewport').first());
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

    // Inline chip button must be gone — approval lives in the side panel now.
    await expect(mergeGateNode.locator('[data-testid="approve-merge-button"]')).toHaveCount(0);

    await mergeGateNode.click();
    await expect(page.getByRole('heading', { name: /Merge gate for/i })).toBeVisible();
    await expect(page.getByText('Task Status')).toBeVisible();
    await expect(page.getByTestId('inspector-approve-button')).toHaveText('Approve Merge');

    await captureScreenshot(page, 'merge-gate-no-inline-approve');
    await assertPageScreenshot(page, 'merge-gate-no-inline-approve');
  });

  test('closed-status-merge-gate — merge gate renders the terminal Closed status', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MERGE_GATE_CLOSED_PLAN);
    await page
      .locator('.react-flow__node[data-testid$="mg-closed-work"]')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 });

    const mergeGateTaskId = await page.evaluate(async () => {
      const result = await window.invoker.getTasks();
      const tasks = Array.isArray(result) ? result : result.tasks;
      const mergeTask = tasks.find((task: { id: string }) => task.id.includes('__merge__'));
      return mergeTask?.id ?? null;
    });
    expect(mergeGateTaskId).toBeTruthy();

    // Deterministic setup: drive the merge gate to `closed` directly — no real GitHub PR.
    await injectTaskStates(page, [
      {
        taskId: mergeGateTaskId!,
        changes: {
          status: 'closed',
          execution: {
            startedAt: new Date(Date.now() - 5000),
            completedAt: new Date(),
            reviewStatus: 'Closed without merge',
            reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/123',
          },
        },
      },
    ]);

    const mergeGateNode = page
      .locator(`.react-flow__node[data-testid="${mergeGateTaskId}"], .react-flow__node[data-testid$="${mergeGateTaskId}"]`)
      .first();
    await expect(mergeGateNode).toBeVisible({ timeout: 15000 });

    // Closed is the terminal status the gate displays — distinct from Failed (BLOCKED) and Review Ready.
    await expect(mergeGateNode.getByText('BLOCKED', { exact: true })).toHaveCount(0);
    await expect(mergeGateNode.getByText('REVIEW READY', { exact: true })).toHaveCount(0);

    await captureScreenshot(page, 'closed-status-merge-gate');
  });

  test('review gate stack side panel shows a linear PR chain', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MERGE_GATE_TEXT_VISUAL_PLAN);
    await page.locator('.react-flow__node[data-testid$="mg-visual-work"]').first().waitFor({ state: 'visible', timeout: 15000 });

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
        changes: {
          status: 'review_ready',
          execution: {
            reviewGate: {
              activeGeneration: 0,
              completion: { required: 'all', status: 'approved' },
              artifacts: [
                { id: 'contracts', title: 'Contracts PR', url: 'https://example.test/contracts', required: true, status: 'open', generation: 0 },
                { id: 'runtime', title: 'Runtime PR', url: 'https://example.test/runtime', required: true, status: 'open', generation: 0, dependsOn: ['contracts'] },
                { id: 'ui', title: 'UI PR', url: 'https://example.test/ui', required: true, status: 'open', generation: 0, dependsOn: ['runtime'] },
              ],
            },
          },
        },
      },
    ]);

    const mergeGateNode = page
      .locator(`.react-flow__node[data-testid="${mergeGateTaskId}"], .react-flow__node[data-testid$="${mergeGateTaskId}"]`)
      .first();
    await mergeGateNode.click();
    const stackSection = page.locator('section').filter({ hasText: 'Pull Request Stack' }).first();
    await expect(stackSection.getByText('Pull Request Stack')).toBeVisible();
    await expect(stackSection.getByText('Contracts PR')).toBeVisible();
    await expect(stackSection.getByText('Runtime PR')).toBeVisible();
    await expect(stackSection.getByText('UI PR')).toBeVisible();
    await expect(stackSection.getByTestId('review-gate-connector').first()).toBeVisible();
    await expect(stackSection.getByText(/depends on/i)).toHaveCount(0);

    await captureScreenshot(page, 'review-gate-stack-side-panel');
    await assertPageScreenshot(page, 'review-gate-stack-side-panel');
  });

  test('workflow inspector captures review-ready and not-review-ready pull request states', async ({ page }) => {
    const workflowId = await loadPlanAndSelectWorkflow(page, REVIEW_READY_WORKFLOW_PR_PLAN);
    await page.locator('.react-flow__node[data-testid$="rr-work"]').first().waitFor({ state: 'visible', timeout: 15000 });

    const reviewUrl = 'https://github.com/Neko-Catpital-Labs/Invoker/pull/626';

    await selectWorkflowNode(page, workflowId);
    await expect(page.getByTestId('workflow-inspector-title')).toHaveText('Review ready workflow PR proof');
    await expect(page.getByText('Inspector', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('workflow-inspector-status-label')).not.toContainText('review ready');
    await expect(page.getByRole('link', { name: reviewUrl })).toHaveCount(0);
    await captureScreenshot(page, 'not-review-ready-workflow-pr-sidebar');

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
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);

    await selectWorkflowNode(page, workflowId);
    await expect(page.getByTestId('workflow-inspector-title')).toHaveText('Review ready workflow PR proof');
    await expect(page.getByText('Inspector', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('workflow-inspector-status-label')).toContainText('review ready');
    await expect(page.getByRole('link', { name: reviewUrl })).toHaveAttribute('href', reviewUrl);

    await captureScreenshot(page, 'review-ready-workflow-pr-sidebar');
  });

  test('sidebar keyboard navigation focuses the first inspector item, not the container', async ({ page }) => {
    const workflowId = await loadPlanAndSelectWorkflow(page, REVIEW_READY_WORKFLOW_PR_PLAN);
    await page.locator('.react-flow__node[data-testid$="rr-work"]').first().waitFor({ state: 'visible', timeout: 15000 });

    const reviewUrl = 'https://github.com/Neko-Catpital-Labs/Invoker/pull/729';
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
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);

    await selectWorkflowNode(page, workflowId);
    await expect(page.getByTestId('inspector-pr-link')).toHaveAttribute('href', reviewUrl);

    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');

    const inspectorRegion = page.locator('[data-keyboard-region="inspector"]');
    const minimize = page.getByRole('button', { name: 'Minimize inspector' });
    await expect(minimize).toBeFocused({ timeout: 5000 });
    const isMarkedNavItem = await minimize.evaluate((el) => el.hasAttribute('data-sidebar-nav-item'));
    expect(isMarkedNavItem).toBe(true);
    await expect(minimize).toHaveAttribute('data-sidebar-nav-order', '10');
    const regionFocused = await inspectorRegion.evaluate(
      (el) => el === document.activeElement,
    );
    expect(regionFocused).toBe(false);

    await captureScreenshot(page, 'sidebar-keyboard-first-item-focused');
  });

  test('interactive-status-hues — fixing-with-ai, needs-input, awaiting-approval', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await selectWorkflowNode(page, 'wf-test-1');
    await waitForStableViewportTransform(page, page.getByTestId('workflow-graph-surface').locator('.react-flow__viewport').first());
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
    const miniDag = page.getByTestId('selected-workflow-mini-dag');
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-alpha"]').getByText('FIXING WITH AI')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-gamma"]').getByText('SELECT')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-beta"]').getByText('APPROVE')).toBeVisible();

    await captureScreenshot(page, 'interactive-status-hues');
    await assertPageScreenshot(page, 'interactive-status-hues');
  });

  test('workflow-task-status-color-parity — workflow and task review_ready share canonical hue', async ({ page }) => {
    // Load a small plan so the sidebar workflow node and the mini-DAG task nodes
    // are visible side by side. The workflow status is derived from task counts;
    // a single review_ready task with the rest completed drives the workflow to
    // review_ready too (see computeWorkflowStatusFromCounts).
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'review_ready',
          execution: { startedAt: earlier },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      {
        taskId: 'task-gamma',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
    ]);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);

    const workflowId = await page.evaluate(async () => {
      const workflows = await window.invoker.listWorkflows();
      return workflows[0]?.id ?? null;
    });
    expect(workflowId).toBeTruthy();

    // Re-select the workflow so the inspector reflects the derived workflow status.
    await selectWorkflowNode(page, workflowId!);

    // Workflow-level surface: sidebar workflow node displays the workflow-status hue.
    await expect(workflowNode(page, workflowId!).getByText('review ready')).toBeVisible();

    // Workflow-level surface: inspector header reflects the derived workflow status.
    await expect(page.getByTestId('workflow-inspector-status-label')).toContainText('review ready');

    // Task-level surface: mini-DAG task node displays the task-status hue.
    await expect(
      page.locator('.react-flow__node[data-testid$="task-alpha"]').getByText(/review ready/i),
    ).toBeVisible();

    await captureScreenshot(page, 'workflow-task-status-color-parity');
  });

  test('task-status-all-states — task nodes render every persisted status', async ({ page }) => {
    await loadPlan(page, TASK_STATUS_PROOF_PLAN);
    await minimizeInspectorIfVisible(page);
    await expandSelectedWorkflowMiniDagForProof(page);

    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(
      page,
      TASK_STATUS_PROOF_SPECS.map((spec) => ({
        taskId: spec.taskId,
        changes: {
          status: spec.status,
          execution: taskStatusExecution(spec.status, now, earlier),
        },
      })),
    );
    const miniDag = page.getByTestId('selected-workflow-mini-dag');
    await miniDag.getByRole('button', { name: 'Fit View' }).click();
    await page.waitForTimeout(300);

    for (const spec of TASK_STATUS_PROOF_SPECS) {
      const node = miniDag.locator(`.react-flow__node[data-testid$="${spec.taskId}"] > div`).first();
      await expect(node).toBeVisible({ timeout: 10000 });
      await expect(node).toBeInViewport({ timeout: 10000 });
    }

    await captureScreenshot(page, 'task-status-all-states');
  });

  test('workflow-status-all-states — workflow nodes render every persisted status', async ({ page }) => {
    const workflowIds = new Map<string, string>();
    const loadStatusWorkflow = async (
      status: (typeof WORKFLOW_STATUS_PROOF_STATUSES)[number],
      dependencies: readonly string[] = [],
    ) => {
      const workflowId = await loadPlanAndSelectWorkflow(page, {
        name: `Status proof ${statusProofLabel(status)}`,
        repoUrl: E2E_REPO_URL,
        onFinish: 'none' as const,
        externalDependencies: dependencies.map((workflowId) => ({
          workflowId,
          gatePolicy: 'review_ready' as const,
        })),
        tasks: [
          {
            id: statusProofWorkflowTaskId(status),
            description: `${statusProofLabel(status)} workflow task`,
            command: `echo ${status}`,
            dependencies: [] as string[],
          },
        ],
      });
      workflowIds.set(status, workflowId);
      return workflowId;
    };

    const pendingId = await loadStatusWorkflow('pending');
    const runningId = await loadStatusWorkflow('running');
    const fixingId = await loadStatusWorkflow('fixing_with_ai');
    const completedId = await loadStatusWorkflow('completed', [pendingId]);
    const failedId = await loadStatusWorkflow('failed', [runningId]);
    const closedId = await loadStatusWorkflow('closed', [fixingId]);
    const blockedId = await loadStatusWorkflow('blocked', [completedId]);
    await loadStatusWorkflow('review_ready', [failedId]);
    await loadStatusWorkflow('awaiting_approval', [closedId]);
    await loadStatusWorkflow('stale', [blockedId]);

    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    for (const status of WORKFLOW_STATUS_PROOF_STATUSES) {
      expect(workflowIds.get(status)).toBeTruthy();
    }
    await injectTaskStates(
      page,
      [
        ...WORKFLOW_STATUS_PROOF_STATUSES.map((status) => ({
          taskId: statusProofWorkflowTaskId(status),
          changes: {
            status,
            execution: taskStatusExecution(status, now, earlier),
          },
        })),
        ...WORKFLOW_STATUS_PROOF_STATUSES.map((status) => ({
          taskId: `__merge__${workflowIds.get(status)!}`,
          changes: {
            ...(status === 'stale' ? { dependencies: [] as string[] } : {}),
            status,
            execution: taskStatusExecution(status, now, earlier),
          },
        })),
      ],
    );
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForTimeout(300);

    await hideSelectedWorkflowMiniDagIfVisible(page);
    await minimizeInspectorIfVisible(page);
    await page.getByTestId('workflow-graph-react-flow').getByRole('button', { name: 'Fit View' }).click();
    await page.waitForTimeout(500);

    for (const status of WORKFLOW_STATUS_PROOF_STATUSES) {
      const workflowId = workflowIds.get(status);
      expect(workflowId).toBeTruthy();
      const node = workflowNode(page, workflowId!);
      await expect(node).toBeVisible({ timeout: 10000 });
      await expect(node.getByText(statusProofLabel(status), { exact: true })).toBeVisible();
    }

    await captureScreenshot(page, 'workflow-status-all-states');
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
    await expect(page.getByRole('menuitem', { name: 'Rebase and Retry' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Rebase and Recreate' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Recreate with Rebase' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Recreate Workflow' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Cancel Workflow' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Delete Workflow' })).toBeVisible();

    await captureScreenshot(page, 'workflow-context-menu-organization');
  });

  test('context menu keyboard navigation highlight', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);

    const menu = await openContextMenu(page, page.locator('[data-testid^="workflow-node-"]'));
    await expect(menu).toBeFocused();
    await expect(page.getByRole('menuitem', { name: 'Open Workflow' })).toHaveClass(/\bbg-muted\b/);

    await page.keyboard.press('ArrowDown');
    const activeItem = page.getByRole('menuitem', { name: 'Open PR' });
    await expect(activeItem).toBeVisible();
    await expect(activeItem).toHaveClass(/\bbg-muted\b/);

    await captureScreenshot(page, 'context-menu-keyboard-navigation');
  });

  test('task context menu shows Recreate Downstream action', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);

    const taskMenu = await openContextMenu(page, page.locator('.react-flow__node[data-testid$="task-alpha"]'));
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(taskMenu.getByRole('menuitem', { name: 'Recreate from Task' })).toBeVisible();
    await expect(taskMenu.getByRole('menuitem', { name: 'Recreate Downstream' })).toBeVisible();

    await captureScreenshot(page, 'task-context-menu-recreate-downstream');

    await page.keyboard.press('Escape');
    await expect(taskMenu).toBeHidden();

    const workflowMenu = await openContextMenu(page, page.locator('[data-testid^="workflow-node-"]'));
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(workflowMenu.getByRole('menuitem', { name: 'Recreate Workflow' })).toBeVisible();
    await expect(workflowMenu.getByRole('menuitem', { name: 'Recreate Downstream' })).toHaveCount(0);
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




  test('global worker switch turns all workers off and back on from the Workers surface', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.getByTestId('sidebar-workers').click();
    await expect(page.getByTestId('worker-processes-section')).toBeVisible();

    const toggle = page.getByTestId('worker-global-switch');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('worker-process-list')).toContainText('Running');
    await captureScreenshot(page, 'workers-surface-switch-step-1-on');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('worker-process-list')).not.toContainText('Running');
    await captureScreenshot(page, 'workers-surface-switch-step-2-off');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('worker-process-list')).toContainText('Running');
    await captureScreenshot(page, 'workers-surface-switch-step-3-back-on');
  });

  test('global worker switch turns all workers off and back on', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await selectGraphMenuItem(page, 'rail-queue');
    await expectQueueViewVisible(page);

    const toggle = page.getByTestId('worker-global-switch');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(toggle).toHaveText('Turn workers off');
    await expect(page.getByTestId('worker-process-list')).toContainText('Running');
    await captureScreenshot(page, 'worker-global-switch-step-1-on');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toHaveText('Turn workers on');
    await expect(page.getByTestId('worker-process-list')).not.toContainText('Running');
    await expect(page.getByTestId('worker-start-stop-pr-status')).toBeDisabled();
    await captureScreenshot(page, 'worker-global-switch-step-2-off');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('worker-process-list')).toContainText('Running');
    await captureScreenshot(page, 'worker-global-switch-step-3-back-on');
  });

  test('queue view concurrency display', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);
    // Navigate to queue view
    await selectGraphMenuItem(page, 'rail-queue');
    await expectQueueViewVisible(page);
    await expect(page.getByTestId('running-queue-section-running')).toContainText('First test task');
    await captureScreenshot(page, 'queue-view-concurrency');
    await assertPageScreenshot(page, 'queue-view-concurrency');
  });
  test('queue assigning state', async ({ page, testDir }) => {
    await loadPlan(page, QUEUE_ASSIGNING_PLAN);
    const tasks = await getTasks(page);
    const task = tasks.find((entry: { id: string }) => entry.id.endsWith('/assigning-task') || entry.id === 'assigning-task');
    const mergeTask = tasks.find((entry: { id: string }) => entry.id.startsWith('__merge__'));
    expect(task).toBeTruthy();
    expect(mergeTask).toBeTruthy();
    const dbPath = path.join(testDir, 'invoker.db');
    const now = new Date();
    const attemptId = `${task!.id}-assigning-attempt`;
    await seedActiveLaunchAttempt(dbPath, task!.id, attemptId, now);
    await injectTaskStates(page, [
      {
        taskId: task!.id,
        changes: {
          status: 'pending',
          execution: {
            phase: 'launching',
            selectedAttemptId: attemptId,
            launchStartedAt: now,
            lastHeartbeatAt: now,
          },
        },
      },
      {
        taskId: mergeTask!.id,
        changes: {
          execution: {
            startedAt: now,
            completedAt: now,
          },
        },
      },
    ]);
    await page.waitForTimeout(2200);
    await selectGraphMenuItem(page, 'rail-queue');
    await expectQueueViewVisible(page);
    await captureScreenshot(page, 'queue-assigning-statusbar');

    await captureScreenshot(page, 'queue-assigning-row');
  });

  test('queue-semantics — action queue with canonical task states', async ({ page }) => {
    await loadPlan(page, QUEUE_SEMANTICS_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'qs-running', changes: { status: 'running', execution: { startedAt: now } } },
      { taskId: 'qs-needs-input', changes: { status: 'needs_input', execution: { startedAt: now } } },
      { taskId: 'qs-review', changes: { status: 'review_ready', execution: { startedAt: now } } },
      { taskId: 'qs-approval', changes: { status: 'awaiting_approval', execution: { startedAt: now } } },
      // qs-queued stays pending with no deps → lands in Action Queue queued section
      // qs-blocked stays pending with unmet dep on qs-running → lands in Backlog
    ]);

    // Navigate to queue view
    await selectGraphMenuItem(page, 'rail-queue');

    // Assert queue sections are visible
    await expectQueueViewVisible(page);

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
    await selectGraphMenuItem(page, 'rail-queue');

    // Assert queue sections are visible
    await expectQueueViewVisible(page);
    await expect(page.getByTestId('running-queue-section-running')).toContainText('Actionable task with relationships');

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
      externalDependencies: [
        { workflowId: wf1!, gatePolicy: 'completed' as const },
        { workflowId: wf2!, gatePolicy: 'completed' as const },
        { workflowId: wf3!, gatePolicy: 'completed' as const },
      ],
      tasks: [
        {
          id: 'gated-task',
          description: 'Task with multiple external gates',
          command: 'echo gated',
          dependencies: [] as string[],
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

  test('detached-workflow-lineage — active edge becomes detached lineage', async ({ page }) => {
    const upstreamWorkflowId = await loadPlanAndSelectWorkflow(page, {
      name: 'Detach Upstream Workflow',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      tasks: [
        { id: 'detach-upstream-task', description: 'Upstream detach prerequisite', command: 'echo upstream', dependencies: [] as string[] },
      ],
    });

    const downstreamWorkflowId = await loadPlanAndSelectWorkflow(page, {
      name: 'Detach Downstream Workflow',
      repoUrl: E2E_REPO_URL,
      onFinish: 'pull_request' as const,
      mergeMode: 'external_review',
      externalDependencies: [{ workflowId: upstreamWorkflowId, gatePolicy: 'review_ready' as const }],
      tasks: [
        { id: 'detach-downstream-task', description: 'Downstream after detachment', command: 'echo downstream', dependencies: [] as string[] },
      ],
    });

    await page.getByTestId('selected-workflow-mini-dag').evaluate((element) => {
      (element as HTMLElement).style.display = 'none';
    });
    const minimizeInspector = page.getByRole('button', { name: 'Minimize inspector' });
    if (await minimizeInspector.isVisible().catch(() => false)) {
      await minimizeInspector.click();
      await expect(page.getByRole('button', { name: 'Maximize inspector' })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Fit View' }).first().click();
    await page.waitForTimeout(200);

    await expect(workflowNode(page, upstreamWorkflowId)).toBeInViewport();
    await expect(workflowNode(page, downstreamWorkflowId)).toBeInViewport();
    await expect(page.getByTestId(`rf__edge-workflow:active:${upstreamWorkflowId}->${downstreamWorkflowId}`)).toHaveCount(1);
    await expect(page.getByTestId(`workflow-node-${downstreamWorkflowId}-detached-lineage`)).toHaveCount(0);

    await captureScreenshot(page, 'detached-workflow-lineage-before');

    await page.evaluate(
      ({ workflowId, upstreamWorkflowId }) => window.invoker.detachWorkflow(workflowId, upstreamWorkflowId),
      { workflowId: downstreamWorkflowId, upstreamWorkflowId },
    );
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.waitForFunction(
      ({ source, target }) => (
        !document.querySelector(`[data-testid="rf__edge-workflow:active:${source}->${target}"]`)
        && document.querySelector(`[data-testid="rf__edge-workflow:detached:${source}->${target}"]`)
        && document.querySelector(`[data-testid="workflow-node-${target}-detached-lineage"]`)
      ),
      { source: upstreamWorkflowId, target: downstreamWorkflowId },
      { timeout: 10000 },
    );
    await page.getByRole('button', { name: 'Fit View' }).first().click();
    await page.waitForTimeout(200);

    await expect(page.getByTestId(`rf__edge-workflow:active:${upstreamWorkflowId}->${downstreamWorkflowId}`)).toHaveCount(0);
    await expect(page.getByTestId(`rf__edge-workflow:detached:${upstreamWorkflowId}->${downstreamWorkflowId}`)).toHaveCount(1);
    await expect(page.getByTestId(`workflow-node-${downstreamWorkflowId}-detached-lineage`)).toHaveText('Detached');

    await captureScreenshot(page, 'detached-workflow-lineage-after');
  });
  test('queue-action-wording — task-level uses Cancel, workflow-level keeps Cancel Workflow', async ({ page }) => {
    const workflowId = await loadPlanAndSelectWorkflow(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);

    await page.evaluate(() => {
      window.invoker.getQueueStatus = async () => ({
        maxConcurrency: 5,
        runningCount: 1,
        running: [{ taskId: 'task-alpha', description: 'First test task' }],
        queued: [],
      });
    });
    await page.waitForTimeout(2200);

    await selectGraphMenuItem(page, 'rail-queue');
    await expectQueueViewVisible(page);
    await expect(page.getByTestId('running-queue-section-running')).toContainText('First test task');

    await selectGraphMenuItem(page, 'rail-home');
    await selectWorkflowNode(page, workflowId);
    await openContextMenu(page, workflowNode(page, workflowId));
    await page.getByRole('menuitem', { name: 'More' }).click();
    await expect(page.getByRole('menuitem', { name: 'Cancel Workflow' })).toBeVisible();

    await captureScreenshot(page, 'terminate-wording-task-vs-workflow');
    await assertPageScreenshot(page, 'terminate-wording-task-vs-workflow');
  });

  test('queue-cancel-control — compact cancel affordance without priority metadata', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);

    await page.waitForTimeout(2200);

    await selectGraphMenuItem(page, 'rail-queue');
    await expectQueueViewVisible(page);
    await expect(page.getByTestId('running-queue-section-running')).toContainText('First test task');

    await captureScreenshot(page, 'queue-cancel-control');
    await assertPageScreenshot(page, 'queue-cancel-control');
  });

  test('queue-action-surface-hardening — composed queue UX with labels, relationships, and cancel', async ({ page }) => {
    await loadPlan(page, QUEUE_HARDENING_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'qh-running', changes: { status: 'running', execution: { startedAt: now } } },
      { taskId: 'qh-fixing', changes: { status: 'running', execution: { isFixingWithAI: true, startedAt: now } } },
      { taskId: 'qh-approval', changes: { status: 'awaiting_approval', execution: { startedAt: now } } },
      // qh-queued stays pending with no deps → Action Queue queued section
      // qh-downstream stays pending with unmet dep on qh-running → Backlog
    ]);

    await page.evaluate(() => {
      window.invoker.getQueueStatus = async () => ({
        maxConcurrency: 5,
        runningCount: 2,
        running: [
          { taskId: 'qh-running', description: 'Running task with downstream' },
          { taskId: 'qh-fixing', description: 'Fixing task with AI' },
        ],
        queued: [],
      });
    });
    await page.waitForTimeout(2200);
    // Navigate to queue view
    await selectGraphMenuItem(page, 'rail-queue');
    // Assert canonical queue sections
    await expectQueueViewVisible(page);

    await captureScreenshot(page, 'queue-action-surface-hardening');
    await assertPageScreenshot(page, 'queue-action-surface-hardening');
  });

  test('completed SSH task double-click expands terminal drawer with working SSH resume terminal', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, SSH_TERMINAL_RESUME_PLAN);
    const workspacePath = '/home/invoker/.invoker/worktrees/wf-ssh/experiment-ssh-resume';
    const sessionId = 'codex-session-ssh-123';
    const terminalSessionId = 'visual-proof-ssh-session';
    const sshInnerCommand = `cd '${workspacePath}' && codex resume --dangerously-bypass-approvals-and-sandbox ${sessionId}`;
    const sshArgs = ['-i', '/tmp/e2e_id_rsa', '-t', 'invoker@remote-do-1', sshInnerCommand];
    const outputSnapshot = [
      'Connection established: remote-do-1\r\n',
      `Resumed Codex session ${sessionId}\r\n`,
    ].join('');
    const terminalOutput = 'Terminal stream ready for input.\r\n';

    await injectTaskStates(page, [
      {
        taskId: 'ssh-resume',
        changes: {
          status: 'completed',
          config: {
            runnerKind: 'ssh',
            poolMemberId: 'remote-do-1',
            executionAgent: 'codex',
          },
          execution: {
            workspacePath,
            agentSessionId: sessionId,
            completedAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        },
      },
    ]);

    await page.evaluate(({ args, cwd, terminalId, outputSnapshot }) => {
      (window as unknown as { __terminalCalls: string[] }).__terminalCalls = [];
      (window as unknown as { __terminalOutputSubscribers: Array<(event: { sessionId: string; taskId: string; data: string }) => void> }).__terminalOutputSubscribers = [];
      window.__INVOKER_TEST_OPEN_TERMINAL__ = async (taskId: string) => {
        (window as unknown as { __terminalCalls: string[] }).__terminalCalls.push(taskId);
        return {
          opened: true,
          session: {
            sessionId: terminalId,
            taskId,
            status: 'running',
            cwd,
            command: 'ssh',
            args,
            mode: 'spawn',
            attached: false,
            outputSnapshot,
            createdAt: '2025-01-01T00:00:00.000Z',
          },
        };
      };
      window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ = (cb) => {
        const subscribers = (window as unknown as { __terminalOutputSubscribers: Array<(event: { sessionId: string; taskId: string; data: string }) => void> }).__terminalOutputSubscribers;
        subscribers.push(cb);
        return () => {
          const index = subscribers.indexOf(cb);
          if (index >= 0) subscribers.splice(index, 1);
        };
      };
    }, { args: sshArgs, cwd: workspacePath, terminalId: terminalSessionId, outputSnapshot });

    const sshTaskNode = page
      .getByTestId('selected-workflow-mini-dag')
      .locator('.react-flow__node[data-testid$="ssh-resume"]')
      .first();
    const box = await sshTaskNode.boundingBox();
    if (!box) throw new Error('SSH task node has no bounding box');
    await sshTaskNode.locator('> div').dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });

    await expect(page.getByTestId('terminal-drawer-body')).toBeVisible();
    await expect(page.getByTestId('terminal-tab-wf-test-1/ssh-resume')).toHaveAttribute('data-active', 'true');
    await expect(page.getByTestId('terminal-session-command')).toContainText('ssh');
    await expect(page.getByTestId('terminal-session-command')).toContainText(workspacePath);
    await expect(page.getByTestId('terminal-session-command')).toContainText(`codex resume --dangerously-bypass-approvals-and-sandbox ${sessionId}`);
    await expect(page.getByTestId('terminal-pane-wf-test-1/ssh-resume')).toBeVisible();
    const terminalPane = page.getByTestId('terminal-pane-wf-test-1/ssh-resume');
    await page.waitForFunction(() => {
      return (window as unknown as { __terminalOutputSubscribers: unknown[] }).__terminalOutputSubscribers.length > 0;
    });
    await page.evaluate(({ output, terminalId }) => {
      const subscribers = (window as unknown as { __terminalOutputSubscribers: Array<(event: { sessionId: string; taskId: string; data: string }) => void> }).__terminalOutputSubscribers;
      for (const subscriber of subscribers) {
        subscriber({ sessionId: terminalId, taskId: 'wf-test-1/ssh-resume', data: output });
      }
    }, { output: terminalOutput, terminalId: terminalSessionId });
    await expect(terminalPane.getByText('Connection established: remote-do-1')).toBeVisible();
    await expect(terminalPane.getByText(`Resumed Codex session ${sessionId}`)).toBeVisible();
    await expect(terminalPane.getByText('Terminal stream ready for input.')).toBeVisible();

    const outputPreviewLabel = page
      .getByTestId('terminal-drawer-body')
      .getByText('output', { exact: true });
    if (process.env.CAPTURE_MODE === 'before') {
      await expect(outputPreviewLabel).toBeVisible();
    } else {
      await expect(outputPreviewLabel).toHaveCount(0);
    }
    await expect(page.getByTestId('terminal-session-output-preview')).toHaveCount(0);

    const calls = await page.evaluate(() => (window as unknown as { __terminalCalls: string[] }).__terminalCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ssh-resume');

    await captureScreenshot(page, 'completed-ssh-terminal-resume');
    await assertPageScreenshot(page, 'completed-ssh-terminal-resume');
  });

  test('task-graph-keyboard-controls - selected workflow task graph visible', async ({ page }) => {
    await loadPlanAndSelectWorkflow(page, MENU_PROOF_PLAN);
    const miniDag = page.getByTestId('selected-workflow-mini-dag');
    await expect(miniDag).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-alpha"]')).toBeVisible();
    await expect(miniDag.locator('.react-flow__node[data-testid$="task-beta"]')).toBeVisible();
    await captureScreenshot(page, 'task-graph-keyboard-controls-selected');
  });
});
