import { describe, it, expect, beforeEach } from 'vitest';
import { sid } from './scoped-test-helpers.js';
import { Orchestrator, TopologyForkRequired } from '../orchestrator.js';
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

/**
 * Step 11 (`docs/architecture/task-invalidation-roadmap.md`) makes
 * `replaceTask` throw `TopologyForkRequired` whenever the workflow has
 * any non-merge task in a live status (pending, running, ...). The
 * existing in-place replacement scenarios in this file model a
 * "downstream is still pending" case, which is precisely what the new
 * gate forbids. To preserve the underlying assertions about the
 * post-mutation graph shape (source → stale, replacement created,
 * merge node reconciled), each scenario first terminates the live
 * downstream subgraph by cancelling the topmost live descendant. The
 * cancel marks the descendant + its transitive dependents as `failed`,
 * making the workflow terminal so `replaceTask` can mutate in place.
 *
 * The post-mutation `expect(... .status).toBe('stale')` assertions
 * still hold because `replaceTask` unconditionally re-marks all
 * non-merge transitive descendants of the source as `stale`.
 */
function terminateLiveDescendant(orchestrator: Orchestrator, descendantId: string): void {
  orchestrator.cancelTask(descendantId);
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
    terminateLiveDescendant(orchestrator, 'C');
    const started = orchestrator.replaceTask('X', [
      { id: 'fix', description: 'Fix X', command: 'echo fix' },
    ]);

    expect(orchestrator.getTask(s('X'))!.status).toBe('stale');
    expect(orchestrator.getTask(s('fix'))).toBeDefined();
    expect(orchestrator.getTask(s('fix'))!.dependencies).toEqual([s('A')]);

    expect(orchestrator.getTask(s('C'))!.status).toBe('stale');
    const mergeNode = orchestrator.getAllTasks().find((t) => t.config.isMergeNode);
    expect(mergeNode!.dependencies).toContain(s('fix'));
    expect(
      persistence.loadAttempt(orchestrator.getTask(s('X'))!.execution.selectedAttemptId!)?.status,
    ).toBe('superseded');

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
    terminateLiveDescendant(orchestrator, 'C');
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

    terminateLiveDescendant(orchestrator, 'C');
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
    terminateLiveDescendant(orchestrator, 'C');
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
    terminateLiveDescendant(orchestrator, 'C');
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
    terminateLiveDescendant(orchestrator, 'C');
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

    terminateLiveDescendant(orchestrator, 'C');
    terminateLiveDescendant(orchestrator, 'D');
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

  // ── Step 11 (task-invalidation roadmap): topology-fork policy ──
  //
  // The chart's Decision Table row "Change graph topology" makes
  // graph-shape changes fork-class / workflow scope: they must NOT
  // mutate a live workflow in place. Instead, callers see a
  // workflow fork path. In-place is preserved on a fully terminal
  // workflow because there is no in-flight work to race with.
  describe('topology-fork policy', () => {
    it('forks the workflow when downstream is still pending', () => {
      orchestrator.loadPlan({
        name: 'topology-live',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      completeTask(orchestrator, 'A');
      failTask(orchestrator, 'X');

      // C is still pending → workflow is live → must fork, not mutate.
      const s = (l: string) => sid(orchestrator, 0, l);
      const wfId = orchestrator.getTask(s('X'))!.config.workflowId!;

      const started = orchestrator.replaceTask('X', [
        { id: 'fix', description: 'Fix', command: 'echo fix' },
      ]);

      const forkedWorkflowId = orchestrator
        .getWorkflowIds()
        .find((id) => id !== wfId);

      expect(forkedWorkflowId).toBeDefined();
      expect(orchestrator.getTask(s('X'))!.status).toBe('failed');
      const forkedFix = orchestrator
        .getAllTasks()
        .find((t) => t.config.workflowId === forkedWorkflowId && t.id.endsWith('/fix'));
      expect(forkedFix).toBeDefined();
      expect(started.some((t) => t.id === forkedFix?.id)).toBe(true);
    });

    it('forks the workflow when a sibling is still running', () => {
      orchestrator.loadPlan({
        name: 'topology-live-sibling',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'Y', description: 'Y', command: 'echo Y', dependencies: ['A'] },
        ],
      });
      orchestrator.startExecution();
      completeTask(orchestrator, 'A');
      failTask(orchestrator, 'X');
      // Y is now `running` after A completed.

      expect(orchestrator.getTask('Y')!.status).toBe('running');

      const s = (l: string) => sid(orchestrator, 0, l);
      const wfId = orchestrator.getTask(s('X'))!.config.workflowId!;
      const started = orchestrator.replaceTask('X', [
        { id: 'fix', description: 'Fix', command: 'echo fix' },
      ]);

      const forkedWorkflowId = orchestrator
        .getWorkflowIds()
        .find((id) => id !== wfId);

      expect(orchestrator.getTask(s('X'))!.status).toBe('failed');
      expect(forkedWorkflowId).toBeDefined();
      const forkedFix = orchestrator
        .getAllTasks()
        .find((t) => t.config.workflowId === forkedWorkflowId && t.id.endsWith('/fix'));
      expect(forkedFix).toBeDefined();
      expect(started.some((t) => t.id === forkedFix?.id)).toBe(true);
    });

    it('allows in-place replacement on a terminal workflow', () => {
      orchestrator.loadPlan({
        name: 'topology-terminal',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      completeTask(orchestrator, 'A');
      failTask(orchestrator, 'X');
      // Cancel C to make the workflow terminal (no live non-merge tasks).
      terminateLiveDescendant(orchestrator, 'C');

      const s = (l: string) => sid(orchestrator, 0, l);
      const started = orchestrator.replaceTask('X', [
        { id: 'fix', description: 'Fix', command: 'echo fix' },
      ]);

      expect(orchestrator.getTask(s('X'))!.status).toBe('stale');
      expect(orchestrator.getTask(s('fix'))).toBeDefined();
      expect(started.find((t) => t.id === s('fix'))).toBeDefined();
    });

    it('error class round-trips workflowId / taskId properties', () => {
      const err = new TopologyForkRequired('wf-42', 'wf-42/X');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('TopologyForkRequired');
      expect(err.workflowId).toBe('wf-42');
      expect(err.taskId).toBe('wf-42/X');
      expect(err.message).toContain('wf-42');
      expect(err.message).toContain('wf-42/X');
    });

    // The Step 11 gate sits BEFORE the topology mutation but AFTER the
    // earliest validation errors (not-found, running, empty). Those
    // errors continue to take precedence so that callers see the same
    // diagnostics they did before this step.
    it('not-found error still wins over topology check', () => {
      orchestrator.loadPlan({
        name: 'topology-precedence',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      // Workflow is live (everything pending), but the task id is bogus.
      expect(() =>
        orchestrator.replaceTask('does-not-exist', [
          { id: 'fix', description: 'Fix', command: 'echo fix' },
        ]),
      ).toThrow(/not found/);
    });

    // Step 11 must not affect pure-attribute mutations (Steps 2-10).
    // `editTaskCommand` is recreate-class / task scope and routes through
    // the per-attribute mutation path; topology gating must not block it
    // even though the workflow is unmistakably live (C is `pending`).
    it('does NOT throw for pure-attribute mutations on a live workflow', () => {
      orchestrator.loadPlan({
        name: 'pure-attribute-on-live',
        tasks: [
          { id: 'A', description: 'A', command: 'echo A' },
          { id: 'X', description: 'X', command: 'echo X', dependencies: ['A'] },
          { id: 'C', description: 'C', command: 'echo C', dependencies: ['X'] },
        ],
      });
      orchestrator.startExecution();
      completeTask(orchestrator, 'A');
      failTask(orchestrator, 'X');
      // C is `pending` (blocked by failed X) → workflow is live by the
      // Step 11 definition. Editing A's command must still succeed —
      // no graph edge changes, only a per-attribute mutation routed
      // through the existing `editTaskCommand` path (Step 2).
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      expect(() => orchestrator.editTaskCommand('A', 'echo A-v2')).not.toThrow();
      expect(orchestrator.getTask('A')!.config.command).toBe('echo A-v2');
    });
  });
});
