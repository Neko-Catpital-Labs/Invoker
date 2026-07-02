import { expect } from 'vitest';
import {
  Orchestrator,
  type OrchestratorPersistence,
  type OrchestratorMessageBus,
} from '../../orchestrator.js';
import { computeWorkflowRollup, type TaskState, type TaskStateChanges, type Attempt } from '../../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

export class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
  }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: {
    id: string;
    name: string;
    repoUrl?: string;
    baseBranch?: string;
    featureBranch?: string;
    mergeMode?: 'manual' | 'automatic' | 'external_review';
  }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, {
      ...workflow,
      status: 'pending',
      repoUrl: workflow.repoUrl ?? 'memory://test-repo',
      createdAt: (workflow as { createdAt?: string }).createdAt ?? now,
      updatedAt: (workflow as { updatedAt?: string }).updatedAt ?? now,
    });
  }
  updateWorkflow(): void {}
  loadWorkflow(workflowId: string): { repoUrl?: string; baseBranch?: string; featureBranch?: string } | undefined {
    const wf = this.workflows.get(workflowId);
    return wf
      ? { repoUrl: wf.repoUrl, baseBranch: wf.baseBranch, featureBranch: wf.featureBranch }
      : undefined;
  }
  saveTask(workflowId: string, task: TaskState): void {
    this.tasks.set(task.id, { workflowId, task });
  }
  getTaskEntry(taskId: string): { workflowId: string; task: TaskState } | undefined {
    return this.tasks.get(taskId);
  }
  updateTask(taskId: string, changes: TaskStateChanges): void {
    const entry = this.tasks.get(taskId);
    if (!entry) return;
    entry.task = {
      ...entry.task,
      ...(changes.status !== undefined ? { status: changes.status } : {}),
      ...(changes.dependencies !== undefined ? { dependencies: changes.dependencies } : {}),
      config: { ...entry.task.config, ...changes.config },
      execution: { ...entry.task.execution, ...changes.execution },
    } as TaskState;
  }
  listWorkflows() { return Array.from(this.workflows.values()).map((workflow) => ({ ...workflow, status: computeWorkflowRollup(this.loadTasks(workflow.id)).status })); }
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
  loadAttempts(nodeId: string): Attempt[] { return this.attempts.get(nodeId) ?? []; }
  loadAttempt(attemptId: string): Attempt | undefined {
    for (const list of this.attempts.values()) {
      const found = list.find((a) => a.id === attemptId);
      if (found) return found;
    }
    return undefined;
  }
  updateAttempt(
    attemptId: string,
    changes: Partial<Pick<Attempt,
      | 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error'
      | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary'
      | 'workspacePath' | 'agentSessionId' | 'containerId' | 'mergeConflict'>>,
  ): void {
    for (const list of this.attempts.values()) {
      const idx = list.findIndex((a) => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }
  deleteWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    for (const [id, entry] of this.tasks) {
      if (entry.workflowId === workflowId) this.tasks.delete(id);
    }
  }
  deleteAllWorkflows(): void { this.workflows.clear(); this.tasks.clear(); }
}

export class InMemoryBus implements OrchestratorMessageBus {
  publish<T>(_channel: string, _message: T): void {}
  subscribe(_channel: string, _handler: (msg: unknown) => void): () => void {
    return () => undefined;
  }
}

export function makeOrchestrator(persistence: OrchestratorPersistence): Orchestrator {
  return new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 8,
  });
}

export function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 't1',
    executionGeneration: 0,
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

export interface ChainContext {
  upstreamWfId: string;
  upstreamTaskId: string;
  upstreamMergeId: string;
  downstreamWfId: string;
  downstreamRootId: string;
  downstreamMidId: string;
  downstreamLastId: string;
  downstreamMergeId: string;
}

/**
 * Drive a chain of two workflows so the downstream first task has cleared the
 * external merge-gate dependency, runs to completion locally, and a downstream
 * later task is currently `running`.
 */
export function setupChain(orchestrator: Orchestrator): ChainContext {
  orchestrator.loadPlan({
    name: 'upstream-workflow',
    baseBranch: 'master',
    featureBranch: 'feature/upstream',
    tasks: [{ id: 'verify-upstream', description: 'upstream prerequisite' }],
  });
  const upstreamTaskId = orchestrator.getAllTasks().find(
    (t) => !t.config.isMergeNode && t.id.endsWith('/verify-upstream'),
  )!.id;
  const upstreamWfId = upstreamTaskId.split('/')[0]!;
  const upstreamMergeId = `__merge__${upstreamWfId}`;

  orchestrator.loadPlan({
    name: 'downstream-workflow',
    baseBranch: 'feature/upstream',
    featureBranch: 'feature/downstream',
    tasks: [
      {
        id: 'root',
        description: 'downstream root waits for upstream merge gate',
        externalDependencies: [{ workflowId: upstreamWfId, gatePolicy: 'completed' }],
      },
      {
        id: 'mid',
        description: 'downstream mid depends on root',
        dependencies: ['root'],
      },
      {
        id: 'last',
        description: 'downstream last depends on mid',
        dependencies: ['mid'],
      },
    ],
  });

  const downstreamRootId = orchestrator.getAllTasks().find(
    (t) => t.id.endsWith('/root'),
  )!.id;
  const downstreamWfId = downstreamRootId.split('/')[0]!;
  const downstreamMidId = `${downstreamWfId}/mid`;
  const downstreamLastId = `${downstreamWfId}/last`;
  const downstreamMergeId = `__merge__${downstreamWfId}`;

  orchestrator.startExecution();
  orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamTaskId, status: 'completed' }));
  orchestrator.handleWorkerResponse(makeResponse({ actionId: upstreamMergeId, status: 'completed' }));

  expect(orchestrator.getTask(downstreamRootId)!.status).toBe('running');

  orchestrator.handleWorkerResponse(makeResponse({ actionId: downstreamRootId, status: 'completed' }));
  orchestrator.handleWorkerResponse(makeResponse({ actionId: downstreamMidId, status: 'completed' }));

  expect(orchestrator.getTask(downstreamLastId)!.status).toBe('running');
  expect(orchestrator.getTask(downstreamMergeId)!.status).toBe('pending');

  return {
    upstreamWfId,
    upstreamTaskId,
    upstreamMergeId,
    downstreamWfId,
    downstreamRootId,
    downstreamMidId,
    downstreamLastId,
    downstreamMergeId,
  };
}
