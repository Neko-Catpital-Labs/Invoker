/**
 * Bridge tests: Orchestrator + TaskExecutor integration.
 *
 * These tests wire a real Orchestrator with a real TaskExecutor,
 * using InMemoryPersistence and MockGit. They verify the critical
 * cross-boundary flows that individual component tests miss.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-utils';
import type { PlanDefinition } from '@invoker/core';

// ── Shared Plans ────────────────────────────────────────────

const LINEAR_PLAN: PlanDefinition = {
  name: 'Linear Plan',
  onFinish: 'merge',
  baseBranch: 'master',
  featureBranch: 'plan/linear',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b', dependencies: ['A'] },
    { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['B'] },
  ],
};

const PARALLEL_PLAN: PlanDefinition = {
  name: 'Parallel Plan',
  onFinish: 'merge',
  baseBranch: 'master',
  featureBranch: 'plan/parallel',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b' },
    { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['A', 'B'] },
  ],
};

const FANOUT_PLAN: PlanDefinition = {
  name: 'Fan-out Plan',
  onFinish: 'merge',
  baseBranch: 'master',
  featureBranch: 'plan/fanout',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b', dependencies: ['A'] },
    { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['A'] },
  ],
};

// ── Flow 1: Rebase & Retry ──────────────────────────────────

describe('Flow 1: rebase-and-retry', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('clean rebase: restarts merge gate only, leaf tasks stay completed', async () => {
    const started = h.loadAndStart(PARALLEL_PLAN);
    expect(started.some(t => t.id === 'A' && t.status === 'running')).toBe(true);
    expect(started.some(t => t.id === 'B' && t.status === 'running')).toBe(true);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    // Merge gate should have auto-started
    const mergeId = h.getAllTasks().find(t => t.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;
    expect(mergeTask.status).toBe('running');

    // Simulate merge failure
    h.git.onMerge(new Error('CONFLICT (content): App.tsx'));
    await h.executor.executeTasks([mergeTask]);

    expect(h.getTask(mergeId)!.status).toBe('failed');

    // Rebase succeeds (mock git rebase returns clean)
    const result = await h.executor.rebaseTaskBranches(
      mergeTask.workflowId!,
      'master',
    );
    expect(result.success).toBe(true);

    // Restart merge gate only
    h.git.reset();
    const restarted = h.orchestrator.restartTask(mergeId);
    expect(restarted.some(t => t.id === mergeId && t.status === 'running')).toBe(true);

    // Leaf tasks should still be completed
    expect(h.getTask('A')!.status).toBe('completed');
    expect(h.getTask('B')!.status).toBe('completed');
    expect(h.getTask('C')!.status).toBe('completed');

    // Execute merge gate again (succeeds this time)
    const runnable = restarted.filter(t => t.status === 'running');
    await h.executor.executeTasks(runnable);
    expect(h.getTask(mergeId)!.status).toBe('completed');
  });

  it('conflicting rebase: resets entire DAG, all tasks re-execute', async () => {
    const started = h.loadAndStart(PARALLEL_PLAN);

    // Complete tasks with branch info so rebaseTaskBranches has branches to rebase
    h.completeTask('A');
    h.completeTask('B');
    // Set branches on the task state (handleWorkerResponse doesn't set branch)
    h.persistence.updateTask('A', { branch: 'experiment/task-a' } as any);
    h.persistence.updateTask('B', { branch: 'experiment/task-b' } as any);
    // Force the orchestrator to re-read from persistence
    (h.orchestrator as any).refreshFromDb();

    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    // Merge fails
    h.git.onMerge(new Error('CONFLICT'));
    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('failed');

    // Rebase fails too
    h.git.on(
      (args) => args[0] === 'rebase',
      new Error('CONFLICT in file.txt'),
    );
    const result = await h.executor.rebaseTaskBranches(
      mergeTask.workflowId!,
      'master',
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // Reset entire DAG
    const workflowStarted = h.orchestrator.restartWorkflow(mergeTask.workflowId!);

    // All non-merge tasks should be pending or running (re-started)
    const nonMergeTasks = h.getAllTasks().filter(t => !t.isMergeNode);
    for (const t of nonMergeTasks) {
      expect(['pending', 'running']).toContain(t.status);
    }

    // Root tasks should have started
    expect(workflowStarted.some(t => t.id === 'A')).toBe(true);
    expect(workflowStarted.some(t => t.id === 'B')).toBe(true);
  });

  it('merge gate error surfaces conflict file details', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    h.git.onMerge(new Error(
      'git merge --no-ff failed (code 1): \nAuto-merging App.tsx\nCONFLICT (content): Merge conflict in App.tsx',
    ));
    await h.executor.executeTasks([mergeTask]);

    const failed = h.getTask(mergeId)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('CONFLICT');
    expect(failed.error).toContain('App.tsx');
  });

  it('failed merge cleans up: abort + checkout original branch', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    h.git.onMerge(new Error('CONFLICT'));
    await h.executor.executeTasks([mergeTask]);

    const mergeAbort = h.git.getCalls('merge').find(c => c.includes('--abort'));
    expect(mergeAbort).toBeDefined();

    const checkoutCalls = h.git.getCalls('checkout');
    const lastCheckout = checkoutCalls[checkoutCalls.length - 1];
    expect(lastCheckout).toContain('master');
  });
});

// ── Flow 2: Restart Task ────────────────────────────────────

describe('Flow 2: restart task', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('restarting a completed task resets it and re-executes', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.completeTask('A');

    expect(h.getTask('A')!.status).toBe('completed');
    expect(h.getTask('B')!.status).toBe('running');

    // Restart A — B is running (not blocked), so restartTask only resets A
    h.orchestrator.restartTask('A');

    // A should be running (no deps, auto-started)
    expect(h.getTask('A')!.status).toBe('running');
  });

  it('restarting a failed task allows downstream cascade', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'initial failure');

    expect(h.getTask('A')!.status).toBe('failed');
    expect(h.getTask('B')!.status).toBe('blocked');

    // Restart A
    h.orchestrator.restartTask('A');
    expect(h.getTask('A')!.status).toBe('running');

    // Complete A -> B should unblock
    h.completeTask('A');
    expect(h.getTask('B')!.status).toBe('running');

    // Complete B -> C should start
    h.completeTask('B');
    expect(h.getTask('C')!.status).toBe('running');
  });
});

// ── Flow 3: Task Completion Cascade ─────────────────────────

describe('Flow 3: task completion cascade', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('linear chain: completing A starts B, completing B starts C', () => {
    h.loadAndStart(LINEAR_PLAN);
    expect(h.getTask('A')!.status).toBe('running');
    expect(h.getTask('B')!.status).toBe('pending');
    expect(h.getTask('C')!.status).toBe('pending');

    h.completeTask('A');
    expect(h.getTask('B')!.status).toBe('running');
    expect(h.getTask('C')!.status).toBe('pending');

    h.completeTask('B');
    expect(h.getTask('C')!.status).toBe('running');
  });

  it('parallel tasks: completing A does not start C (waiting for B)', () => {
    h.loadAndStart(PARALLEL_PLAN);
    expect(h.getTask('A')!.status).toBe('running');
    expect(h.getTask('B')!.status).toBe('running');
    expect(h.getTask('C')!.status).toBe('pending');

    h.completeTask('A');
    expect(h.getTask('C')!.status).toBe('pending');

    h.completeTask('B');
    expect(h.getTask('C')!.status).toBe('running');
  });

  it('fan-out: completing A starts both B and C', () => {
    h.loadAndStart(FANOUT_PLAN);
    expect(h.getTask('A')!.status).toBe('running');
    expect(h.getTask('B')!.status).toBe('pending');
    expect(h.getTask('C')!.status).toBe('pending');

    h.completeTask('A');
    expect(h.getTask('B')!.status).toBe('running');
    expect(h.getTask('C')!.status).toBe('running');
  });
});

// ── Flow 4: Edit/Fork Mutations ─────────────────────────────

describe('Flow 4: edit/fork mutations', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('editTaskCommand forks dirty subtree', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.completeTask('A');
    expect(h.getTask('B')!.status).toBe('running');

    // Complete B so we can edit A (which has downstream completed work)
    h.completeTask('B');
    h.completeTask('C');

    // Edit A's command — should fork B and C
    h.orchestrator.editTaskCommand('A', 'echo new-a');

    // A should be restarted
    const a = h.getTask('A')!;
    expect(a.status === 'pending' || a.status === 'running').toBe(true);
    expect(a.command).toBe('echo new-a');

    // B should be stale, B-v2 should exist
    expect(h.getTask('B')!.status).toBe('stale');
    const bv2 = h.getAllTasks().find(t => t.id === 'B-v2');
    expect(bv2).toBeDefined();
    expect(bv2!.status).toBe('pending');

    // C should be stale, C-v2 should exist
    expect(h.getTask('C')!.status).toBe('stale');
    const cv2 = h.getAllTasks().find(t => t.id === 'C-v2');
    expect(cv2).toBeDefined();
  });

  it('editTaskType does NOT fork subtree', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.completeTask('A');
    h.completeTask('B');

    // Edit A's type
    h.orchestrator.editTaskType('A', 'worktree');

    // A restarted
    const a = h.getTask('A')!;
    expect(a.familiarType).toBe('worktree');
    expect(a.status === 'pending' || a.status === 'running').toBe(true);

    // B should still be the original (not forked), no B-v2 created
    expect(h.getAllTasks().find(t => t.id === 'B-v2')).toBeUndefined();
    // B stays completed since editTaskType doesn't fork downstream
    expect(h.getTask('B')!.status).toBe('completed');
  });

  it('replaceTask creates subgraph and wires dependencies', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    expect(h.getTask('A')!.status).toBe('failed');
    expect(h.getTask('B')!.status).toBe('blocked');

    // Replace A with two sub-tasks
    const replacements = h.orchestrator.replaceTask('A', [
      { id: 'A-fix-1', description: 'Fix part 1', command: 'echo fix1' },
      { id: 'A-fix-2', description: 'Fix part 2', command: 'echo fix2', dependencies: ['A-fix-1'] },
    ]);

    // A should be stale
    expect(h.getTask('A')!.status).toBe('stale');

    // Replacements should exist
    const fix1 = h.getTask('A-fix-1')!;
    const fix2 = h.getTask('A-fix-2')!;
    expect(fix1).toBeDefined();
    expect(fix2).toBeDefined();

    // fix1 should be running (auto-started)
    expect(fix1.status === 'pending' || fix1.status === 'running').toBe(true);
  });
});

// ── Flow 5: Graph Mutation via Worker Response (experiments) ──

describe('Flow 5: dagMutation via spawn_experiments', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('spawn_experiments creates experiment nodes and reconciliation node', () => {
    h.loadAndStart(LINEAR_PLAN);

    // A spawns experiments instead of completing normally
    const response = {
      requestId: 'spawn-A',
      actionId: 'A',
      status: 'spawn_experiments' as const,
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: 'Try two approaches',
          variants: [
            { id: 'v1', description: 'Approach 1', command: 'echo v1' },
            { id: 'v2', description: 'Approach 2', command: 'echo v2' },
          ],
        },
      },
    };

    const started = h.orchestrator.handleWorkerResponse(response);

    // Experiment nodes should exist
    const allTasks = h.getAllTasks();
    const expTasks = allTasks.filter(t => t.id.startsWith('A-exp-'));
    expect(expTasks.length).toBe(2);

    // Experiment tasks should be running or pending
    for (const t of expTasks) {
      expect(['pending', 'running']).toContain(t.status);
    }

    // B should be stale (forked due to graph mutation)
    expect(h.getTask('B')!.status).toBe('stale');

    // A reconciliation task should exist
    const reconTask = allTasks.find(t => t.id.includes('reconciliation'));
    expect(reconTask).toBeDefined();
  });

  it('select_experiment completes the experiment lifecycle', () => {
    h.loadAndStart(LINEAR_PLAN);

    // Spawn experiments on A
    h.orchestrator.handleWorkerResponse({
      requestId: 'spawn-A',
      actionId: 'A',
      status: 'spawn_experiments' as const,
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: 'Try approaches',
          variants: [
            { id: 'v1', description: 'Approach 1', command: 'echo v1' },
            { id: 'v2', description: 'Approach 2', command: 'echo v2' },
          ],
        },
      },
    });

    // Complete both experiment tasks
    const expIds = h.getAllTasks()
      .filter(t => t.id.startsWith('A-exp-'))
      .map(t => t.id);
    for (const id of expIds) {
      h.completeTask(id);
    }

    // Reconciliation should be needs_input (waiting for user to select winner)
    const reconTask = h.getAllTasks().find(t => t.id.includes('reconciliation'));
    expect(reconTask).toBeDefined();
    expect(reconTask!.status).toBe('needs_input');

    // Select experiment v1 via selectExperiment
    h.orchestrator.selectExperiment(reconTask!.id, expIds[0]);

    // Reconciliation task should be completed
    expect(h.getTask(reconTask!.id)!.status).toBe('completed');
  });
});
