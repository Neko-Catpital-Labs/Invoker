import { describe, expect, it, vi } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import {
  Orchestrator,
  type Attempt,
  type OrchestratorMessageBus,
  type OrchestratorPersistence,
  type TaskState,
  type TaskStateChanges,
} from '@invoker/workflow-core';
import { MergeGateExecutor } from '../merge-gate-executor.js';
import type { MergeRunnerHost } from '../merge-runner.js';

interface WorkflowRecord {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  repoUrl?: string;
  intermediateRepoUrl?: string;
  onFinish?: string;
  baseBranch?: string;
  featureBranch?: string;
  mergeMode?: 'manual' | 'automatic' | 'external_review';
}

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, WorkflowRecord>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt[]>();
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
  logEvent = vi.fn();

  saveWorkflow(workflow: WorkflowRecord): void {
    this.workflows.set(workflow.id, workflow);
  }

  updateWorkflow(workflowId: string, changes: Partial<WorkflowRecord>): void {
    const existing = this.workflows.get(workflowId);
    if (existing) this.workflows.set(workflowId, { ...existing, ...changes });
  }

  loadWorkflow(workflowId: string): WorkflowRecord | undefined {
    return this.workflows.get(workflowId);
  }

  listWorkflows(): WorkflowRecord[] {
    return Array.from(this.workflows.values());
  }

  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((entry) => entry.workflowId === workflowId)
      .map((entry) => entry.task);
  }

  saveAttempt(attempt: Attempt): void {
    const attempts = this.attempts.get(attempt.nodeId) ?? [];
    attempts.push(attempt);
    this.attempts.set(attempt.nodeId, attempts);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return this.attempts.get(nodeId) ?? [];
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    for (const attempts of this.attempts.values()) {
      const found = attempts.find((attempt) => attempt.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }

  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    for (const attempts of this.attempts.values()) {
      const index = attempts.findIndex((attempt) => attempt.id === attemptId);
      if (index >= 0) {
        attempts[index] = { ...attempts[index], ...changes } as Attempt;
        return;
      }
    }
  }

  getWorkspacePath(taskId: string): string | null {
    return this.tasks.get(taskId)?.task.execution.workspacePath ?? null;
  }
}

class InMemoryBus implements OrchestratorMessageBus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

function taskIdBySuffix(orchestrator: Orchestrator, suffix: string): string {
  const task = orchestrator.getAllTasks().find((item) => item.id.endsWith(`/${suffix}`));
  if (!task) throw new Error(`Task with suffix "${suffix}" not found`);
  return task.id;
}

function makeOrchestrator(): { orchestrator: Orchestrator; persistence: InMemoryPersistence } {
  const persistence = new InMemoryPersistence();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    deferRunningUntilLaunch: true,
  });
  orchestrator.loadPlan({
    name: 'merge-gate-lineage',
    onFinish: 'pull_request',
    baseBranch: 'master',
    featureBranch: 'feature/wf',
    mergeMode: 'manual',
    tasks: [{ id: 'merge', description: 'Merge gate', command: 'echo merge' }],
  });
  return { orchestrator, persistence };
}

function makeHost(
  orchestrator: Orchestrator,
  persistence: InMemoryPersistence,
  consolidateAndMerge: MergeRunnerHost['consolidateAndMerge'],
): MergeRunnerHost {
  return {
    orchestrator,
    persistence: persistence as any,
    defaultBranch: 'master',
    callbacks: {},
    cwd: '/repo',
    createMergeWorktree: vi.fn(async () => '/tmp/gate-clone'),
    removeMergeWorktree: vi.fn(async () => {}),
    execGitReadonly: vi.fn(async () => ''),
    execGitIn: vi.fn(async () => ''),
    execGh: vi.fn(async () => ''),
    execPr: vi.fn(async () => 'https://example.test/pr/1'),
    detectDefaultBranch: vi.fn(async () => 'master'),
    gitLogMessage: vi.fn(async () => ''),
    gitDiffStat: vi.fn(async () => ''),
    executeTasks: vi.fn(async () => {}),
    buildMergeSummary: vi.fn(async () => 'merge summary'),
    consolidateAndMerge,
  };
}

async function startMergeGate(
  executor: MergeGateExecutor,
  task: TaskState,
): Promise<WorkResponse> {
  const request: WorkRequest = {
    requestId: `req-${task.id}`,
    actionId: task.id,
    actionType: 'command',
    attemptId: task.execution.selectedAttemptId,
    executionGeneration: task.execution.generation ?? 0,
    inputs: {},
    callbackUrl: 'http://localhost/callback',
  };
  const handle = await executor.start(request);
  return await new Promise<WorkResponse>((resolve) => {
    executor.onComplete(handle, resolve);
  });
}

describe('MergeGateExecutor lineage guard', () => {
  it('does not write direct execution metadata when merge-gate work becomes stale before completion', async () => {
    const { orchestrator, persistence } = makeOrchestrator();
    const taskId = taskIdBySuffix(orchestrator, 'merge');
    const [claim] = orchestrator.startExecution();
    const staleAttemptId = claim!.execution.selectedAttemptId!;
    const staleGeneration = claim!.execution.generation ?? 0;
    expect(orchestrator.markTaskRunningAfterLaunch(taskId, staleAttemptId)).toBe(true);

    let replacementAttemptId: string | undefined;
    const host = makeHost(orchestrator, persistence, vi.fn(async () => {
      const [replacement] = orchestrator.recreateTask(taskId);
      replacementAttemptId = replacement!.execution.selectedAttemptId;
      return undefined;
    }));
    const executor = new MergeGateExecutor(host);

    const response = await startMergeGate(executor, claim!);

    expect(response).toMatchObject({
      actionId: taskId,
      attemptId: staleAttemptId,
      executionGeneration: staleGeneration,
      status: 'review_ready',
    });
    expect(persistence.updateTask).not.toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        execution: expect.objectContaining({
          branch: 'feature/wf',
          workspacePath: '/tmp/gate-clone',
        }),
      }),
    );
    expect(persistence.logEvent).toHaveBeenCalledWith(
      taskId,
      'merge-gate.stale-side-effect-skipped',
      expect.objectContaining({ tag: 'executor-merge-metadata' }),
    );

    const staleResult = orchestrator.handleWorkerResponse(response);
    expect(staleResult).toEqual([]);
    expect(orchestrator.getTask(taskId)?.execution.selectedAttemptId).toBe(replacementAttemptId);
    expect(orchestrator.getTask(taskId)?.status).toBe('pending');
  });

  it('persists valid merge-gate review-ready execution metadata', async () => {
    const { orchestrator, persistence } = makeOrchestrator();
    const taskId = taskIdBySuffix(orchestrator, 'merge');
    const [claim] = orchestrator.startExecution();
    expect(orchestrator.markTaskRunningAfterLaunch(taskId, claim!.execution.selectedAttemptId!)).toBe(true);

    const host = makeHost(orchestrator, persistence, vi.fn(async () => undefined));
    const executor = new MergeGateExecutor(host);

    const response = await startMergeGate(executor, claim!);

    expect(response.status).toBe('review_ready');
    expect(persistence.updateTask).toHaveBeenCalledWith(taskId, {
      execution: expect.objectContaining({
        branch: 'feature/wf',
        workspacePath: '/tmp/gate-clone',
      }),
    });
  });
});
