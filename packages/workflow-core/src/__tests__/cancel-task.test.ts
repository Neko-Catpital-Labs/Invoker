import { describe, it, expect, beforeEach } from 'vitest';
import { sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta, TaskStateChanges , Attempt} from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();
  events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: (workflow as any).createdAt ?? now, updatedAt: (workflow as any).updatedAt ?? now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string; updatedAt?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) {
      wf.status = changes.status;
    }
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

  listWorkflows(): Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }> {
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

// ── Helpers ─────────────────────────────────────────────────

function simplePlan(): PlanDefinition {
  return {
    name: 'test-cancel',
    tasks: [
      { id: 'a', description: 'Task A', command: 'echo a', dependencies: [] },
      { id: 'b', description: 'Task B', command: 'echo b', dependencies: ['a'] },
      { id: 'c', description: 'Task C', command: 'echo c', dependencies: ['b'] },
    ],
  };
}

function makeResponse(overrides: Partial<WorkResponse>): WorkResponse {
  return {
    requestId: 'req-1',
    actionId: 'a',
    status: 'completed',
    outputs: { exitCode: 0 },
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('cancelTask', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;
  let publishedDeltas: TaskDelta[];

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();
    publishedDeltas = [];

    bus.subscribe('task.delta', (delta) => {
      publishedDeltas.push(delta as TaskDelta);
    });

    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 3,
    });
  });

  it('cancels a pending task and marks it failed', () => {
    orchestrator.loadPlan(simplePlan());
    // 'a' has no deps, so it's pending (ready) before startExecution
    const taskBefore = orchestrator.getTask('a');
    expect(taskBefore!.status).toBe('pending');

    orchestrator.cancelTask('a');

    const task = orchestrator.getTask('a');
    expect(task!.status).toBe('failed');
    expect(task!.execution.error).toContain('Cancelled by user');
  });

  it('cascades cancel to pending dependents', () => {
    orchestrator.loadPlan(simplePlan());

    orchestrator.cancelTask('a');

    const taskB = orchestrator.getTask('b');
    const taskC = orchestrator.getTask('c');
    expect(taskB!.status).toBe('failed');
    expect(taskC!.status).toBe('failed');
    expect(taskB!.execution.error).toContain('upstream task "a"');
    expect(taskC!.execution.error).toContain('upstream task "a"');
  });

  it('returns running tasks in runningCancelled', () => {
    orchestrator.loadPlan(simplePlan());
    // startExecution makes 'a' running (it has no deps)
    orchestrator.startExecution();
    expect(orchestrator.getTask('a')!.status).toBe('running');

    publishedDeltas = [];
    const result = orchestrator.cancelTask('a');

    expect(result.runningCancelled).toContain(sid(orchestrator, 0, 'a'));
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'a'));
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'b'));
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'c'));
  });

  it('throws when cancelling a completed task', () => {
    orchestrator.loadPlan(simplePlan());
    orchestrator.startExecution();

    // Complete task 'a' via handleWorkerResponse
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'a', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator.getTask('a')!.status).toBe('completed');

    expect(() => orchestrator.cancelTask('a')).toThrow('already completed');
  });

  it('skips completed dependents during cascade', () => {
    // Plan: A -> B (parallel with C), D depends on B and C
    orchestrator.loadPlan({
      name: 'test-skip-completed',
      tasks: [
        { id: 'a', description: 'Task A', command: 'echo a', dependencies: [] },
        { id: 'b', description: 'Task B', command: 'echo b', dependencies: ['a'] },
        { id: 'c', description: 'Task C', command: 'echo c', dependencies: ['a'] },
        { id: 'd', description: 'Task D', command: 'echo d', dependencies: ['b', 'c'] },
      ],
    });

    // Start and complete A, then B starts
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'a', status: 'completed', outputs: { exitCode: 0 } }),
    );
    // Now B and C should be running
    expect(orchestrator.getTask('b')!.status).toBe('running');
    expect(orchestrator.getTask('c')!.status).toBe('running');

    // Complete B
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'b', status: 'completed', outputs: { exitCode: 0 } }),
    );
    expect(orchestrator.getTask('b')!.status).toBe('completed');

    // Now cancel C — B should stay completed, D should be cancelled
    const result = orchestrator.cancelTask('c');

    expect(orchestrator.getTask('b')!.status).toBe('completed');
    expect(orchestrator.getTask('c')!.status).toBe('failed');
    expect(orchestrator.getTask('d')!.status).toBe('failed');
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'c'));
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'd'));
    expect(result.cancelled).not.toContain(sid(orchestrator, 0, 'b'));
  });

  it('publishes deltas for each cancelled task', () => {
    orchestrator.loadPlan(simplePlan());

    publishedDeltas = [];
    orchestrator.cancelTask('a');

    const sa = sid(orchestrator, 0, 'a');
    const sb = sid(orchestrator, 0, 'b');
    const sc = sid(orchestrator, 0, 'c');

    const cancelDeltas = publishedDeltas
      .filter((d): d is Extract<TaskDelta, { type: 'updated' }> => d.type === 'updated')
      .filter((d) => d.taskId === sa || d.taskId === sb || d.taskId === sc);
    expect(cancelDeltas).toHaveLength(3);

    const deltaIds = cancelDeltas.map((d) => d.taskId);
    expect(deltaIds).toContain(sa);
    expect(deltaIds).toContain(sb);
    expect(deltaIds).toContain(sc);
  });
});

