import { describe, it, expect, vi } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import {
  Orchestrator,
  type Attempt,
  type TaskState,
  type TaskStateChanges,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '@invoker/workflow-core';

import { MergeGateExecutor } from '../merge-gate-executor.js';
import { applyMergeGateMetadataIfCurrent, type MergeRunnerHost } from '../merge-runner.js';

// Regression coverage for the merge-gate "direct write" lineage guard.
//
// Merge-gate work runs asynchronously against a launch-time snapshot of the
// merge task. The worker-response path (handleWorkerResponse) already rejects a
// stale completion, but the executor/merge-runner also persist branch /
// workspacePath / review metadata via *direct* persistence.updateTask calls
// that ran before that guard. applyMergeGateMetadataIfCurrent closes that gap:
// it re-reads the live task and writes only when its lineage still matches the
// launch lineage.

const GATE_PATH = '/tmp/merge-gate-clone';

function makeMergeTask(overrides: {
  generation?: number;
  selectedAttemptId?: string;
}): TaskState {
  return {
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'running',
    dependencies: [],
    createdAt: new Date(),
    config: { isMergeNode: true, workflowId: 'wf-1' },
    execution: {
      generation: overrides.generation ?? 0,
      selectedAttemptId: overrides.selectedAttemptId,
    },
  } as unknown as TaskState;
}

function makeRequest(overrides: {
  attemptId?: string;
  executionGeneration: number;
}): WorkRequest {
  return {
    requestId: 'req-merge-1',
    actionId: '__merge__wf-1',
    attemptId: overrides.attemptId,
    executionGeneration: overrides.executionGeneration,
    actionType: 'merge_gate',
    inputs: {},
    callbackUrl: '',
    timestamps: { createdAt: '2026-06-23T00:00:00.000Z' },
  };
}

/**
 * Minimal MergeGateExecutor host for the manual / no-feature-branch path:
 * runMergeGateActionImpl returns review_ready with execution { workspacePath }
 * and never touches real git.
 */
function makeExecutorHost(args: {
  liveTask: TaskState;
  updateCalls: Array<{ id: string; changes: TaskStateChanges }>;
}): MergeRunnerHost {
  return {
    cwd: '/tmp/host',
    defaultBranch: 'master',
    persistence: {
      loadWorkflow: () => ({
        id: 'wf-1',
        onFinish: 'none',
        mergeMode: 'manual',
        baseBranch: 'master',
        featureBranch: undefined,
        name: 'WF',
      }),
      updateTask: (id: string, changes: TaskStateChanges) => {
        args.updateCalls.push({ id, changes });
      },
      getWorkspacePath: () => null,
    },
    orchestrator: {
      getTask: (id: string) => (id === args.liveTask.id ? args.liveTask : undefined),
    },
    async createMergeWorktree() {
      return GATE_PATH;
    },
    async buildMergeSummary() {
      return '## Summary';
    },
    async detectDefaultBranch() {
      return 'master';
    },
  } as unknown as MergeRunnerHost;
}

/** Drive MergeGateExecutor.start() and resolve with the emitted completion. */
async function runExecutor(host: MergeRunnerHost, request: WorkRequest): Promise<WorkResponse> {
  const executor = new MergeGateExecutor(host);
  try {
    const handle = await executor.start(request);
    return await new Promise<WorkResponse>((resolve) => {
      executor.onComplete(handle, resolve);
    });
  } finally {
    await executor.destroyAll();
  }
}

describe('merge-gate stale direct-write guard', () => {
  it('a stale merge-gate run cannot write direct execution metadata', async () => {
    // The task advanced to a newer attempt + generation while this gate ran:
    // the live task is att-new/gen 1, but the launch request is att-old/gen 0.
    const liveTask = makeMergeTask({ generation: 1, selectedAttemptId: 'att-new' });
    const updateCalls: Array<{ id: string; changes: TaskStateChanges }> = [];
    const host = makeExecutorHost({ liveTask, updateCalls });

    const response = await runExecutor(host, makeRequest({ attemptId: 'att-old', executionGeneration: 0 }));

    // The guarded executor write (branch / workspacePath) must be dropped: no
    // persisted change may carry the stale gate's workspacePath or branch.
    const wroteWorkspacePath = updateCalls.some(
      (c) => c.changes.execution && 'workspacePath' in c.changes.execution,
    );
    const wroteBranch = updateCalls.some(
      (c) => c.changes.execution && 'branch' in c.changes.execution,
    );
    expect(wroteWorkspacePath).toBe(false);
    expect(wroteBranch).toBe(false);
    expect(updateCalls.some((c) => JSON.stringify(c.changes).includes(GATE_PATH))).toBe(false);

    // The completion still carries the stale launch lineage, so the downstream
    // worker-response guard will reject it (proved end-to-end below).
    expect(response.executionGeneration).toBe(0);
    expect(response.attemptId).toBe('att-old');
  });

  it('valid merge-gate review-ready metadata still persists', async () => {
    // Lineage unchanged: request att-1/gen 0 matches the live task.
    const liveTask = makeMergeTask({ generation: 0, selectedAttemptId: 'att-1' });
    const updateCalls: Array<{ id: string; changes: TaskStateChanges }> = [];
    const host = makeExecutorHost({ liveTask, updateCalls });

    const response = await runExecutor(host, makeRequest({ attemptId: 'att-1', executionGeneration: 0 }));

    const workspaceWrite = updateCalls.find(
      (c) => c.changes.execution && c.changes.execution.workspacePath === GATE_PATH,
    );
    expect(workspaceWrite).toBeDefined();
    expect(response.status).toBe('review_ready');
  });

  it('the eventual stale worker response is still rejected by the orchestrator', () => {
    const persistence = new TestPersistence();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new TestBus(),
      maxConcurrency: 3,
    });
    orchestrator.loadPlan({
      name: 'Merge gate lineage',
      tasks: [{ id: 'task-a', description: 'task A' }],
    });
    const workflowId = orchestrator.getWorkflowIds()[0]!;
    const mergeId = `__merge__${workflowId}`;

    // Live merge task: attempt att-current, generation 1.
    persistence.updateTask(mergeId, {
      status: 'running',
      execution: { generation: 1, selectedAttemptId: 'att-current' },
    });

    const staleReviewReady = (overrides: Partial<WorkResponse>): WorkResponse => ({
      requestId: `merge-${mergeId}`,
      actionId: mergeId,
      status: 'review_ready',
      executionGeneration: 0,
      outputs: {
        exitCode: 0,
        branch: 'feature/stale',
        reviewUrl: 'https://example.test/stale',
        reviewId: 'owner/repo#stale',
        reviewStatus: 'Awaiting review',
      },
      ...overrides,
    });

    // Stale by generation (attempt still matches): rejected.
    expect(
      orchestrator.handleWorkerResponse(staleReviewReady({ attemptId: 'att-current' })),
    ).toEqual([]);
    // Stale by selectedAttemptId: rejected.
    expect(
      orchestrator.handleWorkerResponse(staleReviewReady({ attemptId: 'att-old', executionGeneration: 1 })),
    ).toEqual([]);

    const task = orchestrator.getTask(mergeId)!;
    expect(task.status).toBe('running');
    expect(task.execution.reviewUrl).toBeUndefined();
    expect(task.execution.branch).toBeUndefined();
  });

  it('applyMergeGateMetadataIfCurrent enforces attempt and generation lineage', () => {
    const updateCalls: Array<{ id: string; changes: TaskStateChanges }> = [];
    const host = {
      orchestrator: {
        getTask: () => makeMergeTask({ generation: 2, selectedAttemptId: 'att-live' }),
      },
      persistence: {
        updateTask: (id: string, changes: TaskStateChanges) => {
          updateCalls.push({ id, changes });
        },
      },
    } as unknown as Pick<MergeRunnerHost, 'orchestrator' | 'persistence'>;

    const change: TaskStateChanges = { execution: { workspacePath: GATE_PATH } };

    // Stale generation -> rejected.
    expect(
      applyMergeGateMetadataIfCurrent(host, '__merge__wf-1', change, {
        selectedAttemptId: 'att-live',
        generation: 1,
      }),
    ).toBe(false);
    // Stale attempt -> rejected.
    expect(
      applyMergeGateMetadataIfCurrent(host, '__merge__wf-1', change, {
        selectedAttemptId: 'att-old',
        generation: 2,
      }),
    ).toBe(false);
    expect(updateCalls).toHaveLength(0);

    // Matching lineage -> applied.
    expect(
      applyMergeGateMetadataIfCurrent(host, '__merge__wf-1', change, {
        selectedAttemptId: 'att-live',
        generation: 2,
      }),
    ).toBe(true);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].changes.execution?.workspacePath).toBe(GATE_PATH);
  });
});

// ── Minimal OrchestratorPersistence for the worker-response rejection test ──

class TestPersistence implements OrchestratorPersistence {
  workflows = new Map<string, any>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt>();

  saveWorkflow(wf: any): void {
    this.workflows.set(wf.id, {
      ...wf,
      createdAt: wf.createdAt ?? new Date().toISOString(),
      updatedAt: wf.updatedAt ?? new Date().toISOString(),
    });
  }
  updateWorkflow(id: string, changes: any): void {
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
  listWorkflows(): any[] {
    return Array.from(this.workflows.values());
  }
  loadTasks(wfId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === wfId)
      .map((e) => e.task);
  }
  loadWorkflow(id: string): any {
    return this.workflows.get(id);
  }
  getWorkspacePath(taskId: string): string | null {
    return this.tasks.get(taskId)?.task.execution.workspacePath ?? null;
  }
  logEvent(): void {}
  saveAttempt(attempt: Attempt): void {
    this.attempts.set(attempt.id, { ...attempt });
  }
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
