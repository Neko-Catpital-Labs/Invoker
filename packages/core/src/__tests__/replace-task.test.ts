import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState } from '../task-types.js';
import { validateDAG } from '../dag.js';

// ── Mocks ────────────────────────────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

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

  updateTask(taskId: string, changes: Partial<TaskState>): void {
    const entry = this.tasks.get(taskId);
    if (entry) entry.task = { ...entry.task, ...changes } as TaskState;
  }

  loadTasks(workflowId: string): TaskState[] {
    return Array.from(this.tasks.values())
      .filter((e) => e.workflowId === workflowId)
      .map((e) => e.task);
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
    status: 'failed',
    outputs: { exitCode: 1, error: `${taskId} failed` },
  });
}

function completeTask(orchestrator: Orchestrator, taskId: string): void {
  orchestrator.handleWorkerResponse({
    requestId: `req-${taskId}`,
    actionId: taskId,
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

    const started = orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix X', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('X')!.status).toBe('stale');
    expect(orchestrator.getTask('fix')).toBeDefined();
    expect(orchestrator.getTask('fix')!.dependencies).toEqual(['A']);

    expect(orchestrator.getTask('C')!.status).toBe('stale');
    const cv2 = orchestrator.getTask('C-v2');
    expect(cv2).toBeDefined();
    expect(cv2!.dependencies).toEqual(['fix']);
    expect(cv2!.status).toBe('pending');

    expect(started).toHaveLength(1);
    expect(started[0].id).toBe('fix');
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

    orchestrator.replaceTask('X', [
      { id: 's1', description: 'Step 1', command: 'echo s1' },
      { id: 's2', description: 'Step 2', command: 'echo s2', dependencies: ['s1'] },
    ]);

    expect(orchestrator.getTask('X')!.status).toBe('stale');
    expect(orchestrator.getTask('s1')!.dependencies).toEqual(['A']);
    expect(orchestrator.getTask('s2')!.dependencies).toEqual(['s1']);

    const cv2 = orchestrator.getTask('C-v2');
    expect(cv2).toBeDefined();
    expect(cv2!.dependencies).toEqual(['s2']);
  });

  it('multi-node replacement with auto-merge', () => {
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

    const merge = orchestrator.getTask('X-merge');
    expect(merge).toBeDefined();
    expect(merge!.dependencies.sort()).toEqual(['s2a', 's2b']);

    const cv2 = orchestrator.getTask('C-v2');
    expect(cv2).toBeDefined();
    expect(cv2!.dependencies).toEqual(['X-merge']);
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

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('X')!.status).toBe('stale');
    expect(orchestrator.getTask('fix')).toBeDefined();
    expect(orchestrator.getTask('fix')!.dependencies).toEqual(['A']);
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

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('fix')!.dependencies.sort()).toEqual(['A', 'B']);
  });

  it('blocked dependents are forked correctly', () => {
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

    expect(orchestrator.getTask('C')!.status).toBe('blocked');
    expect(orchestrator.getTask('D')!.status).toBe('blocked');

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('C')!.status).toBe('stale');
    expect(orchestrator.getTask('D')!.status).toBe('stale');
    expect(orchestrator.getTask('C-v2')!.status).toBe('pending');
    expect(orchestrator.getTask('C-v2')!.dependencies).toEqual(['fix']);
    expect(orchestrator.getTask('D-v2')!.status).toBe('pending');
    expect(orchestrator.getTask('D-v2')!.dependencies).toEqual(['C-v2']);
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

  it('full lifecycle: replace, complete replacement, downstream runs and completes', () => {
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
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('fix')!.status).toBe('running');

    completeTask(orchestrator, 'fix');
    expect(orchestrator.getTask('fix')!.status).toBe('completed');

    expect(orchestrator.getTask('C-v2')!.status).toBe('running');
    completeTask(orchestrator, 'C-v2');
    expect(orchestrator.getTask('C-v2')!.status).toBe('completed');

    // Workflow complete: A completed, X stale, fix completed, C stale, C-v2 completed
    const status = orchestrator.getWorkflowStatus();
    expect(status.failed).toBe(0);
    expect(status.running).toBe(0);
    expect(status.pending).toBe(0);
    expect(status.completed).toBe(3); // A, fix, C-v2
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

    const nonStaleTasks = getNonStaleTasks(orchestrator);
    const result = validateDAG(nonStaleTasks);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('replacement inherits familiarType from broken task when not specified', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'X', description: 'X', command: 'echo X', familiarType: 'worktree' },
      ],
    });
    orchestrator.startExecution();
    failTask(orchestrator, 'X');

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask('fix')!.familiarType).toBe('worktree');
  });

  it('replacement can override familiarType', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'X', description: 'X', command: 'echo X', familiarType: 'worktree' },
      ],
    });
    orchestrator.startExecution();
    failTask(orchestrator, 'X');

    orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix', command: 'echo fix', familiarType: 'docker' },
    ]);

    expect(orchestrator.getTask('fix')!.familiarType).toBe('docker');
  });
});
