/**
 * Regression coverage for the merge-gate direct-write lineage guard.
 *
 * The merge-gate executor persists execution metadata (branch, workspacePath,
 * review fields) directly to persistence before emitComplete routes the worker
 * response through the orchestrator's lineage guard. Without a guard on the
 * direct write, a stale gate run — one whose merge task has already advanced to
 * a newer selectedAttemptId / executionGeneration — could clobber the metadata
 * owned by the newer launch.
 *
 * These tests prove:
 *  1. a stale merge-gate run cannot write direct execution metadata;
 *  2. the eventual stale worker response is still rejected by the orchestrator;
 *  3. a valid (current-lineage) merge-gate completion still persists metadata.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  Orchestrator,
  type Attempt,
  type TaskState,
  type TaskStateChanges,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '@invoker/workflow-core';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import { MergeGateExecutor } from '../merge-gate-executor.js';
import type { MergeRunnerHost } from '../merge-runner.js';

const GATE_WORKSPACE = '/tmp/merge-gate-stale-test-workspace';

function makeMergeTask(generation: number): TaskState {
  return {
    id: '__merge__wf-stale',
    description: 'Merge gate',
    status: 'running',
    dependencies: [],
    createdAt: new Date(),
    config: { isMergeNode: true } as TaskState['config'],
    execution: { generation } as TaskState['execution'],
  } as TaskState;
}

/**
 * Minimal MergeRunnerHost for driving MergeGateExecutor through a manual-mode
 * merge gate with no feature branch — runMergeGateActionImpl short-circuits to a
 * review_ready result without any git, exercising only the direct-write path.
 */
function makeHost(mergeTask: TaskState): {
  host: MergeRunnerHost;
  updateTask: ReturnType<typeof vi.fn>;
} {
  const updateTask = vi.fn();
  const host = {
    cwd: '/tmp/host',
    defaultBranch: 'master',
    persistence: {
      loadWorkflow: () => undefined,
      updateTask,
    },
    orchestrator: {
      // getTask reflects the *live* task, including any generation advance.
      getTask: (id: string) => (id === mergeTask.id ? mergeTask : undefined),
      getAllTasks: () => [mergeTask],
    },
    async createMergeWorktree() {
      return GATE_WORKSPACE;
    },
    async detectDefaultBranch() {
      return 'master';
    },
  } as unknown as MergeRunnerHost;
  return { host, updateTask };
}

function makeRequest(executionGeneration: number): WorkRequest {
  return {
    requestId: 'merge-__merge__wf-stale',
    actionId: '__merge__wf-stale',
    executionGeneration,
    actionType: 'command',
    inputs: {},
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
  };
}

async function runGate(host: MergeRunnerHost, request: WorkRequest): Promise<WorkResponse> {
  const executor = new MergeGateExecutor(host);
  const handle = await executor.start(request);
  try {
    return await new Promise<WorkResponse>((resolve) => {
      executor.onComplete(handle, resolve);
    });
  } finally {
    await executor.destroyAll();
  }
}

