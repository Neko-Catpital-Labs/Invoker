/**
 * Catalog of every UI/backend-mutating operation used by the drift-testing
 * harness in this directory. See docs/ui-backend-drift-tracing.md for the
 * two channels these operations travel over.
 */
import type { Page } from '@playwright/test';
import { E2E_REPO_URL, injectTaskStates, loadPlan, startPlan } from '../fixtures/electron-app.js';
import { runHeadlessClient } from '../fixtures/headless-client.js';

export type DriftChannel = 'task-delta' | 'workflow-metadata';
export type ScenarioDriver = 'ipc' | 'headless-cli';

export interface ScenarioContext {
  page: Page;
  testDir: string;
  workflowId: string;
  taskId: string;
  upstreamWorkflowId?: string;
}

export interface ScenarioResult {
  workflowId: string;
  taskId?: string;
}

export interface DriftScenario {
  id: string;
  channel: DriftChannel;
  driver: ScenarioDriver;
  description: string;
  /** Establish preconditions: load a plan, inject task state, link workflows, etc. */
  setup(page: Page, testDir: string): Promise<ScenarioContext>;
  /** Perform the mutating operation under test. Returns the ids to scope the drift comparison to. */
  act(ctx: ScenarioContext): Promise<ScenarioResult>;
}

function plan(name: string, taskOverrides: Partial<Record<string, unknown>> = {}) {
  return {
    name,
    repoUrl: E2E_REPO_URL,
    onFinish: 'none' as const,
    tasks: [
      {
        id: 'task-alpha',
        description: 'First test task',
        command: 'sleep 5 && echo hello-alpha',
        dependencies: [],
        ...taskOverrides,
      },
      {
        id: 'task-beta',
        description: 'Second test task depending on alpha',
        command: 'sleep 3 && echo hello-beta',
        dependencies: ['task-alpha'],
      },
    ],
  };
}

async function listWorkflowIds(page: Page): Promise<Set<string>> {
  const workflows = await page.evaluate(() => window.invoker.listWorkflows());
  return new Set(workflows.map((workflow: { id: string }) => workflow.id));
}

async function loadPlanAndGetWorkflowId(page: Page, testPlan: ReturnType<typeof plan>): Promise<string> {
  const before = await listWorkflowIds(page);
  await loadPlan(page, testPlan);
  const after = await page.evaluate(() => window.invoker.listWorkflows());
  const created = after.find((workflow: { id: string }) => !before.has(workflow.id));
  const workflowId = created?.id ?? after[after.length - 1]?.id;
  if (!workflowId) throw new Error('loadPlanAndGetWorkflowId: no workflow found after loadPlan');
  return workflowId;
}

async function resolvedTaskId(page: Page, taskId: string): Promise<string> {
  const result = await page.evaluate(() => window.invoker.getTasks());
  const tasks = Array.isArray(result) ? result : result.tasks;
  const found = tasks.find((task: { id: string }) => task.id === taskId || task.id.endsWith(`/${taskId}`));
  if (!found) throw new Error(`resolvedTaskId: task "${taskId}" not found`);
  return found.id;
}

/** Standard two-task plan, task-alpha injected straight into a terminal/gate status (no real command runs). */
async function setupWithInjectedTaskStatus(
  page: Page,
  testDir: string,
  status: string,
  extraChanges: Record<string, unknown> = {},
): Promise<ScenarioContext> {
  const workflowId = await loadPlanAndGetWorkflowId(page, plan(`drift scenario ${status}`));
  await injectTaskStates(page, [{ taskId: 'task-alpha', changes: { status: status as never, ...extraChanges } }]);
  const taskId = await resolvedTaskId(page, 'task-alpha');
  return { page, testDir, workflowId, taskId };
}

const runScenario: DriftScenario = {
  id: 'run',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Submit a new plan (add workflow)',
  async setup(page, testDir) {
    return { page, testDir, workflowId: '', taskId: '' };
  },
  async act(ctx) {
    const workflowId = await loadPlanAndGetWorkflowId(ctx.page, plan('drift scenario run'));
    await startPlan(ctx.page);
    return { workflowId };
  },
};

