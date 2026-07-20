import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import { computeWorkflowRollup } from '../task-types.js';
import type { TaskState, TaskStateChanges, Attempt, ExternalDependency, ExternalDependencyChange, DetachedExternalDependency } from '../task-types.js';
import type { Logger, WorkResponse } from '@invoker/contracts';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  updateWorkflowCalls = new Map<string, number>();

  saveWorkflow(workflow: {
    id: string;
    name: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      // Synthesize a placeholder repoUrl so SSH-validation tests
      // (Step 5 `editTaskType` → ssh) keep passing without each
      // plan having to spell out a remote URL.
      repoUrl: workflow.repoUrl ?? 'memory://test-repo',
      baseBranch: workflow.baseBranch,
      featureBranch: workflow.featureBranch,
      createdAt: (workflow as any).createdAt ?? now,
      updatedAt: (workflow as any).updatedAt ?? now,
    });
  }

  updateWorkflow(
    workflowId: string,
    changes: {
      updatedAt?: string;
      baseBranch?: string;
      mergeMode?: 'manual' | 'automatic' | 'external_review';
      externalDependencies?: ExternalDependency[];
      externalDependencyChanges?: ExternalDependencyChange[];
      detachedExternalDependencies?: DetachedExternalDependency[];
    },
  ): void {
    const wf = this.workflows.get(workflowId);
    this.updateWorkflowCalls.set(workflowId, (this.updateWorkflowCalls.get(workflowId) ?? 0) + 1);
    if (wf && changes.updatedAt) {
      wf.updatedAt = changes.updatedAt;
    }
    if (wf && changes.mergeMode !== undefined) {
      wf.mergeMode = changes.mergeMode;
    }
    if (wf && changes.baseBranch !== undefined) {
      wf.baseBranch = changes.baseBranch;
    }
    if (wf && 'externalDependencies' in changes) {
      wf.externalDependencies = changes.externalDependencies;
    }
    if (wf && 'externalDependencyChanges' in changes) {
      wf.externalDependencyChanges = changes.externalDependencyChanges;
    }
    if (wf && 'detachedExternalDependencies' in changes) {
      wf.detachedExternalDependencies = changes.detachedExternalDependencies;
    }
  }

  loadWorkflow(workflowId: string): {
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
    externalDependencies?: ExternalDependency[];
    externalDependencyChanges?: ExternalDependencyChange[];
    detachedExternalDependencies?: DetachedExternalDependency[];
  } | undefined {
    const wf = this.workflows.get(workflowId);
    if (!wf) return undefined;
    const derived = this.withDerivedStatus(wf);
    return {
      ...derived,
      repoUrl: derived.repoUrl,
      baseBranch: derived.baseBranch,
      featureBranch: derived.featureBranch,
      mergeMode: derived.mergeMode,
    };
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  /** Resolve bare plan-local id to the single matching persisted key when unambiguous (test helper). */
  private resolveBareTaskKey(taskId: string): string {
    let resolvedId = taskId;
    let entry = this.tasks.get(resolvedId);
    if (
      !entry &&
      !taskId.includes('/') &&
      !taskId.startsWith('__merge__') &&
      !taskId.endsWith('-reconciliation')
    ) {
      const suffix = `/${taskId}`;
      const matches: string[] = [];
      for (const id of this.tasks.keys()) {
        if (id === taskId || id.endsWith(suffix)) {
          matches.push(id);
        }
      }
      if (matches.length === 1) {
        resolvedId = matches[0];
      }
    }
    return resolvedId;
  }

  getTaskEntry(taskId: string): { workflowId: string; task: TaskState } | undefined {
    return this.tasks.get(this.resolveBareTaskKey(taskId));
  }

  updateTask(taskId: string, changes: TaskStateChanges): void {
    const resolvedId = this.resolveBareTaskKey(taskId);
    const entry = this.tasks.get(resolvedId);
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

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string; repoUrl?: string }> {
    return Array.from(this.workflows.values()).map((workflow) => this.withDerivedStatus(workflow));
  }

  loadWorkflowTaskSnapshot(): {
    workflows: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string; repoUrl?: string }>;
    tasks: TaskState[];
    tasksByWorkflowId: Map<string, TaskState[]>;
  } {
    const tasksByWorkflowId = new Map<string, TaskState[]>();
    for (const { workflowId, task } of this.tasks.values()) {
      const workflowTasks = tasksByWorkflowId.get(workflowId) ?? [];
      workflowTasks.push(task);
      tasksByWorkflowId.set(workflowId, workflowTasks);
    }
    const workflows = Array.from(this.workflows.values()).map((workflow) => this.withDerivedStatus(workflow, tasksByWorkflowId.get(workflow.id) ?? []));
    return {
      workflows,
      tasks: Array.from(this.tasks.values()).map((entry) => entry.task),
      tasksByWorkflowId,
    };
  }

  private withDerivedStatus<T extends { id: string }>(workflow: T, tasks = this.loadTasks(workflow.id)): T & { status: string } {
    const rollup = computeWorkflowRollup(tasks);
    return { ...workflow, status: rollup.status, rollup };
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.events.push({ taskId, eventType, payload });
  }

  saveAttempt(attempt: Attempt): void {
    const list = this.attempts.get(attempt.nodeId) ?? [];
    list.push(attempt);
    this.attempts.set(attempt.nodeId, list);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return this.attempts.get(nodeId) ?? [];
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    for (const list of this.attempts.values()) {
      const found = list.find(a => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex(a => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }

  deleteTask(taskId: string): void {
    const resolvedId = this.resolveBareTaskKey(taskId);
    this.tasks.delete(resolvedId);
    this.attempts.delete(resolvedId);
    this.events = this.events.filter((event) => event.taskId !== resolvedId);
  }

  deleteWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    for (const [taskId, entry] of this.tasks) {
      if (entry.workflowId === workflowId) this.tasks.delete(taskId);
    }
  }

  deleteAllWorkflows(): void {
    this.workflows.clear();
    this.tasks.clear();
  }
}


// ── In-Memory MessageBus Mock ───────────────────────────────

class InMemoryBus implements OrchestratorMessageBus {
  published: Array<{ channel: string; message: unknown }> = [];
  private handlers = new Map<string, Set<(msg: unknown) => void>>();

  publish<T>(channel: string, message: T): void {
    this.published.push({ channel, message });
    const handlers = this.handlers.get(channel);
    if (handlers) {
      for (const handler of handlers) {
        handler(message);
      }
    }
  }

  subscribe(channel: string, handler: (msg: unknown) => void): () => void {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
    }
    this.handlers.get(channel)!.add(handler);
    return () => this.handlers.get(channel)?.delete(handler);
  }
}

