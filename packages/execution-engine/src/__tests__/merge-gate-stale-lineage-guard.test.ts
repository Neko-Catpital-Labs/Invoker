// Regression coverage for the merge-gate direct-write lineage guard: a stale
// (relaunched) merge-gate run must not clobber the fresh launch's metadata,
// the eventual stale worker response is still rejected, and a current run
// still persists review-ready metadata.

import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Logger, WorkRequest, WorkResponse } from '@invoker/contracts';
import {
  Orchestrator,
  type Attempt,
  type TaskState,
  type TaskStateChanges,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '@invoker/workflow-core';
import { MergeGateExecutor } from '../merge-gate-executor.js';
import type { MergeRunnerHost } from '../merge-runner.js';
import type { ExecutorHandle } from '../executor.js';

const GATE_WORKSPACE = '/tmp/gate-clone-fake';
const FEATURE_BRANCH = 'plan/feature';
const MERGE_TASK_ID = '__merge__wf-gate';

function makeMergeTask(execution: Partial<TaskState['execution']>): TaskState {
  return {
    id: MERGE_TASK_ID,
    description: 'Merge gate',
    status: 'running',
    dependencies: ['t1'],
    createdAt: new Date(),
    config: { isMergeNode: true, workflowId: 'wf-gate' } as TaskState['config'],
    execution: { ...execution } as TaskState['execution'],
  } as TaskState;
}

// Minimal host: with onFinish='none' and mergeMode='manual' the run takes the
// no-consolidation review_ready branch and never shells out to git.
function makeHost(opts: {
  liveTask: TaskState;
  updateTask: ReturnType<typeof vi.fn>;
}): MergeRunnerHost {
  return {
    cwd: '/tmp/host-repo',
    defaultBranch: 'master',
    persistence: {
      loadWorkflow: () => ({
        id: 'wf-gate',
        onFinish: 'none',
        mergeMode: 'manual',
        baseBranch: 'master',
        featureBranch: FEATURE_BRANCH,
        name: 'Gate Workflow',
      }),
      updateTask: opts.updateTask,
      getWorkspacePath: () => GATE_WORKSPACE,
    },
    orchestrator: {
      getTask: (id: string) => (id === opts.liveTask.id ? opts.liveTask : undefined),
      getAllTasks: () => [opts.liveTask],
    },
    async createMergeWorktree() {
      return GATE_WORKSPACE;
    },
    async detectDefaultBranch() {
      return 'master';
    },
    async buildMergeSummary() {
      return '## Summary';
    },
  } as unknown as MergeRunnerHost;
}

function makeRequest(attemptId: string | undefined, executionGeneration: number): WorkRequest {
  return {
    requestId: `merge-${MERGE_TASK_ID}`,
    actionId: MERGE_TASK_ID,
    attemptId,
    executionGeneration,
    actionType: 'merge_gate',
    inputs: {},
    callbackUrl: '',
    timestamps: { createdAt: new Date(2026, 0, 1).toISOString() },
  } as WorkRequest;
}

async function runToCompletion(
  executor: MergeGateExecutor,
  request: WorkRequest,
): Promise<WorkResponse> {
  const handle: ExecutorHandle = await executor.start(request);
  return new Promise<WorkResponse>((resolve) => {
    executor.onComplete(handle, resolve);
  });
}

// ── In-memory OrchestratorPersistence for the real-orchestrator assertion ──

class TestPersistence implements OrchestratorPersistence {
  workflows = new Map<string, Record<string, unknown>>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt>();

  saveWorkflow(wf: Record<string, unknown>): void {
    this.workflows.set(wf.id as string, {
      ...wf,
      createdAt: wf.createdAt ?? new Date().toISOString(),
      updatedAt: wf.updatedAt ?? new Date().toISOString(),
    });
  }
  updateWorkflow(id: string, changes: Record<string, unknown>): void {
    const wf = this.workflows.get(id);
    if (wf) Object.assign(wf, changes);
  }
  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }
  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (entry) {
      entry.task = {
        ...entry.task,
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
        config: { ...entry.task.config, ...changes.config },
        execution: { ...entry.task.execution, ...changes.execution },
      } as TaskState;
    }
  }
  listWorkflows() { return Array.from(this.workflows.values()); }
  loadTasks(wfId: string) {
    return Array.from(this.tasks.values()).filter((e) => e.workflowId === wfId).map((e) => e.task);
  }
  loadWorkflow(id: string) { return this.workflows.get(id) as never; }
  getWorkspacePath(taskId: string) {
    return this.tasks.get(taskId)?.task.execution.workspacePath ?? null;
  }
  logEvent(): void {}
  saveAttempt(attempt: Attempt): void { this.attempts.set(attempt.id, { ...attempt }); }
  loadAttempts(nodeId: string): Attempt[] {
    return Array.from(this.attempts.values()).filter((a) => a.nodeId === nodeId);
  }
  loadAttempt(attemptId: string): Attempt | undefined {
    const a = this.attempts.get(attemptId);
    return a ? { ...a } : undefined;
  }
  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    const a = this.attempts.get(attemptId);
    if (a) this.attempts.set(attemptId, { ...a, ...changes });
  }
}