describe('cancelWorkflow', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();

    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 3,
    });
  });

  it('cancels active tasks but keeps completed tasks unchanged', () => {
    orchestrator.loadPlan(simplePlan());
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse(
      makeResponse({ actionId: 'a', status: 'completed', outputs: { exitCode: 0 } }),
    );
    const wfId = orchestrator.getTask('a')!.config.workflowId!;

    const result = orchestrator.cancelWorkflow(wfId);

    expect(orchestrator.getTask('a')!.status).toBe('completed');
    expect(orchestrator.getTask('b')!.status).toBe('failed');
    expect(orchestrator.getTask('c')!.status).toBe('failed');
    expect(result.cancelled).not.toContain(sid(orchestrator, 0, 'a'));
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'b'));
    expect(result.cancelled).toContain(sid(orchestrator, 0, 'c'));
  });

  it('returns running tasks in runningCancelled', () => {
    orchestrator.loadPlan(simplePlan());
    orchestrator.startExecution();
    const wfId = orchestrator.getTask('a')!.config.workflowId!;

    const result = orchestrator.cancelWorkflow(wfId);

    expect(result.runningCancelled).toContain(sid(orchestrator, 0, 'a'));
    expect(orchestrator.getTask('a')!.execution.error).toBe('Cancelled by user (workflow)');
  });

  it('throws for unknown workflow id', () => {
    orchestrator.loadPlan(simplePlan());
    expect(() => orchestrator.cancelWorkflow('wf-missing')).toThrow('No tasks found for workflow wf-missing');
  });

  it('marks workflow failed after cancellation settles', () => {
    orchestrator.loadPlan(simplePlan());
    const wfId = orchestrator.getTask('a')!.config.workflowId!;
    orchestrator.cancelWorkflow(wfId);
    expect(persistence.workflows.get(wfId)?.status).toBe('failed');
  });
});

describe('getQueueStatus', () => {
  let orchestrator: Orchestrator;
  let persistence: InMemoryPersistence;
  let bus: InMemoryBus;

  beforeEach(() => {
    persistence = new InMemoryPersistence();
    bus = new InMemoryBus();

    orchestrator = new Orchestrator({
      persistence,
      messageBus: bus,
      maxConcurrency: 3,
    });
  });

  it('returns empty status when no tasks loaded', () => {
    const status = orchestrator.getQueueStatus();
    expect(status.running).toEqual([]);
    expect(status.queued).toEqual([]);
  });

  it('returns correct running and queued data after startExecution', () => {
    orchestrator.loadPlan(simplePlan());
    orchestrator.startExecution();

    const status = orchestrator.getQueueStatus();

    // Task 'a' should be running (no deps), 'b' and 'c' are blocked
    expect(status.running.length).toBeGreaterThanOrEqual(1);
    const runningA = status.running.find((r) => r.taskId === sid(orchestrator, 0, 'a'));
    expect(runningA).toBeDefined();
    expect(runningA!.description).toBe('Task A');

    expect(typeof status.maxConcurrency).toBe('number');
    expect(typeof status.runningCount).toBe('number');
  });
});