const consoleLogger: Logger = {
  debug: (msg, fields) => console.debug(msg, fields),
  info: (msg, fields) => console.log(msg, fields),
  warn: (msg, fields) => console.warn(msg, fields),
  error: (msg, fields) => console.error(msg, fields),
  child: () => consoleLogger,
};

// ── Helpers ─────────────────────────────────────────────────

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 't1',
    executionGeneration: 0,
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

/**
 * Repro for: "Admin Bypass Babysitter Step 2" reported completed while
 * PRs #5127 / #5128 were still open.
 *
 * Observed sequence (~/.invoker/merge-trace.log, 2026-07-20):
 *   07:54:41.715  GATE_WS_SET_FIX_AWAITING          (merge gate enters fix session)
 *   07:54:41.721  worker-autoapprove-submitted      (approve intent queued, channel invoker:approve)
 *   07:54:54      PUBLISH_AFTER_FIX_ENTER
 *   08:08:48.889  GATE_WS_SET_TASK_REVIEW_READY     (fresh, unmerged PRs published)
 *   08:08:48.977  APPROVE_ENTER  status=review_ready
 *   08:08:49.013  APPROVE_DONE   status=completed
 *
 * The approve intent was validated against "awaiting_approval + pendingFixError"
 * (approve the AI fix) but consumed 14 minutes later against "review_ready"
 * (approve the review gate), because Orchestrator.approve accepts both states
 * and re-validates nothing at consumption time.
 */