const retryTaskScenario: DriftScenario = {
  id: 'retry-task',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Retry a single failed task',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.retryTask(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const retryWorkflowScenario: DriftScenario = {
  id: 'retry-workflow',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Retry an entire failed workflow',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await ctx.page.evaluate((workflowId) => window.invoker.retryWorkflow(workflowId), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const recreateTaskScenario: DriftScenario = {
  id: 'recreate-task',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Recreate a single completed task from a fresh base',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'completed'),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.recreateTask(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const recreateWorkflowScenario: DriftScenario = {
  id: 'recreate-workflow',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Recreate an entire workflow from a fresh base',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'completed'),
  async act(ctx) {
    await ctx.page.evaluate((workflowId) => window.invoker.recreateWorkflow(workflowId), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const recreateDownstreamScenario: DriftScenario = {
  id: 'recreate-downstream',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Recreate everything downstream of a task',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'completed'),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.recreateDownstream(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const rebaseRetryScenario: DriftScenario = {
  id: 'rebase-retry',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Rebase onto latest base branch, then retry',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await ctx.page.evaluate((target) => window.invoker.rebaseRetry(target), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const rebaseRecreateScenario: DriftScenario = {
  id: 'rebase-recreate',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Rebase onto latest base branch, then recreate (existing baseline coverage)',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await ctx.page.evaluate((target) => window.invoker.rebaseRecreate(target), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const cancelTaskScenario: DriftScenario = {
  id: 'cancel-task',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Cancel a single running task',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'running', { execution: { phase: 'running' } }),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.cancelTask(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const cancelWorkflowScenario: DriftScenario = {
  id: 'cancel-workflow',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Cancel an entire running workflow',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'running', { execution: { phase: 'running' } }),
  async act(ctx) {
    await ctx.page.evaluate((workflowId) => window.invoker.cancelWorkflow(workflowId), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const approveScenario: DriftScenario = {
  id: 'approve',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Approve a task awaiting manual approval',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'awaiting_approval'),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.approve(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const rejectScenario: DriftScenario = {
  id: 'reject',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Reject a task awaiting manual approval',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'awaiting_approval'),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.reject(taskId, 'drift-scenario-reject'), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const provideInputScenario: DriftScenario = {
  id: 'provide-input',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Provide input to a task waiting on it',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'needs_input'),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.provideInput(taskId, 'drift-scenario-input'), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const selectExperimentScenario: DriftScenario = {
  id: 'select-experiment',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Select an experiment variant on a task with pending variants',
  async setup(page, testDir) {
    const experimentPlan = {
      name: 'drift scenario select-experiment',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'task-gamma',
          description: 'Reconciliation task',
          command: 'echo gamma',
          dependencies: [],
          experimentVariants: [
            { id: 'variant-a', description: 'Variant A', command: 'echo A' },
            { id: 'variant-b', description: 'Variant B', command: 'echo B' },
          ],
        },
      ],
    };
    const workflowId = await loadPlanAndGetWorkflowId(page, experimentPlan);
    await injectTaskStates(page, [{ taskId: 'task-gamma', changes: { status: 'needs_input' as never } }]);
    const taskId = await resolvedTaskId(page, 'task-gamma');
    return { page, testDir, workflowId, taskId };
  },
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.selectExperiment(taskId, 'variant-a'), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const editTaskCommandScenario: DriftScenario = {
  id: 'edit-task-command',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Edit a pending task\'s command',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario edit-command'));
    const taskId = await resolvedTaskId(page, 'task-alpha');
    return { page, testDir, workflowId, taskId };
  },
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.editTaskCommand(taskId, 'echo edited'), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const editTaskPromptScenario: DriftScenario = {
  id: 'edit-task-prompt',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Edit a pending task\'s prompt',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario edit-prompt'));
    const taskId = await resolvedTaskId(page, 'task-alpha');
    return { page, testDir, workflowId, taskId };
  },
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.editTaskPrompt(taskId, 'edited prompt'), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const resolveConflictScenario: DriftScenario = {
  id: 'resolve-conflict',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Resolve a merge conflict on a failed task',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.resolveConflict(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const fixWithAgentScenario: DriftScenario = {
  id: 'fix-with-agent',
  channel: 'task-delta',
  driver: 'ipc',
  description: 'Fix a failed task with an agent',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.fixWithAgent(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

// ── Workflow-metadata channel (GUI-IPC driven) ──────────────

const detachWorkflowScenario: DriftScenario = {
  id: 'detach-workflow',
  channel: 'workflow-metadata',
  driver: 'ipc',
  description: 'Detach a downstream workflow from its upstream external dependency (the flagship reported bug)',
  async setup(page, testDir) {
    const upstreamWorkflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario detach upstream'));
    const downstreamPlan = {
      ...plan('drift scenario detach downstream'),
      externalDependencies: [{ workflowId: upstreamWorkflowId, gatePolicy: 'review_ready' as const }],
    };
    const workflowId = await loadPlanAndGetWorkflowId(page, downstreamPlan);
    return { page, testDir, workflowId, taskId: '', upstreamWorkflowId };
  },
  async act(ctx) {
    if (!ctx.upstreamWorkflowId) throw new Error('detach-workflow scenario missing upstreamWorkflowId');
    await ctx.page.evaluate(
      ({ workflowId, upstreamWorkflowId }) => window.invoker.detachWorkflow(workflowId, upstreamWorkflowId),
      { workflowId: ctx.workflowId, upstreamWorkflowId: ctx.upstreamWorkflowId },
    );
    return { workflowId: ctx.workflowId };
  },
};

const deleteWorkflowScenario: DriftScenario = {
  id: 'delete-workflow',
  channel: 'workflow-metadata',
  driver: 'ipc',
  description: 'Delete an entire workflow',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario delete-workflow'));
    return { page, testDir, workflowId, taskId: '' };
  },
  async act(ctx) {
    await ctx.page.evaluate((workflowId) => window.invoker.deleteWorkflow(workflowId), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const deleteTaskScenario: DriftScenario = {
  id: 'delete-task',
  channel: 'workflow-metadata',
  driver: 'ipc',
  description: 'Delete a single task',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario delete-task'));
    const taskId = await resolvedTaskId(page, 'task-beta');
    return { page, testDir, workflowId, taskId };
  },
  async act(ctx) {
    await ctx.page.evaluate((taskId) => window.invoker.deleteTask(taskId), ctx.taskId);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const deleteAllWorkflowsScenario: DriftScenario = {
  id: 'delete-all-workflows',
  channel: 'workflow-metadata',
  driver: 'ipc',
  description: 'Delete every workflow at once',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario delete-all'));
    return { page, testDir, workflowId, taskId: '' };
  },
  async act(ctx) {
    await ctx.page.evaluate(() => window.invoker.deleteAllWorkflows());
    return { workflowId: ctx.workflowId };
  },
};

const setMergeModeScenario: DriftScenario = {
  id: 'set-workflow-merge-mode',
  channel: 'workflow-metadata',
  driver: 'ipc',
  description: 'Change a workflow\'s merge mode',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario set-workflow-merge-mode'));
    return { page, testDir, workflowId, taskId: '' };
  },
  async act(ctx) {
    await ctx.page.evaluate((workflowId) => window.invoker.setMergeMode(workflowId, 'automatic'), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

const setMergeBranchScenario: DriftScenario = {
  id: 'set-merge-branch',
  channel: 'workflow-metadata',
  driver: 'ipc',
  description: 'Change a workflow\'s base branch',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario set-merge-branch'));
    return { page, testDir, workflowId, taskId: '' };
  },
  async act(ctx) {
    await ctx.page.evaluate((workflowId) => window.invoker.setMergeBranch(workflowId, 'main'), ctx.workflowId);
    return { workflowId: ctx.workflowId };
  },
};

// ── Workflow-metadata channel (headless-CLI only — no GUI IPC handler exists) ──

const forkWorkflowScenario: DriftScenario = {
  id: 'fork-workflow',
  channel: 'workflow-metadata',
  driver: 'headless-cli',
  description: 'Fork a workflow into a new one (headless-only, no GUI button)',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario fork-workflow'));
    return { page, testDir, workflowId, taskId: '' };
  },
  async act(ctx) {
    const before = await listWorkflowIds(ctx.page);
    await runHeadlessClient(ctx.testDir, ['fork-workflow', ctx.workflowId]);
    const after = await ctx.page.evaluate(() => window.invoker.listWorkflows());
    const forked = after.find((workflow: { id: string }) => !before.has(workflow.id));
    return { workflowId: forked?.id ?? ctx.workflowId };
  },
};

const setWorkflowMetadataScenario: DriftScenario = {
  id: 'set-workflow-metadata',
  channel: 'workflow-metadata',
  driver: 'headless-cli',
  description: 'Set an arbitrary workflow metadata field (headless-only, no GUI button)',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario set-workflow-metadata'));
    return { page, testDir, workflowId, taskId: '' };
  },
  async act(ctx) {
    await runHeadlessClient(ctx.testDir, ['set', 'workflow', ctx.workflowId, 'baseBranch', 'main']);
    return { workflowId: ctx.workflowId };
  },
};

const setTaskMetadataScenario: DriftScenario = {
  id: 'set-task-metadata',
  channel: 'workflow-metadata',
  driver: 'headless-cli',
  description: 'Set an arbitrary task metadata field (headless-only, no GUI button)',
  async setup(page, testDir) {
    const workflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario set-task-metadata'));
    const taskId = await resolvedTaskId(page, 'task-alpha');
    return { page, testDir, workflowId, taskId };
  },
  async act(ctx) {
    await runHeadlessClient(ctx.testDir, ['set', 'task', ctx.taskId, 'description', 'edited via headless']);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const setGatePolicyScenario: DriftScenario = {
  id: 'set-gate-policy',
  channel: 'workflow-metadata',
  driver: 'headless-cli',
  description: 'Set an external gate policy on a task\'s upstream dependency (headless-only, no GUI button)',
  async setup(page, testDir) {
    // set-gate-policy operates on an existing external dependency: `<taskId>
    // <upstreamWorkflowId> <policy>` updates how `taskId` gates on
    // `upstreamWorkflowId`'s merge node. Needs the same upstream/downstream
    // link as detach-workflow.
    const upstreamWorkflowId = await loadPlanAndGetWorkflowId(page, plan('drift scenario set-gate-policy upstream'));
    const downstreamPlan = {
      ...plan('drift scenario set-gate-policy downstream'),
      externalDependencies: [{ workflowId: upstreamWorkflowId, gatePolicy: 'review_ready' as const }],
    };
    const workflowId = await loadPlanAndGetWorkflowId(page, downstreamPlan);
    const taskId = await resolvedTaskId(page, `__merge__${workflowId}`);
    return { page, testDir, workflowId, taskId, upstreamWorkflowId };
  },
  async act(ctx) {
    if (!ctx.upstreamWorkflowId) throw new Error('set-gate-policy scenario missing upstreamWorkflowId');
    // 'ci_failed' can never be immediately satisfied by the still-pending
    // upstream, unlike 'completed'/'review_ready' -- avoids triggering a real
    // task dispatch as a side effect of the metadata edit under test.
    await runHeadlessClient(ctx.testDir, ['set', 'gate-policy', ctx.taskId, ctx.upstreamWorkflowId, 'ci_failed']);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

const setFixPromptScenario: DriftScenario = {
  id: 'set-fix-prompt',
  channel: 'workflow-metadata',
  driver: 'headless-cli',
  description: 'Set a task\'s fix prompt (headless-only, no GUI button)',
  setup: (page, testDir) => setupWithInjectedTaskStatus(page, testDir, 'failed', { execution: { exitCode: 1 } }),
  async act(ctx) {
    await runHeadlessClient(ctx.testDir, ['set', 'fix-prompt', ctx.taskId, 'edited fix prompt', '--no-track']);
    return { workflowId: ctx.workflowId, taskId: ctx.taskId };
  },
};

export const DRIFT_SCENARIOS: readonly DriftScenario[] = [
  runScenario,
  retryTaskScenario,
  retryWorkflowScenario,
  recreateTaskScenario,
  recreateWorkflowScenario,
  recreateDownstreamScenario,
  rebaseRetryScenario,
  rebaseRecreateScenario,
  cancelTaskScenario,
  cancelWorkflowScenario,
  approveScenario,
  rejectScenario,
  provideInputScenario,
  selectExperimentScenario,
  editTaskCommandScenario,
  editTaskPromptScenario,
  resolveConflictScenario,
  fixWithAgentScenario,
  detachWorkflowScenario,
  deleteWorkflowScenario,
  deleteTaskScenario,
  deleteAllWorkflowsScenario,
  setMergeModeScenario,
  setMergeBranchScenario,
  forkWorkflowScenario,
  setWorkflowMetadataScenario,
  setTaskMetadataScenario,
  setGatePolicyScenario,
  setFixPromptScenario,
];

export function scenarioById(id: string): DriftScenario {
  const found = DRIFT_SCENARIOS.find((scenario) => scenario.id === id);
  if (!found) throw new Error(`Unknown drift scenario id "${id}"`);
  return found;
}
