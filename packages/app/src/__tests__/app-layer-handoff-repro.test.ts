import { describe, it, expect, beforeEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-kit';
import type { PlanDefinition } from '@invoker/workflow-core';
import { dispatchStartedTasksWithGlobalTopup } from '../global-topup.js';

const LINEAR_PLAN: PlanDefinition = {
  name: 'Linear Handoff Repro',
  onFinish: 'merge',
  mergeMode: 'automatic',
  baseBranch: 'master',
  featureBranch: 'plan/linear-handoff',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b', dependencies: ['A'] },
  ],
};

const PARALLEL_PLAN: PlanDefinition = {
  name: 'Parallel Handoff Repro',
  onFinish: 'merge',
  mergeMode: 'automatic',
  baseBranch: 'master',
  featureBranch: 'plan/parallel-handoff',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b' },
    { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['A', 'B'] },
  ],
};

async function dispatchStarted(h: TestHarness, started: Array<any>, context: string) {
  return dispatchStartedTasksWithGlobalTopup({
    orchestrator: h.orchestrator,
    taskExecutor: h.executor,
    context,
    started,
  });
}

describe('app-layer handoff repros', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('edit-task-command launches restarted task and persists workspacePath', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    const started = h.orchestrator.editTaskCommand('A', 'echo fixed');
    expect(started.some((task) => task.id.endsWith('/A') && task.status === 'running')).toBe(true);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();

    await dispatchStarted(h, started, 'test.edit-task-command');

    expect(h.getTask('A')!.execution.workspacePath).toBe('/tmp/mock-worktree');
    expect(h.getTask('A')!.status).toBe('completed');
  });

  it('edit-task-type launches restarted task and persists workspacePath', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    const started = h.orchestrator.editTaskType('A', 'worktree');
    expect(started.some((task) => task.id.endsWith('/A') && task.status === 'running')).toBe(true);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();

    await dispatchStarted(h, started, 'test.edit-task-type');

    expect(h.getTask('A')!.execution.workspacePath).toBe('/tmp/mock-worktree');
    expect(h.getTask('A')!.status).toBe('completed');
  });

  it('edit-task-agent launches restarted task and persists workspacePath', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    const started = h.orchestrator.editTaskAgent('A', 'codex');
    expect(started.some((task) => task.id.endsWith('/A') && task.status === 'running')).toBe(true);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();

    await dispatchStarted(h, started, 'test.edit-task-agent');

    expect(h.getTask('A')!.execution.workspacePath).toBe('/tmp/mock-worktree');
    expect(h.getTask('A')!.status).toBe('completed');
  });

  it('set-task-external-gate-policies launches newly unblocked task and persists workspacePath', async () => {
    h.orchestrator.loadPlan({
      name: 'upstream-workflow',
      tasks: [{ id: 'verify', description: 'prereq task', command: 'echo verify' }],
    });
    const prereqTaskId = h.getTask('verify')!.id;
    const prereqWorkflowId = prereqTaskId.split('/')[0]!;
    const prereqMergeId = `__merge__${prereqWorkflowId}`;

    h.orchestrator.loadPlan({
      name: 'downstream-workflow',
      tasks: [
        {
          id: 'leaf',
          description: 'waits for upstream merge completion',
          command: 'echo leaf',
          externalDependencies: [{ workflowId: prereqWorkflowId, gatePolicy: 'completed' }],
        },
      ],
    });
    const leafId = h.getTask('leaf')!.id;

    h.orchestrator.startExecution();
    h.orchestrator.handleWorkerResponse({
      requestId: 'complete-prereq',
      actionId: prereqTaskId,
      executionGeneration: h.getTask(prereqTaskId)!.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    h.orchestrator.setTaskAwaitingApproval(prereqMergeId);

    const started = h.orchestrator.setTaskExternalGatePolicies(leafId, [
      { workflowId: prereqWorkflowId, gatePolicy: 'review_ready' },
    ]);
    expect(started.some((task) => task.id === leafId && task.status === 'running')).toBe(true);
    expect(h.getTask('leaf')!.execution.workspacePath).toBeUndefined();

    await dispatchStarted(h, started, 'test.set-task-external-gate-policies');

    expect(h.getTask('leaf')!.execution.workspacePath).toBe('/tmp/mock-worktree');
    expect(h.getTask('leaf')!.status).toBe('completed');
  });

  it('replace-task launches replacement tasks and persists workspacePath', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    // Step 11 (`docs/architecture/task-invalidation-roadmap.md`):
    // `replaceTask` is a topology mutation and now throws
    // `TopologyForkRequired` whenever any non-merge task is still in a
    // live status. LINEAR_PLAN is A → B; after failTask('A'), B is
    // `pending` so we cancel it before exercising the in-place
    // replacement path. The handoff/workspacePath assertions below
    // are unchanged.
    h.orchestrator.cancelTask('B');

    const started = h.orchestrator.replaceTask('A', [
      { id: 'A-fix-1', description: 'Fix part 1', command: 'echo fix1' },
      { id: 'A-fix-2', description: 'Fix part 2', command: 'echo fix2', dependencies: ['A-fix-1'] },
    ]);
    expect(started.some((task) => task.id.endsWith('/A-fix-1') && task.status === 'running')).toBe(true);
    expect(h.getTask('A-fix-1')!.execution.workspacePath).toBeUndefined();

    await dispatchStarted(h, started, 'test.replace-task');

    expect(h.getTask('A-fix-1')!.execution.workspacePath).toBe('/tmp/mock-worktree');
    expect(h.getTask('A-fix-1')!.status).toBe('completed');
  });

  it('set-merge-branch relaunches merge task and persists workspacePath', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeTaskId = h.getAllTasks().find((task) => task.config.isMergeNode)!.id;
    const workflowId = h.getTask(mergeTaskId)!.config.workflowId!;
    await h.executor.executeTasks([h.getTask(mergeTaskId)!]);
    expect(h.getTask(mergeTaskId)!.status).toBe('completed');

    h.persistence.updateWorkflow(workflowId, { baseBranch: 'develop' });
    const started = h.orchestrator.retryTask(mergeTaskId);
    expect(started.some((task) => task.id === mergeTaskId && task.status === 'running')).toBe(true);
    expect(h.getTask(mergeTaskId)!.execution.workspacePath).toBe('/tmp/mock-merge-worktree');

    await dispatchStarted(h, started, 'test.set-merge-branch');

    expect(h.getTask(mergeTaskId)!.execution.workspacePath).toBe('/tmp/mock-merge-worktree');
    expect(h.getTask(mergeTaskId)!.status).toBe('completed');
    expect(h.persistence.loadWorkflow(workflowId).baseBranch).toBe('develop');
  });

  it('standalone-owner set-merge-branch uses the same handoff and persists workspacePath', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeTaskId = h.getAllTasks().find((task) => task.config.isMergeNode)!.id;
    const workflowId = h.getTask(mergeTaskId)!.config.workflowId!;
    await h.executor.executeTasks([h.getTask(mergeTaskId)!]);

    h.persistence.updateWorkflow(workflowId, { baseBranch: 'release' });
    const started = h.orchestrator.retryTask(mergeTaskId);
    await dispatchStarted(h, started, 'test.standalone.set-merge-branch');

    expect(h.getTask(mergeTaskId)!.execution.workspacePath).toBe('/tmp/mock-merge-worktree');
    expect(h.getTask(mergeTaskId)!.status).toBe('completed');
    expect(h.persistence.loadWorkflow(workflowId).baseBranch).toBe('release');
  });
});
