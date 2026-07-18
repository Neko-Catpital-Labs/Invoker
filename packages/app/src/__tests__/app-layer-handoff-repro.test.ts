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

  it('edit-task-command records a runnable launch for the outbox', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    const started = h.orchestrator.editTaskCommand('A', 'echo fixed');
    expect(started.some((task) => task.id.endsWith('/A') && task.status === 'running')).toBe(true);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();

    const result = await dispatchStarted(h, started, 'test.edit-task-command');

    expect(result.runnable.map((task) => task.id)).toEqual([h.getTask('A')!.id]);
    expect(result.topup).toEqual([]);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();
    expect(h.getTask('A')!.status).toBe('running');
  });

  it('edit-task-prompt records a runnable launch for the outbox', async () => {
    const PROMPT_PLAN: PlanDefinition = {
      name: 'Prompt Handoff Repro',
      onFinish: 'merge',
      mergeMode: 'automatic',
      baseBranch: 'master',
      featureBranch: 'plan/prompt-handoff',
      tasks: [
        { id: 'A', description: 'Prompt Task A', prompt: 'Implement feature X' },
        { id: 'B', description: 'Task B', command: 'echo b', dependencies: ['A'] },
      ],
    };
    h.loadAndStart(PROMPT_PLAN);
    h.failTask('A', 'broken');

    const started = h.orchestrator.editTaskPrompt('A', 'Implement feature Y instead');
    expect(started.some((task) => task.id.endsWith('/A') && task.status === 'running')).toBe(true);
    expect(h.getTask('A')!.config.prompt).toBe('Implement feature Y instead');

    const result = await dispatchStarted(h, started, 'test.edit-task-prompt');

    expect(result.runnable.map((task) => task.id)).toEqual([h.getTask('A')!.id]);
    expect(result.topup).toEqual([]);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();
    expect(h.getTask('A')!.status).toBe('running');
  });


  it('edit-task-agent records a runnable launch for the outbox', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    const started = h.orchestrator.editTaskAgent('A', 'codex');
    expect(started.some((task) => task.id.endsWith('/A') && task.status === 'running')).toBe(true);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();

    const result = await dispatchStarted(h, started, 'test.edit-task-agent');

    expect(result.runnable.map((task) => task.id)).toEqual([h.getTask('A')!.id]);
    expect(result.topup).toEqual([]);
    expect(h.getTask('A')!.execution.workspacePath).toBeUndefined();
    expect(h.getTask('A')!.status).toBe('running');
  });

  it('set-task-external-gate-policies records the newly unblocked task for the outbox', async () => {
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

    const result = await dispatchStarted(h, started, 'test.set-task-external-gate-policies');

    expect(result.runnable.map((task) => task.id)).toEqual([leafId]);
    expect(result.topup).toEqual([]);
    expect(h.getTask('leaf')!.execution.workspacePath).toBeUndefined();
    expect(h.getTask('leaf')!.status).toBe('running');
  });

  it('replace-task records replacement launches for the outbox', async () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    h.orchestrator.cancelTask('B');

    const started = h.orchestrator.replaceTask('A', [
      { id: 'A-fix-1', description: 'Fix part 1', command: 'echo fix1' },
      { id: 'A-fix-2', description: 'Fix part 2', command: 'echo fix2', dependencies: ['A-fix-1'] },
    ]);
    expect(started.some((task) => task.id.endsWith('/A-fix-1') && task.status === 'running')).toBe(true);
    expect(h.getTask('A-fix-1')!.execution.workspacePath).toBeUndefined();

    const result = await dispatchStarted(h, started, 'test.replace-task');

    expect(result.runnable.map((task) => task.id)).toEqual([h.getTask('A-fix-1')!.id]);
    expect(result.topup).toEqual([]);
    expect(h.getTask('A-fix-1')!.execution.workspacePath).toBeUndefined();
    expect(h.getTask('A-fix-1')!.status).toBe('running');
  });

  it('set-merge-branch leaves merge relaunch for the outbox', async () => {
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

    const result = await dispatchStarted(h, started, 'test.set-merge-branch');

    expect(result.runnable.map((task) => task.id)).toEqual([mergeTaskId]);
    expect(result.topup).toEqual([]);
    expect(h.getTask(mergeTaskId)!.execution.workspacePath).toBe('/tmp/mock-merge-worktree');
    expect(h.getTask(mergeTaskId)!.status).toBe('running');
    expect(h.persistence.loadWorkflow(workflowId).baseBranch).toBe('develop');
  });

  it('standalone-owner set-merge-branch leaves merge relaunch for the outbox', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeTaskId = h.getAllTasks().find((task) => task.config.isMergeNode)!.id;
    const workflowId = h.getTask(mergeTaskId)!.config.workflowId!;
    await h.executor.executeTasks([h.getTask(mergeTaskId)!]);

    h.persistence.updateWorkflow(workflowId, { baseBranch: 'release' });
    const started = h.orchestrator.retryTask(mergeTaskId);
    const result = await dispatchStarted(h, started, 'test.standalone.set-merge-branch');

    expect(result.runnable.map((task) => task.id)).toEqual([mergeTaskId]);
    expect(result.topup).toEqual([]);
    expect(h.getTask(mergeTaskId)!.execution.workspacePath).toBe('/tmp/mock-merge-worktree');
    expect(h.getTask(mergeTaskId)!.status).toBe('running');
    expect(h.persistence.loadWorkflow(workflowId).baseBranch).toBe('release');
  });
});
