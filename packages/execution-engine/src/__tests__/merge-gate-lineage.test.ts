import { describe, expect, it, vi } from 'vitest';
import type { WorkResponse } from '@invoker/contracts';
import { Orchestrator, type OrchestratorMessageBus, type OrchestratorPersistence, type TaskState, type TaskStateChanges, type Attempt } from '@invoker/workflow-core';
import { MergeGateExecutor } from '../merge-gate-executor.js';
import { publishAfterFixImpl, type MergeRunnerHost } from '../merge-runner.js';

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
}

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, any>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt>();
  updateTask = vi.fn((taskId: string, changes: TaskStateChanges) => {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.task = {
      ...entry.task,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...entry.task.config, ...changes.config },
      execution: { ...entry.task.execution, ...changes.execution },
    } as TaskState;
  });

  saveWorkflow(workflow: any): void {
    this.workflows.set(workflow.id, workflow);
  }

  loadWorkflow(workflowId: string): any {
    return this.workflows.get(workflowId);
  }

  updateWorkflow(workflowId: string, changes: any): void {
    const workflow = this.workflows.get(workflowId);
    if (workflow) this.workflows.set(workflowId, { ...workflow, ...changes });
  }

  listWorkflows(): any[] {
    return [...this.workflows.values()];
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  loadTasks(workflowId: string): TaskState[] {
    return [...this.tasks.values()].filter((entry) => entry.workflowId === workflowId).map((entry) => entry.task);
  }

  saveAttempt(attempt: Attempt): void {
    this.attempts.set(attempt.id, attempt);
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    return this.attempts.get(attemptId);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return [...this.attempts.values()].filter((attempt) => attempt.nodeId === nodeId);
  }

  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    const attempt = this.attempts.get(attemptId);
    if (attempt) this.attempts.set(attemptId, { ...attempt, ...changes } as Attempt);
  }

  logEvent(): void {}
}

function makeMergeTask(execution: Partial<TaskState['execution']>): TaskState {
  return {
    id: '__merge__wf-lineage',
    description: 'Merge gate',
    status: 'running',
    dependencies: [],
    createdAt: new Date(),
    config: { isMergeNode: true, workflowId: 'wf-lineage' },
    execution,
  } as TaskState;
}

function makeHost(args: {
  persistence: InMemoryPersistence;
  orchestrator: Orchestrator;
  onConsolidate?: () => void;
  mergeMode?: 'manual' | 'external_review';
}): MergeRunnerHost {
  return {
    cwd: '/repo',
    defaultBranch: 'main',
    callbacks: {},
    persistence: args.persistence as any,
    orchestrator: args.orchestrator,
    mergeGateProvider: {
      createReview: vi.fn().mockResolvedValue({
        url: 'https://example.test/review/1',
        identifier: 'review-1',
      }),
    },
    async execGitReadonly() { return ''; },
    async execGitIn() { return ''; },
    async createMergeWorktree() { return '/tmp/gate-workspace'; },
    async removeMergeWorktree() {},
    async execGh() { return ''; },
    async execPr() { return 'https://example.test/pr/1'; },
    async detectDefaultBranch() { return 'main'; },
    async gitLogMessage() { return ''; },
    async gitDiffStat() { return ''; },
    async executeTasks() {},
    async buildMergeSummary() { return '## Summary'; },
    async consolidateAndMerge() {
      args.onConsolidate?.();
      return undefined;
    },
    async authorPrBodyWithSkill() {
      return { body: '## Summary\n\nBody', sessionId: 'sess-1', agentName: 'codex' };
    },
  };
}

async function runMergeGate(executor: MergeGateExecutor, attemptId: string): Promise<WorkResponse> {
  const handle = await executor.start({
    requestId: `req-${attemptId}`,
    actionId: '__merge__wf-lineage',
    actionType: 'command',
    attemptId,
    executionGeneration: 0,
    inputs: {},
    callbackUrl: 'http://localhost/callback',
  });

  return await new Promise<WorkResponse>((resolve) => {
    executor.onComplete(handle, resolve);
  });
}