class TestBus implements OrchestratorMessageBus {
  publish(): void {}
}

describe('merge-gate stale-lineage direct-write guard', () => {
  let executor: MergeGateExecutor | undefined;

  afterEach(async () => {
    await executor?.destroyAll();
    executor = undefined;
  });

  it('does not write direct execution metadata when the merge task advanced to a newer attempt', async () => {
    // Launch is attempt-1/gen 0; the live task has relaunched to attempt-2/gen 1.
    const liveTask = makeMergeTask({ selectedAttemptId: 'attempt-2', generation: 1 });
    const updateTask = vi.fn();
    const host = makeHost({ liveTask, updateTask });
    executor = new MergeGateExecutor(host);

    const response = await runToCompletion(executor, makeRequest('attempt-1', 0));

    expect(updateTask).not.toHaveBeenCalled();
    // Completion carries the stale lineage so the worker-response guard rejects it.
    expect(response.status).toBe('review_ready');
    expect(response.attemptId).toBe('attempt-1');
    expect(response.executionGeneration).toBe(0);
  });

  it('does not write direct execution metadata when the merge task advanced to a newer generation', async () => {
    // Same attempt id, but the live generation moved past the launch one.
    const liveTask = makeMergeTask({ selectedAttemptId: 'attempt-1', generation: 2 });
    const updateTask = vi.fn();
    const host = makeHost({ liveTask, updateTask });
    executor = new MergeGateExecutor(host);

    const response = await runToCompletion(executor, makeRequest('attempt-1', 0));

    expect(updateTask).not.toHaveBeenCalled();
    expect(response.status).toBe('review_ready');
    expect(response.executionGeneration).toBe(0);
  });

  it('persists review-ready metadata when the launch lineage is still current', async () => {
    // Live task matches the launch lineage (attempt-1/gen 0).
    const liveTask = makeMergeTask({ selectedAttemptId: 'attempt-1', generation: 0 });
    const updateTask = vi.fn();
    const host = makeHost({ liveTask, updateTask });
    executor = new MergeGateExecutor(host);

    const response = await runToCompletion(executor, makeRequest('attempt-1', 0));

    expect(response.status).toBe('review_ready');

    // The branch + gate workspace handoff must persist for a current run.
    const handoff = updateTask.mock.calls.find(
      ([, changes]) =>
        (changes as TaskStateChanges).execution?.branch === FEATURE_BRANCH,
    );
    expect(handoff).toBeDefined();
    expect((handoff![1] as TaskStateChanges).execution).toMatchObject({
      branch: FEATURE_BRANCH,
      workspacePath: GATE_WORKSPACE,
    });
  });

  it('worker-response guard still rejects the eventual stale merge-gate response', () => {
    const warn = vi.fn();
    const logger: Logger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
      child: () => logger,
    };
    {
      const persistence = new TestPersistence();
      const orchestrator = new Orchestrator({
        persistence,
        messageBus: new TestBus(),
        maxConcurrency: 1,
        logger,
      });
      orchestrator.loadPlan({
        name: 'gate-wf',
        onFinish: 'none',
        tasks: [{ id: 'gate', description: 'Merge gate', command: 'true' }],
      });
      orchestrator.startExecution();

      const taskId = orchestrator
        .getAllTasks()
        .find((t) => t.id === 'gate' || t.id.endsWith('/gate'))!.id;

      // Relaunch the task: bumps generation to 1 and selects a fresh attempt.
      const workflowId = orchestrator.getWorkflowIds()[0]!;
      orchestrator.recreateWorkflow(workflowId);

      const current = orchestrator.getTask(taskId)!;
      const currentAttemptId = current.execution.selectedAttemptId;
      expect(current.execution.generation).toBe(1);
      const branchBefore = current.execution.branch;

      // The stale merge-gate completion carries the prior generation (0).
      const staleResponse: WorkResponse = {
        requestId: `merge-${taskId}`,
        actionId: taskId,
        attemptId: currentAttemptId,
        executionGeneration: 0,
        status: 'review_ready',
        outputs: { exitCode: 0, branch: 'stale/feature' },
      };
      const newlyStarted = orchestrator.handleWorkerResponse(staleResponse);

      expect(newlyStarted).toEqual([]);
      // The stale branch must not have landed on the live task.
      expect(orchestrator.getTask(taskId)!.execution.branch).toBe(branchBefore);
      expect(warn).toHaveBeenCalledWith(
        '[worker-response] STALE_GENERATION_REJECTED',
        expect.objectContaining({
          taskId,
          responseGeneration: 0,
          activeGeneration: 1,
          workerResponseStatus: 'review_ready',
        }),
      );
    }
  });
});
