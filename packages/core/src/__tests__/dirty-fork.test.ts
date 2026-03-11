import { describe, it, expect, beforeEach } from 'vitest';
import { nextVersion } from '../dag.js';
import { Orchestrator } from '../orchestrator.js';
import type { OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskDelta } from '../task-types.js';

// ── Mocks ────────────────────────────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  saveWorkflow(): void {}
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

// ── nextVersion ──────────────────────────────────────────────

describe('nextVersion', () => {
  it('appends -v2 to unversioned ID', () => {
    expect(nextVersion('test-feature')).toBe('test-feature-v2');
  });

  it('increments v2 to v3', () => {
    expect(nextVersion('test-feature-v2')).toBe('test-feature-v3');
  });

  it('increments v10 to v11', () => {
    expect(nextVersion('test-feature-v10')).toBe('test-feature-v11');
  });

  it('handles dashed IDs correctly', () => {
    expect(nextVersion('task-with-dashes')).toBe('task-with-dashes-v2');
  });
});

// ── forkDirtySubtree ────────────────────────────────────────

describe('forkDirtySubtree', () => {
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

  function loadAndCompleteChain(plan: { id: string; deps?: string[] }[]): void {
    orchestrator.loadPlan({
      name: 'test',
      tasks: plan.map(t => ({
        id: t.id,
        description: `Task ${t.id}`,
        command: `echo ${t.id}`,
        dependencies: t.deps ?? [],
      })),
    });

    const completed = new Set<string>();
    const remaining = [...plan];
    while (remaining.length > 0) {
      const ready = remaining.filter(t =>
        (t.deps ?? []).every(d => completed.has(d))
      );
      if (ready.length === 0) break;

      for (const t of ready) {
        orchestrator.startExecution();
        const task = orchestrator.getTask(t.id);
        if (task?.status === 'running') {
          orchestrator.handleWorkerResponse({
            requestId: `req-${t.id}`,
            actionId: t.id,
            status: 'completed',
            outputs: { exitCode: 0 },
          });
        }
        completed.add(t.id);
        remaining.splice(remaining.indexOf(t), 1);
      }
    }
  }

  it('linear chain: A→B→C, dirty A → B,C stale + B-v2,C-v2 created', () => {
    loadAndCompleteChain([
      { id: 'A' },
      { id: 'B', deps: ['A'] },
      { id: 'C', deps: ['B'] },
    ]);

    orchestrator.forkDirtySubtree('A');

    expect(orchestrator.getTask('B')?.status).toBe('stale');
    expect(orchestrator.getTask('C')?.status).toBe('stale');

    const bv2 = orchestrator.getTask('B-v2');
    const cv2 = orchestrator.getTask('C-v2');
    expect(bv2).toBeDefined();
    expect(cv2).toBeDefined();
    expect(bv2!.status).toBe('pending');
    expect(cv2!.status).toBe('pending');

    expect(bv2!.dependencies).toEqual(['A']);
    expect(cv2!.dependencies).toEqual(['B-v2']);
  });

  it('fan-out: A→B, A→C, dirty A → B,C stale + both clones depend on A', () => {
    loadAndCompleteChain([
      { id: 'A' },
      { id: 'B', deps: ['A'] },
      { id: 'C', deps: ['A'] },
    ]);

    orchestrator.forkDirtySubtree('A');

    expect(orchestrator.getTask('B')?.status).toBe('stale');
    expect(orchestrator.getTask('C')?.status).toBe('stale');
    expect(orchestrator.getTask('B-v2')!.dependencies).toEqual(['A']);
    expect(orchestrator.getTask('C-v2')!.dependencies).toEqual(['A']);
  });

  it('diamond: A→B, A→C, B→D, C→D, dirty A → D-v2 depends on B-v2 and C-v2', () => {
    loadAndCompleteChain([
      { id: 'A' },
      { id: 'B', deps: ['A'] },
      { id: 'C', deps: ['A'] },
      { id: 'D', deps: ['B', 'C'] },
    ]);

    orchestrator.forkDirtySubtree('A');

    expect(orchestrator.getTask('D-v2')!.dependencies.sort()).toEqual(['B-v2', 'C-v2']);
  });

  it('partial tree: dirty B in A→B→C leaves A untouched', () => {
    loadAndCompleteChain([
      { id: 'A' },
      { id: 'B', deps: ['A'] },
      { id: 'C', deps: ['B'] },
    ]);

    orchestrator.forkDirtySubtree('B');

    expect(orchestrator.getTask('A')?.status).toBe('completed');
    expect(orchestrator.getTask('C')?.status).toBe('stale');
    expect(orchestrator.getTask('C-v2')!.dependencies).toEqual(['B']);
  });

  it('already versioned: A→B-v2, dirty A → creates B-v3', () => {
    orchestrator.loadPlan({
      name: 'test',
      tasks: [
        { id: 'A', description: 'Task A', command: 'echo A' },
        { id: 'B-v2', description: 'Task B v2', command: 'echo B', dependencies: ['A'] },
      ],
    });

    orchestrator.startExecution();
    orchestrator.handleWorkerResponse({
      requestId: 'req-A', actionId: 'A', status: 'completed', outputs: { exitCode: 0 },
    });
    orchestrator.startExecution();
    orchestrator.handleWorkerResponse({
      requestId: 'req-B-v2', actionId: 'B-v2', status: 'completed', outputs: { exitCode: 0 },
    });

    orchestrator.forkDirtySubtree('A');

    expect(orchestrator.getTask('B-v2')?.status).toBe('stale');
    expect(orchestrator.getTask('B-v3')).toBeDefined();
    expect(orchestrator.getTask('B-v3')!.dependencies).toEqual(['A']);
  });

  it('leaf task dirty: no descendants → no stale, no clones', () => {
    loadAndCompleteChain([
      { id: 'A' },
      { id: 'B', deps: ['A'] },
    ]);

    const deltas = orchestrator.forkDirtySubtree('B');
    expect(deltas).toEqual([]);
    expect(orchestrator.getTask('A')?.status).toBe('completed');
    expect(orchestrator.getTask('B')?.status).toBe('completed');
  });
});