describe('merge-gate lineage side effects', () => {
  it('does not let a stale merge-gate run write direct execution metadata, and the stale response is rejected', async () => {
    const persistence = new InMemoryPersistence();
    persistence.saveWorkflow({
      id: 'wf-lineage',
      name: 'Lineage',
      status: 'running',
      onFinish: 'merge',
      mergeMode: 'manual',
      baseBranch: 'main',
      featureBranch: 'feature/live',
    });
    persistence.saveTask('wf-lineage', makeMergeTask({
      selectedAttemptId: 'attempt-old',
      generation: 0,
      workspacePath: '/tmp/old-start-workspace',
    }));
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 3,
    });
    orchestrator.syncFromDb('wf-lineage');

    const host = makeHost({
      persistence,
      orchestrator,
      onConsolidate: () => {
        persistence.updateTask('__merge__wf-lineage', {
          execution: {
            selectedAttemptId: 'attempt-new',
            generation: 1,
            branch: 'feature/current',
            workspacePath: '/tmp/current-workspace',
            reviewUrl: 'https://example.test/current',
          },
        });
        orchestrator.syncFromDb('wf-lineage');
      },
    });

    const response = await runMergeGate(new MergeGateExecutor(host), 'attempt-old');

    expect(response).toEqual(expect.objectContaining({
      status: 'review_ready',
      attemptId: 'attempt-old',
      executionGeneration: 0,
    }));
    expect(persistence.updateTask).not.toHaveBeenCalledWith(
      '__merge__wf-lineage',
      expect.objectContaining({
        execution: expect.objectContaining({
          branch: 'feature/live',
          workspacePath: '/tmp/gate-workspace',
        }),
      }),
    );

    const started = orchestrator.handleWorkerResponse(response);
    expect(started).toEqual([]);
    const task = orchestrator.getTask('__merge__wf-lineage')!;
    expect(task.status).toBe('running');
    expect(task.execution.selectedAttemptId).toBe('attempt-new');
    expect(task.execution.generation).toBe(1);
    expect(task.execution.branch).toBe('feature/current');
    expect(task.execution.workspacePath).toBe('/tmp/current-workspace');
    expect(task.execution.reviewUrl).toBe('https://example.test/current');
  });

  it('persists valid merge-gate review-ready metadata', async () => {
    const persistence = new InMemoryPersistence();
    persistence.saveWorkflow({
      id: 'wf-lineage',
      name: 'Lineage',
      status: 'running',
      onFinish: 'merge',
      mergeMode: 'external_review',
      baseBranch: 'main',
      featureBranch: 'feature/review',
    });
    persistence.saveTask('wf-lineage', makeMergeTask({
      selectedAttemptId: 'attempt-current',
      generation: 0,
    }));
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 3,
    });
    orchestrator.syncFromDb('wf-lineage');

    const host = makeHost({ persistence, orchestrator, mergeMode: 'external_review' });
    const response = await runMergeGate(new MergeGateExecutor(host), 'attempt-current');

    expect(response).toEqual(expect.objectContaining({
      status: 'review_ready',
      attemptId: 'attempt-current',
      outputs: expect.objectContaining({
        branch: 'feature/review',
        reviewUrl: 'https://example.test/review/1',
        reviewId: 'review-1',
        reviewStatus: 'Awaiting review',
      }),
    }));
    expect(persistence.updateTask).toHaveBeenCalledWith(
      '__merge__wf-lineage',
      {
        execution: expect.objectContaining({
          branch: 'feature/review',
          workspacePath: '/tmp/gate-workspace',
          reviewUrl: 'https://example.test/review/1',
          reviewId: 'review-1',
          reviewStatus: 'Awaiting review',
        }),
      },
    );

    orchestrator.handleWorkerResponse(response);
    const task = orchestrator.getTask('__merge__wf-lineage')!;
    expect(task.status).toBe('review_ready');
    expect(task.execution.branch).toBe('feature/review');
    expect(task.execution.workspacePath).toBe('/tmp/gate-workspace');
    expect(task.execution.reviewUrl).toBe('https://example.test/review/1');
  });

  it('does not clear fixed-integration metadata when stale publish-after-fix work reaches review-ready', async () => {
    const staleTask = makeMergeTask({
      selectedAttemptId: 'attempt-old',
      generation: 0,
      workspacePath: '/tmp/old-gate',
      fixedIntegrationSha: 'old-fix-sha',
      fixedIntegrationRecordedAt: new Date('2026-01-01T00:00:00.000Z'),
      fixedIntegrationSource: 'ai_fix',
    });
    const currentTask = makeMergeTask({
      selectedAttemptId: 'attempt-new',
      generation: 1,
      workspacePath: '/tmp/current-gate',
      fixedIntegrationSha: 'current-fix-sha',
      fixedIntegrationRecordedAt: new Date('2026-02-01T00:00:00.000Z'),
      fixedIntegrationSource: 'ai_fix',
    });
    const setTaskAwaitingApproval = vi.fn();
    const updateTask = vi.fn();
    const host: MergeRunnerHost = {
      cwd: '/repo',
      defaultBranch: 'main',
      callbacks: {},
      persistence: {
        loadWorkflow: () => ({
          id: 'wf-lineage',
          name: 'Lineage',
          status: 'running',
          onFinish: 'none',
          mergeMode: 'manual',
          baseBranch: 'main',
        }),
        getWorkspacePath: () => '/tmp/current-gate',
        updateTask,
      } as any,
      orchestrator: {
        getTask: () => currentTask,
        getAllTasks: () => [currentTask],
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval,
      } as any,
      async execGitReadonly() { return ''; },
      async execGitIn() { return ''; },
      async createMergeWorktree() { return '/tmp/current-gate'; },
      async removeMergeWorktree() {},
      async execGh() { return ''; },
      async execPr() { return ''; },
      async detectDefaultBranch() { return 'main'; },
      async gitLogMessage() { return ''; },
      async gitDiffStat() { return ''; },
      async executeTasks() {},
      async buildMergeSummary() { return '## Summary'; },
      async consolidateAndMerge() { return undefined; },
    };

    await publishAfterFixImpl(host, staleTask);

    expect(setTaskAwaitingApproval).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    expect(currentTask.execution.fixedIntegrationSha).toBe('current-fix-sha');
    expect(currentTask.execution.fixedIntegrationRecordedAt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
    expect(currentTask.execution.fixedIntegrationSource).toBe('ai_fix');
  });
});