describe('merge-gate direct-write lineage guard', () => {
  it('skips direct execution-metadata writes when the merge task has advanced (stale run)', async () => {
    // Live task is at generation 2; the gate run was launched at generation 0.
    const mergeTask = makeMergeTask(2);
    const { host, updateTask } = makeHost(mergeTask);

    const response = await runGate(host, makeRequest(0));

    // No direct write happened: neither the start-of-run review-metadata clear
    // nor the final branch/workspacePath write reached persistence.
    expect(updateTask).not.toHaveBeenCalled();

    // The executor still emits a response carrying the stale generation, which
    // the orchestrator's worker-response guard will reject (see next test).
    expect(response.executionGeneration).toBe(0);
    expect(response.status).toBe('review_ready');
  });

  it('persists a valid (current-lineage) merge-gate completion', async () => {
    // Live task generation matches the launch generation — nothing stale.
    const mergeTask = makeMergeTask(0);
    const { host, updateTask } = makeHost(mergeTask);

    const response = await runGate(host, makeRequest(0));

    // Both the review-metadata clear and the final execution write are applied.
    const executionWrites = updateTask.mock.calls
      .map((call) => (call[1] as TaskStateChanges).execution)
      .filter((e): e is NonNullable<TaskStateChanges['execution']> => !!e);

    expect(executionWrites.some((e) => e.workspacePath === GATE_WORKSPACE)).toBe(true);
    expect(
      executionWrites.some(
        (e) =>
          e.reviewUrl === undefined &&
          e.reviewId === undefined &&
          e.reviewStatus === undefined &&
          e.workspacePath === undefined,
      ),
    ).toBe(true);
    expect(response.status).toBe('review_ready');
    expect(response.executionGeneration).toBe(0);
  });

  it('rejects the eventual stale worker response via the orchestrator guard', () => {
    const warnings: Array<{ msg: string; data: unknown }> = [];
    const recordingLogger = {
      debug() {},
      info() {},
      warn(msg: string, data?: unknown) {
        warnings.push({ msg, data });
      },
      error() {},
      child() {
        return recordingLogger;
      },
    };

    const persistence = new TestPersistence();
    const orchestrator = new Orchestrator({
      persistence,
      messageBus: new TestBus(),
      maxConcurrency: 1,
      logger: recordingLogger as never,
    });
    orchestrator.loadPlan({
      name: 'stale-merge-response',
      onFinish: 'none',
      tasks: [{ id: 'A', description: 'Root', command: 'echo A' }],
    });
    orchestrator.startExecution();
    const taskId =
      orchestrator.getAllTasks().find((t) => t.id === 'A' || t.id.endsWith('/A'))?.id ?? 'A';

    const launchGeneration = orchestrator.getTask(taskId)?.execution.generation ?? 0;

    // Advance the task to a newer generation (mirrors a recreate/restart that a
    // stale gate run would race against).
    orchestrator.prepareTaskForNewAttempt(taskId, 'test-advance');
    const advancedGeneration = orchestrator.getTask(taskId)?.execution.generation ?? 0;
    expect(advancedGeneration).not.toBe(launchGeneration);

    // A merge-gate-style response carrying the stale generation (no attemptId,
    // as merge gates dispatch by generation) must be rejected outright.
    const staleResponse: WorkResponse = {
      requestId: `merge-${taskId}`,
      actionId: taskId,
      executionGeneration: launchGeneration,
      status: 'review_ready',
      outputs: { exitCode: 0 },
    };
    const newlyStarted = orchestrator.handleWorkerResponse(staleResponse) ?? [];

    expect(newlyStarted).toEqual([]);
    expect(orchestrator.getTask(taskId)?.execution.generation).toBe(advancedGeneration);
    // Rejected specifically by the generation guard (not a coincidental no-op).
    expect(
      warnings.some(
        (w) =>
          w.msg === '[worker-response] STALE_GENERATION_REJECTED' &&
          (w.data as { responseGeneration?: number })?.responseGeneration === launchGeneration &&
          (w.data as { activeGeneration?: number })?.activeGeneration === advancedGeneration,
      ),
    ).toBe(true);
  });
});

// ── Minimal in-memory orchestrator backing store ──────────

class TestPersistence implements OrchestratorPersistence {
  workflows = new Map<string, Record<string, unknown>>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt>();

  saveWorkflow(wf: Record<string, unknown> & { id: string }): void {
    this.workflows.set(wf.id, {
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
  listWorkflows() {
    return Array.from(this.workflows.values());
  }
  loadTasks(wfId: string) {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === wfId)
      .map((e) => e.task);
  }
  loadWorkflow(id: string) {
    return this.workflows.get(id) as never;
  }
  getWorkspacePath(taskId: string) {
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
    const attempt = this.attempts.get(attemptId);
    return attempt ? { ...attempt } : undefined;
  }
  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) this.attempts.set(attemptId, { ...attempt, ...changes });
  }
}

class TestBus implements OrchestratorMessageBus {
  publish(): void {}
}