describe('repro: queued fix-approval intent completes an unmerged external_review gate', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    orchestrator = new Orchestrator({
      persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 3,
      logger: consoleLogger,
      resolveRepoDefaultBranch: () => 'master',
    });
  });

  function loadExternalReviewWorkflow(): TaskState {
    orchestrator.loadPlan({
      name: 'bottom-label-nudge',
      mergeMode: 'external_review',
      onFinish: 'pull_request',
      tasks: [
        { id: 'implement', description: 'Implement bottom label nudge' },
        { id: 'verify', description: 'Verify bottom label nudge', dependencies: ['implement'] },
      ],
    } as any);
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(makeResponse({ actionId: 'implement' }));
    orchestrator.handleWorkerResponse(makeResponse({ actionId: 'verify' }));
    return orchestrator.getAllTasks().find(t => t.config.isMergeNode)!;
  }

  const openPrGate = {
    activeGeneration: 11,
    completion: { required: 'all' as const, status: 'approved' as const },
    artifacts: [
      { id: '5127', providerId: '5127', required: true, status: 'open' as const, generation: 11 },
      { id: '5128', providerId: '5128', required: true, status: 'open' as const, generation: 11 },
    ],
  };

  /**
   * Drives the merge gate along the observed path: CI failure → fix session →
   * fix awaiting approval (where the auto-approve worker queues its intent) →
   * publishAfterFix → review_ready with freshly published, unmerged PRs.
   */
  function driveToReviewReadyWithOpenPrs(mergeId: string): void {
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: mergeId, status: 'failed', outputs: { exitCode: 1, error: 'ci failed' } }),
    );
    orchestrator.beginFixSession(mergeId);
    orchestrator.setFixAwaitingApproval(mergeId, 'ci failed');
    expect(orchestrator.getTask(mergeId)!.execution.pendingFixError).toBeDefined();

    orchestrator.resumeTaskAfterFixApproval(mergeId);
    orchestrator.setTaskReviewReady(mergeId, {
      execution: {
        reviewId: '5127',
        reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/5127',
        reviewStatus: 'Awaiting review',
        reviewGate: openPrGate,
      },
    } as any);
  }

  it('approve() marks the gate completed even though every required PR is still open', async () => {
    const merge = loadExternalReviewWorkflow();
    driveToReviewReadyWithOpenPrs(merge.id);

    const beforeApprove = orchestrator.getTask(merge.id)!;
    expect(beforeApprove.status).toBe('review_ready');
    expect(beforeApprove.execution.pendingFixError).toBeUndefined();
    expect(beforeApprove.execution.reviewGate!.artifacts.every(a => a.status === 'open')).toBe(true);

    // The stale intent lands. Nothing re-validates what it was approving.
    await orchestrator.approve(merge.id);

    const after = orchestrator.getTask(merge.id)!;
    expect(after.execution.reviewGate!.artifacts.every(a => a.status === 'open')).toBe(true);
    expect(after.status).toBe('completed'); // BUG: unmerged stack reported as landed
  });

  it('the approve hook performs no merge for external_review, so nothing lands', async () => {
    const merge = loadExternalReviewWorkflow();
    const approveMerge = vi.fn();

    // Mirrors packages/app/src/execution/task-runner-wiring.ts:70-80
    orchestrator.setBeforeApproveHook(async (task: TaskState) => {
      if (!task.config.isMergeNode || !task.config.workflowId) return;
      if (task.execution.pendingFixError !== undefined) return;
      const workflow = persistence.loadWorkflow(task.config.workflowId);
      if (!workflow) return;
      if (workflow.onFinish !== 'merge') return;
      if (workflow.mergeMode === 'external_review') return;
      approveMerge(task.config.workflowId);
    });

    driveToReviewReadyWithOpenPrs(merge.id);
    await orchestrator.approve(merge.id);

    expect(approveMerge).not.toHaveBeenCalled();
    expect(orchestrator.getTask(merge.id)!.status).toBe('completed');
  });

  it('downstream workflows gated on this merge node unblock as if the stack had landed', async () => {
    const merge = loadExternalReviewWorkflow();
    driveToReviewReadyWithOpenPrs(merge.id);
    await orchestrator.approve(merge.id);

    // externalDependencies use requiredStatus: 'completed' on '__merge__'.
    expect(orchestrator.getTask(merge.id)!.status).toBe('completed');
  });
});
