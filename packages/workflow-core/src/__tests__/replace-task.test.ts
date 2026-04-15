import { describe, it, expect, beforeEach } from 'vitest';
import { sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskStateChanges, Attempt } from '../task-types.js';
import { validateDAG } from '../dag.js';

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

function failTask(orchestrator: Orchestrator, taskId: string): void {
  orchestrator.handleWorkerResponse({
    requestId: `req-${taskId}`,
    actionId: taskId,
    executionGeneration: orchestrator.getTask(taskId)?.execution.generation ?? 0,
    status: 'failed',
    outputs: { exitCode: 1, error: `${taskId} failed` },
  });
}

function completeTask(orchestrator: Orchestrator, taskId: string): void {
  orchestrator.handleWorkerResponse({
    requestId: `req-${taskId}`,
    actionId: taskId,
    executionGeneration: orchestrator.getTask(taskId)?.execution.generation ?? 0,
    status: 'completed',
    outputs: { exitCode: 0 },
  });
}

function getNonStaleTasks(orchestrator: Orchestrator): TaskState[] {
  return orchestrator.getAllTasks().filter((t) => t.status !== 'stale');
}

// ── Tests ────────────────────────────────────────────────────

describe('replaceTask', () => {
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

  it('single-node replacement in linear chain', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    const s = (l: string) => sid(orchestrator, 0, l);
    const started = orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix X', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask(s('X'))!.status).toBe('stale');
    expect(orchestrator.getTask(s('fix'))).toBeDefined();
    expect(orchestrator.getTask(s('fix'))!.dependencies).toEqual([s('A')]);

    expect(orchestrator.getTask(s('C'))!.status).toBe('stale');
    const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
    expect(mergeNode!.dependencies).toContain(s('fix'));

    expect(started).toHaveLength(1);
    expect(started[0].id).toBe(s('fix'));
    expect(started[0].status).toBe('running');
  });

  it('multi-node linear replacement', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    const s = (l: string) => sid(orchestrator, 0, l);
    orchestrator.replaceTask('X', [
      { id: 's1', description: 'Step 1', command: 'echo s1' },
      { id: 's2', description: 'Step 2', command: 'echo s2', dependencies: ['s1'] },
    ]);

    expect(orchestrator.getTask(s('X'))!.status).toBe('stale');
    expect(orchestrator.getTask(s('s1'))!.dependencies).toEqual([s('A')]);
    expect(orchestrator.getTask(s('s2'))!.dependencies).toEqual([s('s1')]);

    expect(orchestrator.getTask(s('C'))!.status).toBe('stale');
    const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
    expect(mergeNode!.dependencies).toContain(s('s2'));
  });

  it('multi-node replacement with parallel leaves wires to merge node', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    orchestrator.replaceTask('X', [
      { id: 's1', description: 'Step 1', command: 'echo s1' },
      { id: 's2a', description: 'Branch A', command: 'echo s2a', dependencies: ['s1'] },
      { id: 's2b', description: 'Branch B', command: 'echo s2b', dependencies: ['s1'] },
    ]);

    // No X-merge node; the workflow merge node's deps include both leaves
    expect(orchestrator.getTask('X-merge')).toBeUndefined();
    const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
    expect(mergeNode).toBeDefined();
    const s = (l: string) => sid(orchestrator, 0, l);
    expect(mergeNode!.dependencies).toContain(s('s2a'));
    expect(mergeNode!.dependencies).toContain(s('s2b'));

    expect(orchestrator.getTask(s('C'))!.status).toBe('stale');
  });

  it('no downstream dependents: just creates replacement', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    const s = (l: string) => sid(orchestrator, 0, l);
    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask(s('X'))!.status).toBe('stale');
    expect(orchestrator.getTask(s('fix'))).toBeDefined();
    expect(orchestrator.getTask(s('fix'))!.dependencies).toEqual([s('A')]);
  });

  it('replacement inherits multiple upstream deps', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'B', description: 'B', command: 'echo B' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A', 'B'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    completeTask(orchestrator, 'B');
    failTask(orchestrator, 'X');

    const s = (l: string) => sid(orchestrator, 0, l);
    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask(s('fix'))!.dependencies.sort()).toEqual([s('A'), s('B')]);
  });

  it('blocked dependents are stale (not forked)', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        { id: 'D', description: 'D', command: 'echo D', dependencies: ['C'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    expect(orchestrator.getTask('C')!.status).toBe('pending');
    expect(orchestrator.getTask('D')!.status).toBe('pending');

    const s = (l: string) => sid(orchestrator, 0, l);
    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask(s('C'))!.status).toBe('stale');
    expect(orchestrator.getTask(s('D'))!.status).toBe('stale');
    const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
    expect(mergeNode!.dependencies).toContain(s('fix'));
  });

  it('rejects replacing a running task', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [{ id: 'X', description: 'X', command: 'echo X' }],
    });
    orchestrator.startExecution();

    expect(() =>
      orchestrator.replaceTask('X', [{ id: 'fix', description: 'Fix', command: 'echo fix' }]),
    ).toThrow('Cannot replace running task');
  });

  it('rejects empty replacement', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [{ id: 'X', description: 'X', command: 'echo X' }],
    });
    orchestrator.startExecution();
    failTask(orchestrator, 'X');

    expect(() => orchestrator.replaceTask('X', [])).toThrow(
      'Must provide at least one replacement task',
    );
  });

  it('rejects replacing a nonexistent task', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [{ id: 'A', description: 'A', command: 'echo A' }],
    });

    expect(() =>
      orchestrator.replaceTask('Z', [{ id: 'fix', description: 'Fix', command: 'echo fix' }]),
    ).toThrow('Task Z not found');
  });

  it('full lifecycle: replace, complete replacement, merge node completes', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    const s = (l: string) => sid(orchestrator, 0, l);
    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask(s('fix'))!.status).toBe('running');

    completeTask(orchestrator, s('fix'));
    expect(orchestrator.getTask(s('fix'))!.status).toBe('completed');

    // Merge node becomes ready (C is stale=satisfied, fix is completed)
    const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
    expect(mergeNode).toBeDefined();
    expect(mergeNode!.status).toBe('running');
    completeTask(orchestrator, mergeNode!.id);

    const status = orchestrator.getWorkflowStatus();
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);
  });

  it('DAG validity after replacement', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'A', command: 'echo A' },
        { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
        { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        { id: 'D', description: 'D', command: 'echo D', dependencies: ['X'] },
      ],
    });
    orchestrator.startExecution();
    completeTask(orchestrator, 'A');
    failTask(orchestrator, 'X');

    orchestrator.replaceTask('X', [
      { id: 's1', description: 'S1', command: 'echo s1' },
      { id: 's2', description: 'S2', command: 'echo s2', dependencies: ['s1'] },
    ]);

    const s = (l: string) => sid(orchestrator, 0, l);
    expect(orchestrator.getTask(s('s1'))).toBeDefined();
    expect(orchestrator.getTask(s('s2'))).toBeDefined();

    const nonStaleTasks = getNonStaleTasks(orchestrator);
    const result = validateDAG(nonStaleTasks);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('replacement inherits executorType from broken task when not specified', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'X', description: 'X', command: 'echo X', executorType: 'worktree' },
      ],
    });
    orchestrator.startExecution();
    failTask(orchestrator, 'X');

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('fix')!.config.executorType).toBe('worktree');
  });

  it('replacement can override executorType', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'X', description: 'X', command: 'echo X', executorType: 'worktree' },
      ],
    });
    orchestrator.startExecution();
    failTask(orchestrator, 'X');

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix', executorType: 'docker' },
    ]);

    expect(orchestrator.getTask('fix')!.config.executorType).toBe('docker');
  });
});
