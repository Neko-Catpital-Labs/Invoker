import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskStateChanges, Attempt } from '../task-types.js';

// ── In-Memory Persistence with Attempt Support ──────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, any>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  attempts = new Map<string, Attempt>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: now, updatedAt: now });
  }

  updateWorkflow(workflowId: string, changes: Record<string, unknown>): void {
    const wf = this.workflows.get(workflowId);
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

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
  }

  logEvent(taskId: string, eventType: string, payload?: unknown): void {
    this.events.push({ taskId, eventType, payload });
  }

  saveAttempt(attempt: Attempt): void {
    this.attempts.set(attempt.id, attempt);
  }

  loadAttempts(nodeId: string): Attempt[] {
    return Array.from(this.attempts.values())
      .filter((a) => a.nodeId === nodeId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  loadAttempt(attemptId: string): Attempt | undefined {
    return this.attempts.get(attemptId);
  }

  updateAttempt(attemptId: string, changes: Partial<Attempt>): void {
    const a = this.attempts.get(attemptId);
    if (a) {
      this.attempts.set(attemptId, { ...a, ...changes } as Attempt);
    }
  }

  getNextAttemptNumber(nodeId: string): number {
    const existing = this.loadAttempts(nodeId);
    return existing.length > 0 ? existing[existing.length - 1].attemptNumber + 1 : 1;
  }
}

class InMemoryBus implements OrchestratorMessageBus {
  published: Array<{ channel: string; message: unknown }> = [];
  publish<T>(channel: string, message: T): void {
    this.published.push({ channel, message });
  }
  subscribe(): () => void {
    return () => {};
  }
}

// ── Helpers ─────────────────────────────────────────────────

function createPlan(tasks: PlanDefinition['tasks']): PlanDefinition {
  return {
    name: 'test-plan',
    tasks,
    baseBranch: 'main',
  };
}

function completeTask(
  orchestrator: Orchestrator,
  persistence: InMemoryPersistence,
  taskId: string,
  extra?: { branch?: string; commit?: string },
) {
  // Branch is normally set by the executor before completion, not via the response.
  // Simulate that by updating persistence directly.
  if (extra?.branch) {
    persistence.updateTask(taskId, { execution: { branch: extra.branch } });
  }
  return orchestrator.handleWorkerResponse({
    requestId: `req-${taskId}`,
    actionId: taskId,
    status: 'completed',
    outputs: {
      exitCode: 0,
      ...(extra?.commit ? { commitHash: extra.commit } : {}),
    },
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('notifyBranchUpdated', () => {
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();
    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 3,
    });
  });

  it('throws if task is not found', () => {
    expect(() => orchestrator.notifyBranchUpdated('nonexistent')).toThrow('not found');
  });

  it('throws if task is not completed', () => {
    orchestrator.loadPlan(createPlan([
      { id: 'A', description: 'A', command: 'echo A', dependencies: [] },
    ]));
    expect(() => orchestrator.notifyBranchUpdated('A')).toThrow('not completed');
  });

  it('creates a new attempt and selects it for the updated task', () => {
    orchestrator.loadPlan(createPlan([
      { id: 'A', description: 'A', command: 'echo A', dependencies: [] },
    ]));

    // Start and complete task A
    orchestrator.startExecution();
    completeTask(orchestrator, persistence, 'A', { branch: 'experiment/A-abc', commit: 'old-sha' });

    const taskBefore = orchestrator.getTask('A')!;
    expect(taskBefore.status).toBe('completed');
    const oldSelectedId = taskBefore.execution.selectedAttemptId;
    expect(oldSelectedId).toBeDefined();

    // Notify branch updated
    orchestrator.notifyBranchUpdated('A', { commit: 'new-sha' });

    const taskAfter = orchestrator.getTask('A')!;
    expect(taskAfter.status).toBe('completed');
    expect(taskAfter.execution.selectedAttemptId).not.toBe(oldSelectedId);
    expect(taskAfter.execution.commit).toBe('new-sha');

    // Old attempt should be superseded
    const oldAttempt = persistence.loadAttempt(oldSelectedId!);
    expect(oldAttempt?.status).toBe('superseded');

    // New attempt should be completed
    const newAttempt = persistence.loadAttempt(taskAfter.execution.selectedAttemptId!);
    expect(newAttempt?.status).toBe('completed');
    expect(newAttempt?.commit).toBe('new-sha');
    expect(newAttempt?.branch).toBe('experiment/A-abc');
  });

  it('marks downstream completed tasks as stale via attempt lineage', () => {
    orchestrator.loadPlan(createPlan([
      { id: 'A', description: 'A', command: 'echo A', dependencies: [] },
      { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
      { id: 'C', description: 'C', command: 'echo C', dependencies: ['B'] },
    ]));

    // Run A → B → C to completion
    orchestrator.startExecution();
    completeTask(orchestrator, persistence, 'A', { branch: 'experiment/A-abc', commit: 'sha-a1' });
    completeTask(orchestrator, persistence, 'B', { branch: 'experiment/B-def', commit: 'sha-b1' });
    completeTask(orchestrator, persistence, 'C', { branch: 'experiment/C-ghi', commit: 'sha-c1' });

    expect(orchestrator.getTask('A')!.status).toBe('completed');
    expect(orchestrator.getTask('B')!.status).toBe('completed');
    expect(orchestrator.getTask('C')!.status).toBe('completed');

    // Notify that A's branch was externally updated
    const staled = orchestrator.notifyBranchUpdated('A', { commit: 'sha-a2' });

    // B should be stale (direct dependent, its attempt references A's old attempt)
    expect(orchestrator.getTask('B')!.status).toBe('stale');
    // C should also be stale (transitive dependent, its attempt references B's old attempt
    // which itself references A's old attempt; but the derivation only checks direct deps
    // against the currently selected attempt)
    expect(orchestrator.getTask('C')!.status).toBe('stale');
    expect(staled).toContain('B');
    expect(staled).toContain('C');

    // A itself should still be completed
    expect(orchestrator.getTask('A')!.status).toBe('completed');
  });

  it('does not mark tasks without attempt lineage as stale (backward compat)', () => {
    orchestrator.loadPlan(createPlan([
      { id: 'A', description: 'A', command: 'echo A', dependencies: [] },
      { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
    ]));

    // Start and complete A
    orchestrator.startExecution();
    completeTask(orchestrator, persistence, 'A', { branch: 'experiment/A-abc', commit: 'sha-a1' });

    // Manually create B's attempt WITHOUT upstreamAttemptIds (simulating old behavior)
    completeTask(orchestrator, persistence, 'B', { branch: 'experiment/B-def', commit: 'sha-b1' });

    // Clear B's attempt upstreamAttemptIds to simulate pre-lineage attempt
    const bTask = orchestrator.getTask('B')!;
    const bAttemptId = bTask.execution.selectedAttemptId!;
    const bAttempt = persistence.loadAttempt(bAttemptId)!;
    persistence.attempts.set(bAttemptId, { ...bAttempt, upstreamAttemptIds: [] });

    // Notify A's branch updated
    const staled = orchestrator.notifyBranchUpdated('A', { commit: 'sha-a2' });

    // B should NOT be stale because its attempt has empty lineage (backward compat guard)
    expect(orchestrator.getTask('B')!.status).toBe('completed');
    expect(staled).not.toContain('B');
  });

  it('populates upstreamAttemptIds when starting tasks', () => {
    orchestrator.loadPlan(createPlan([
      { id: 'A', description: 'A', command: 'echo A', dependencies: [] },
      { id: 'B', description: 'B', command: 'echo B', dependencies: ['A'] },
    ]));

    // Start A, complete it
    orchestrator.startExecution();
    completeTask(orchestrator, persistence, 'A', { branch: 'experiment/A-abc', commit: 'sha-a1' });

    // B should now be running — check its attempt has upstreamAttemptIds
    const bTask = orchestrator.getTask('B')!;
    expect(bTask.status).toBe('running');

    const bAttempts = persistence.loadAttempts('B');
    const runningAttempt = bAttempts.find(a => a.status === 'running');
    expect(runningAttempt).toBeDefined();

    const aSelectedId = orchestrator.getTask('A')!.execution.selectedAttemptId;
    expect(runningAttempt!.upstreamAttemptIds).toContain(aSelectedId);
  });

  it('logs branch_updated event', () => {
    orchestrator.loadPlan(createPlan([
      { id: 'A', description: 'A', command: 'echo A', dependencies: [] },
    ]));
    orchestrator.startExecution();
    completeTask(orchestrator, persistence, 'A', { branch: 'experiment/A-abc', commit: 'sha-a1' });

    orchestrator.notifyBranchUpdated('A', { commit: 'sha-a2' });

    const branchEvents = persistence.events.filter(e => e.eventType === 'task.branch_updated');
    expect(branchEvents.length).toBe(1);
    expect(branchEvents[0].taskId).toBe('A');
  });
});
