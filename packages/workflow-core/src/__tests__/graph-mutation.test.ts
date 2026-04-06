/**
 * Tests for the applyGraphMutation shared primitive.
 *
 * Since applyGraphMutation is private, we test it via a cast to access
 * the method directly. This validates the primitive independently of
 * the higher-level APIs (experiments, replaceTask) that use it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus, GraphMutation } from '../orchestrator.js';
import type { TaskState, TaskDelta, TaskStateChanges, Attempt } from '../task-types.js';

// ── Mocks ────────────────────────────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) wf.status = changes.status;
  }

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
    return Array.from(this.workflows.values());
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

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
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
}

class InMemoryBus implements OrchestratorMessageBus {
  published: Array<{ channel: string; message: unknown }> = [];
  publish<T>(channel: string, message: T): void {
    this.published.push({ channel, message });
  }
}

// ── Helpers ──────────────────────────────────────────────────

function completeTask(orchestrator: Orchestrator, taskId: string): void {
  orchestrator.handleWorkerResponse({
    requestId: `req-${taskId}`,
    actionId: taskId,
    status: 'completed',
    outputs: { exitCode: 0 },
  });
}

function applyMutation(orchestrator: Orchestrator, mutation: GraphMutation): TaskDelta[] {
  return (orchestrator as any).applyGraphMutation(mutation);
}

// ── Tests ────────────────────────────────────────────────────

describe('applyGraphMutation', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();
    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 10,
    });
  });

  it('complete disposition: forks downstream and completes source', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['B'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');

    const s = (l: string) => sid(orchestrator, 0, l);
    bus.published = [];

    applyMutation(orchestrator, {
      sourceNodeId: s('B'),
      sourceDisposition: 'complete',
      newNodes: [
        {
          id: s('new-node'),
          description: 'Replacement',
          dependencies: [s('B')],
          workflowId: orchestrator.getTask('B')!.config.workflowId!,
        },
      ],
      outputNodeId: s('new-node'),
    });

    expect(orchestrator.getTask(s('B'))!.status).toBe('completed');
    expect(orchestrator.getTask(s('B'))!.execution.completedAt).toBeDefined();

    expect(orchestrator.getTask(s('C'))!.status).toBe('pending');
    expect(orchestrator.getTask(s('C'))!.dependencies).toEqual([s('new-node')]);
    expect(orchestrator.getTask('C-v2')).toBeUndefined();

    expect(orchestrator.getTask(s('new-node'))).toBeDefined();
    expect(orchestrator.getTask(s('new-node'))!.status).toBe('pending');
  });

  it('stale disposition: forks downstream and stales source', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['B'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');

    const s = (l: string) => sid(orchestrator, 0, l);
    applyMutation(orchestrator, {
      sourceNodeId: s('B'),
      sourceDisposition: 'stale',
      newNodes: [
        {
          id: s('fix'),
          description: 'Fix',
          dependencies: [s('A')],
          workflowId: orchestrator.getTask('B')!.config.workflowId!,
        },
      ],
      outputNodeId: s('fix'),
    });

    expect(orchestrator.getTask(s('B'))!.status).toBe('stale');

    expect(orchestrator.getTask(s('C'))!.status).toBe('pending');
    expect(orchestrator.getTask(s('C'))!.dependencies).toEqual([s('fix')]);
    expect(orchestrator.getTask('C-v2')).toBeUndefined();

    expect(orchestrator.getTask(s('fix'))).toBeDefined();
  });

  it('new nodes are created after fork (not staled)', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');

    const s = (l: string) => sid(orchestrator, 0, l);
    const wfId = orchestrator.getTask('A')!.config.workflowId!;
    applyMutation(orchestrator, {
      sourceNodeId: s('A'),
      sourceDisposition: 'complete',
      newNodes: [
        { id: s('exp1'), description: 'Exp 1', dependencies: [s('A')], workflowId: wfId },
        { id: s('exp2'), description: 'Exp 2', dependencies: [s('A')], workflowId: wfId },
        { id: s('recon'), description: 'Recon', dependencies: [s('exp1'), s('exp2')], workflowId: wfId },
      ],
      outputNodeId: s('recon'),
    });

    expect(orchestrator.getTask(s('exp1'))!.status).toBe('pending');
    expect(orchestrator.getTask(s('exp2'))!.status).toBe('pending');
    expect(orchestrator.getTask(s('recon'))!.status).toBe('pending');

    expect(orchestrator.getTask(s('B'))!.status).toBe('running');
    expect(orchestrator.getTask(s('B'))!.dependencies).toEqual([s('recon')]);
    expect(orchestrator.getTask('B-v2')).toBeUndefined();
  });

  it('no downstream: fork is a no-op', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    completeTask(orchestrator, 'B');

    const s = (l: string) => sid(orchestrator, 0, l);
    const deltas = applyMutation(orchestrator, {
      sourceNodeId: s('B'),
      sourceDisposition: 'stale',
      newNodes: [
        {
          id: s('fix'),
          description: 'Fix',
          dependencies: [s('A')],
          workflowId: orchestrator.getTask('B')!.config.workflowId!,
        },
      ],
      outputNodeId: s('fix'),
    });

    const createdDeltas = deltas.filter((d) => d.type === 'created');
    expect(createdDeltas).toHaveLength(1);
    expect(createdDeltas[0]).toHaveProperty('task');
    expect((createdDeltas[0] as any).task.id).toBe(s('fix'));

    expect(orchestrator.getTask(s('B'))!.status).toBe('stale');
    expect(orchestrator.getTask(s('fix'))).toBeDefined();
  });

  it('emits deltas in correct order: fork, source, new nodes', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['B'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');

    bus.published = [];

    const s = (l: string) => sid(orchestrator, 0, l);
    applyMutation(orchestrator, {
      sourceNodeId: s('B'),
      sourceDisposition: 'stale',
      newNodes: [
        {
          id: s('fix'),
          description: 'Fix',
          dependencies: [s('A')],
          workflowId: orchestrator.getTask('B')!.config.workflowId!,
        },
      ],
      outputNodeId: s('fix'),
    });

    const deltas = bus.published
      .filter((p) => p.channel === 'task.delta')
      .map((p) => p.message as TaskDelta);

    const cRemap = deltas.findIndex(
      (d) => d.type === 'updated' && d.taskId === s('C') && (d.changes as any).dependencies !== undefined,
    );
    const bStale = deltas.findIndex(
      (d) => d.type === 'updated' && d.taskId === s('B') && (d.changes as any).status === 'stale',
    );
    const fixCreated = deltas.findIndex(
      (d) => d.type === 'created' && (d as any).task.id === s('fix'),
    );

    // Order: remap (C dep change) → source (B stale) → new node (fix)
    expect(cRemap).toBeGreaterThanOrEqual(0);
    expect(cRemap).toBeLessThan(bStale);
    expect(bStale).toBeLessThan(fixCreated);
  });
});
