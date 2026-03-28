/**
 * Tests for the applyGraphMutation shared primitive.
 *
 * Since applyGraphMutation is private, we test it via a cast to access
 * the method directly. This validates the primitive independently of
 * the higher-level APIs (experiments, replaceTask) that use it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus, GraphMutation } from '../orchestrator.js';
import type { TaskState, TaskDelta, TaskStateChanges } from '../task-types.js';

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

  updateAttempt(attemptId: string, changes: Partial<Pick<Attempt, 'status' | 'startedAt' | 'completedAt' | 'exitCode' | 'error' | 'lastHeartbeatAt' | 'branch' | 'commit' | 'summary' | 'workspacePath' | 'claudeSessionId' | 'containerId' | 'mergeConflict'>>): void {
    for (const list of self.attempts.values()) {
      const idx = list.findIndex(a => a.id === attemptId);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...changes } as Attempt;
        return;
      }
    }
  }

  getNextAttemptNumber(nodeId: string): number {
    const list = this.attempts.get(nodeId) ?? [];
    return list.length + 1;
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

    bus.published = [];

    applyMutation(orchestrator, {
      sourceNodeId: 'B',
      sourceDisposition: 'complete',
      newNodes: [
        { id: 'new-node', description: 'Replacement', dependencies: ['B'], workflowId: orchestrator.getTask('B')!.config.workflowId },
      ],
      outputNodeId: 'new-node',
    });

    expect(orchestrator.getTask('B')!.status).toBe('completed');
    expect(orchestrator.getTask('B')!.execution.completedAt).toBeDefined();

    // C is remapped in-place: dependencies changed from ['B'] to ['new-node'], no stale, no clone
    expect(orchestrator.getTask('C')!.status).toBe('pending');
    expect(orchestrator.getTask('C')!.dependencies).toEqual(['new-node']);
    expect(orchestrator.getTask('C-v2')).toBeUndefined();

    expect(orchestrator.getTask('new-node')).toBeDefined();
    expect(orchestrator.getTask('new-node')!.status).toBe('pending');
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

    applyMutation(orchestrator, {
      sourceNodeId: 'B',
      sourceDisposition: 'stale',
      newNodes: [
        { id: 'fix', description: 'Fix', dependencies: ['A'], workflowId: orchestrator.getTask('B')!.config.workflowId },
      ],
      outputNodeId: 'fix',
    });

    expect(orchestrator.getTask('B')!.status).toBe('stale');

    // C is remapped in-place: dependencies changed from ['B'] to ['fix'], no stale, no clone
    expect(orchestrator.getTask('C')!.status).toBe('pending');
    expect(orchestrator.getTask('C')!.dependencies).toEqual(['fix']);
    expect(orchestrator.getTask('C-v2')).toBeUndefined();

    expect(orchestrator.getTask('fix')).toBeDefined();
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

    applyMutation(orchestrator, {
      sourceNodeId: 'A',
      sourceDisposition: 'complete',
      newNodes: [
        { id: 'exp1', description: 'Exp 1', dependencies: ['A'], workflowId: orchestrator.getTask('A')!.config.workflowId },
        { id: 'exp2', description: 'Exp 2', dependencies: ['A'], workflowId: orchestrator.getTask('A')!.config.workflowId },
        { id: 'recon', description: 'Recon', dependencies: ['exp1', 'exp2'], workflowId: orchestrator.getTask('A')!.config.workflowId },
      ],
      outputNodeId: 'recon',
    });

    // New nodes should NOT be stale
    expect(orchestrator.getTask('exp1')!.status).toBe('pending');
    expect(orchestrator.getTask('exp2')!.status).toBe('pending');
    expect(orchestrator.getTask('recon')!.status).toBe('pending');

    // Original downstream remapped in-place: dependencies changed from ['A'] to ['recon']
    // B was already running (auto-started after A completed), remap doesn't change status
    expect(orchestrator.getTask('B')!.status).toBe('running');
    expect(orchestrator.getTask('B')!.dependencies).toEqual(['recon']);
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

    const deltas = applyMutation(orchestrator, {
      sourceNodeId: 'B',
      sourceDisposition: 'stale',
      newNodes: [
        { id: 'fix', description: 'Fix', dependencies: ['A'], workflowId: orchestrator.getTask('B')!.config.workflowId },
      ],
      outputNodeId: 'fix',
    });

    // No downstream to remap, only the new 'fix' node is created
    const createdDeltas = deltas.filter((d) => d.type === 'created');
    expect(createdDeltas).toHaveLength(1);
    expect(createdDeltas[0]).toHaveProperty('task');
    expect((createdDeltas[0] as any).task.id).toBe('fix');

    expect(orchestrator.getTask('B')!.status).toBe('stale');
    expect(orchestrator.getTask('fix')).toBeDefined();
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

    applyMutation(orchestrator, {
      sourceNodeId: 'B',
      sourceDisposition: 'stale',
      newNodes: [
        { id: 'fix', description: 'Fix', dependencies: ['A'], workflowId: orchestrator.getTask('B')!.config.workflowId },
      ],
      outputNodeId: 'fix',
    });

    const deltas = bus.published
      .filter((p) => p.channel === 'task.delta')
      .map((p) => p.message as TaskDelta);

    // Remap deltas first: C dependencies updated from ['B'] to ['fix']
    const cRemap = deltas.findIndex(
      (d) => d.type === 'updated' && d.taskId === 'C' && (d.changes as any).dependencies !== undefined,
    );
    // Source disposition
    const bStale = deltas.findIndex(
      (d) => d.type === 'updated' && d.taskId === 'B' && (d.changes as any).status === 'stale',
    );
    // New node creation
    const fixCreated = deltas.findIndex(
      (d) => d.type === 'created' && (d as any).task.id === 'fix',
    );

    // Order: remap (C dep change) → source (B stale) → new node (fix)
    expect(cRemap).toBeGreaterThanOrEqual(0);
    expect(cRemap).toBeLessThan(bStale);
    expect(bStale).toBeLessThan(fixCreated);
  });
});
