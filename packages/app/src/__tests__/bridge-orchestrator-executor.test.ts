/**
 * Bridge tests: Orchestrator + TaskRunner integration.
 *
 * These tests wire a real Orchestrator with a real TaskRunner,
 * using InMemoryPersistence and MockGit. They verify the critical
 * cross-boundary flows that individual component tests miss.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestHarness, type TestHarness, InMemoryBus, InMemoryPersistence, MockGit } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition, type TaskState } from '@invoker/workflow-core';
import { TaskRunner, ExecutorRegistry, type MergeGateProvider } from '@invoker/execution-engine';
import { setWorkflowMergeMode } from '../workflow-actions.js';
import { executeGlobalTopup } from '../global-topup.js';

// ── Shared Plans ────────────────────────────────────────────

const LINEAR_PLAN: PlanDefinition = {
  name: 'Linear Plan',
  onFinish: 'merge',
  mergeMode: 'automatic',
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
  mergeMode: 'automatic',
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
  mergeMode: 'automatic',
  baseBranch: 'master',
  featureBranch: 'plan/fanout',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b', dependencies: ['A'] },
    { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['A'] },
  ],
};

const INDEPENDENT_TWO_TASK_PLAN: PlanDefinition = {
  name: 'Independent Two Task Plan',
  onFinish: 'merge',
  mergeMode: 'automatic',
  baseBranch: 'master',
  featureBranch: 'plan/independent-two',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b' },
  ],
};

describe('global top-up dispatch', () => {
  it('dispatches only newly started tasks and skips duplicates', async () => {
    const duplicate = {
      id: 'wf-1/task-a',
      status: 'running',
      description: 'duplicate',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-1' },
      execution: { selectedAttemptId: 'attempt-a' },
    } as unknown as TaskState;
    const newTask = {
      id: 'wf-2/task-b',
      status: 'running',
      description: 'new task',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-2' },
      execution: { selectedAttemptId: 'attempt-b' },
    } as unknown as TaskState;
    const orchestrator = {
      startExecution: vi.fn(() => [duplicate, newTask]),
    } as unknown as Orchestrator;
    const taskExecutor = {
      executeTasks: vi.fn(async () => {}),
    } as unknown as TaskRunner;

    const topup = await executeGlobalTopup({
      orchestrator,
      taskExecutor,
      context: 'test.bridge.global-topup',
      alreadyDispatched: [duplicate],
    });

    expect(orchestrator.startExecution).toHaveBeenCalledTimes(1);
    expect(taskExecutor.executeTasks).toHaveBeenCalledTimes(1);
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith([newTask]);
    expect(topup.map((task) => task.id)).toEqual(['wf-2/task-b']);
  });

  it('a failed fix path leaves ready pending work idle until executeGlobalTopup runs', async () => {
    const h = createTestHarness({ maxConcurrency: 1 });
    const started = h.loadAndStart(INDEPENDENT_TWO_TASK_PLAN);
    expect(started.map((task) => task.id)).toEqual([expect.stringMatching(/\/A$/)]);

    const taskA = h.getTask('A')!;
    const taskB = h.getTask('B')!;
    const attemptA = taskA.execution.selectedAttemptId!;
    expect(taskA.status).toBe('running');
    expect(taskB.status).toBe('pending');

    h.persistence.updateTask(taskA.id, {
      status: 'failed',
      execution: {
        error: 'task failed',
        exitCode: 1,
        completedAt: new Date(),
      },
    });
    h.persistence.updateAttempt(attemptA, {
      status: 'failed',
      error: 'task failed',
      exitCode: 1,
      completedAt: new Date(),
    });
    (h.orchestrator as any).refreshFromDb();

    const { savedError } = h.orchestrator.beginConflictResolution(taskA.id);
    expect(h.getTask('A')!.status).toBe('fixing_with_ai');
    expect(h.getTask('B')!.status).toBe('pending');

    h.orchestrator.revertConflictResolution(taskA.id, savedError, 'Remote agent fix timed out after 600000ms');

    expect(h.getTask('A')!.status).toBe('failed');
    expect(h.getTask('B')!.status).toBe('pending');

    const taskExecutor = {
      executeTasks: vi.fn(async () => {}),
    } as unknown as TaskRunner;

    const topup = await executeGlobalTopup({
      orchestrator: h.orchestrator,
      taskExecutor,
      context: 'test.bridge.failed-fix-global-topup',
    });

    expect(topup.map((task) => task.id)).toEqual([taskB.id]);
    expect(taskExecutor.executeTasks).toHaveBeenCalledWith([
      expect.objectContaining({ id: taskB.id, status: 'running' }),
    ]);
  });
});

// ── Flow 1: Rebase & Retry ──────────────────────────────────

describe('Flow 1: rebase-and-retry', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('clean rebase: restarts merge gate only, leaf tasks stay completed', async () => {
    const started = h.loadAndStart(PARALLEL_PLAN);
    expect(started.some((t) => t.id.endsWith('/A') && t.status === 'running')).toBe(true);
    expect(started.some((t) => t.id.endsWith('/B') && t.status === 'running')).toBe(true);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    // Merge gate should have auto-started
    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;
    expect(mergeTask.status).toBe('running');

    // Simulate merge failure
    h.git.onMerge(new Error('CONFLICT (content): App.tsx'));
    await h.executor.executeTasks([mergeTask]);

    expect(h.getTask(mergeId)!.status).toBe('failed');

    // Rebase succeeds (mock git rebase returns clean)
    const result = await h.executor.rebaseTaskBranches(
      mergeTask.config.workflowId!,
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

    h.completeTask('A');
    h.completeTask('B');
    h.persistence.updateTask('A', { execution: { branch: 'experiment/task-a-abc12345' } });
    h.persistence.updateTask('B', { execution: { branch: 'experiment/task-b-def67890' } });
    (h.orchestrator as any).refreshFromDb();

    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
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
      mergeTask.config.workflowId!,
      'master',
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    // Reset entire DAG
    const workflowStarted = h.orchestrator.recreateWorkflow(mergeTask.config.workflowId!);

    // All non-merge tasks should be pending or running (re-started)
    const nonMergeTasks = h.getAllTasks().filter(t => !t.config.isMergeNode);
    for (const t of nonMergeTasks) {
      expect(['pending', 'running']).toContain(t.status);
    }

    // Root tasks should have started
    expect(workflowStarted.some((t) => t.id.endsWith('/A'))).toBe(true);
    expect(workflowStarted.some((t) => t.id.endsWith('/B'))).toBe(true);
  });

  it('merge gate error surfaces conflict file details', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    h.git.onMerge(new Error(
      'git merge --no-ff failed (code 1): \nAuto-merging App.tsx\nCONFLICT (content): Merge conflict in App.tsx',
    ));
    await h.executor.executeTasks([mergeTask]);

    const failed = h.getTask(mergeId)!;
    expect(failed.status).toBe('failed');
    expect(failed.execution.error).toContain('CONFLICT');
    expect(failed.execution.error).toContain('App.tsx');
  });

  it('failed merge cleans up: abort', async () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    h.git.onMerge(new Error('CONFLICT'));
    await h.executor.executeTasks([mergeTask]);

    const mergeAbort = h.git.getCalls('merge').find(c => c.includes('--abort'));
    expect(mergeAbort).toBeDefined();
  });
});

// ── Flow 1b: Rebase & Retry from any node ───────────────────

describe('Flow 1b: rebase-and-retry from any node', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('clean rebase triggered from leaf task restarts merge gate only', async () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    // Merge fails
    h.git.onMerge(new Error('CONFLICT'));
    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('failed');

    // Trigger rebase from leaf task A (not the merge gate)
    const leafTask = h.getTask('A')!;
    const result = await h.executor.rebaseTaskBranches(
      leafTask.config.workflowId!,
      'master',
    );
    expect(result.success).toBe(true);

    // Find merge gate from workflow (same logic as the updated IPC handler)
    const foundMerge = h.getAllTasks().find(
      t => t.config.workflowId === leafTask.config.workflowId && t.config.isMergeNode,
    );
    expect(foundMerge).toBeDefined();

    // Clean rebase: restart merge gate only
    h.git.reset();
    const restarted = h.orchestrator.restartTask(foundMerge!.id);
    expect(restarted.some(t => t.id === mergeId && t.status === 'running')).toBe(true);

    // Leaf tasks stay completed
    expect(h.getTask('A')!.status).toBe('completed');
    expect(h.getTask('B')!.status).toBe('completed');
    expect(h.getTask('C')!.status).toBe('completed');
  });

  it('conflicting rebase triggered from leaf task resets entire DAG', async () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.persistence.updateTask('A', { execution: { branch: 'experiment/task-a-abc12345' } });
    h.persistence.updateTask('B', { execution: { branch: 'experiment/task-b-def67890' } });
    (h.orchestrator as any).refreshFromDb();

    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    // Merge fails
    h.git.onMerge(new Error('CONFLICT'));
    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('failed');

    // Trigger rebase from leaf task B (not the merge gate)
    const leafTask = h.getTask('B')!;
    h.git.on(
      (args) => args[0] === 'rebase',
      new Error('CONFLICT in file.txt'),
    );
    const result = await h.executor.rebaseTaskBranches(
      leafTask.config.workflowId!,
      'master',
    );
    expect(result.success).toBe(false);

    // Conflict: reset entire DAG
    const workflowStarted = h.orchestrator.recreateWorkflow(leafTask.config.workflowId!);

    // All non-merge tasks should be pending or running
    const nonMergeTasks = h.getAllTasks().filter(t => !t.config.isMergeNode);
    for (const t of nonMergeTasks) {
      expect(['pending', 'running']).toContain(t.status);
    }

    // Root tasks should have started
    expect(workflowStarted.some((t) => t.id.endsWith('/A'))).toBe(true);
    expect(workflowStarted.some((t) => t.id.endsWith('/B'))).toBe(true);
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
    expect(h.getTask('B')!.status).toBe('pending');

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

  it('editTaskCommand restarts task in-place without forking downstream', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.completeTask('A');
    expect(h.getTask('B')!.status).toBe('running');

    // Complete B so we can edit A (which has downstream completed work)
    h.completeTask('B');
    h.completeTask('C');

    // Edit A's command — restarts A in-place, no fork
    h.orchestrator.editTaskCommand('A', 'echo new-a');

    // A should be restarted
    const a = h.getTask('A')!;
    expect(a.status === 'pending' || a.status === 'running').toBe(true);
    expect(a.config.command).toBe('echo new-a');

    // B and C are invalidated (no fork, no stale clones)
    expect(h.getTask('B')!.status).toBe('pending');
    expect(h.getTask('C')!.status).toBe('pending');

    // No v2 nodes exist
    expect(h.getAllTasks().find((t) => t.id.endsWith('/B-v2'))).toBeUndefined();
    expect(h.getAllTasks().find((t) => t.id.endsWith('/C-v2'))).toBeUndefined();
  });

  it('editTaskType does NOT fork subtree', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.completeTask('A');
    h.completeTask('B');

    // Edit A's type
    h.orchestrator.editTaskType('A', 'worktree');

    // A restarted
    const a = h.getTask('A')!;
    expect(a.config.executorType).toBe('worktree');
    expect(a.status === 'pending' || a.status === 'running').toBe(true);

    // B should still be the original (not forked), no B-v2 created
    expect(h.getAllTasks().find((t) => t.id.endsWith('/B-v2'))).toBeUndefined();
    // B is invalidated since editTaskType restarts in-place and resets downstream
    expect(h.getTask('B')!.status).toBe('pending');
  });

  it('replaceTask creates subgraph and wires dependencies', () => {
    h.loadAndStart(LINEAR_PLAN);
    h.failTask('A', 'broken');

    expect(h.getTask('A')!.status).toBe('failed');
    expect(h.getTask('B')!.status).toBe('pending');

    // Step 11 (`docs/architecture/task-invalidation-roadmap.md`):
    // `replaceTask` now throws `TopologyForkRequired` when the workflow
    // is live (any non-merge task still pending/running/...). LINEAR_PLAN
    // here is A → B → C, and after failTask('A') both B and C remain
    // `pending`, so we cancel the live downstream subgraph (B drags C
    // with it) before exercising the in-place replacement path. The
    // assertions about the replacement subgraph are unchanged.
    h.orchestrator.cancelTask('B');

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
      executionGeneration: h.getTask('A')?.execution.generation ?? 0,
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
    const expTasks = allTasks.filter((t) => t.id.includes('/A-exp-'));
    expect(expTasks.length).toBe(2);

    // Experiment tasks should be running or pending
    for (const t of expTasks) {
      expect(['pending', 'running']).toContain(t.status);
    }

    // B stays pending (dependencies remapped in-place, no fork)
    expect(h.getTask('B')!.status).toBe('pending');

    // A reconciliation task should exist
    const reconTask = allTasks.find(t => t.id.includes('reconciliation'));
    expect(reconTask).toBeDefined();
  });

  it('select_experiment completes the experiment lifecycle', async () => {
    h.loadAndStart(LINEAR_PLAN);

    // Spawn experiments on A
    h.orchestrator.handleWorkerResponse({
      requestId: 'spawn-A',
      actionId: 'A',
      executionGeneration: h.getTask('A')?.execution.generation ?? 0,
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
      .filter((t) => t.id.includes('/A-exp-'))
      .map(t => t.id);
    for (const id of expIds) {
      h.completeTask(id);
    }

    // Reconciliation is auto-started as running; drive the executor so MockExecutor emits needs_input
    let reconTask = h.getAllTasks().find(t => t.id.includes('reconciliation'));
    expect(reconTask).toBeDefined();
    if (reconTask!.status === 'running') {
      await h.executor.executeTasks([reconTask!]);
    }
    reconTask = h.getTask(reconTask!.id)!;
    // WorktreeExecutor emits needs_input; harness MockExecutor auto-completes → awaiting_approval (recon has requiresManualApproval)
    expect(['needs_input', 'awaiting_approval']).toContain(reconTask.status);

    // Select experiment v1 via selectExperiment
    h.orchestrator.selectExperiment(reconTask!.id, expIds[0]);

    // Reconciliation task should be completed
    expect(h.getTask(reconTask!.id)!.status).toBe('completed');
  });
});

// ── Flow 6b: Set Merge Branch ────────────────────────────────

describe('Flow 6b: set-merge-branch', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('updateWorkflow stores baseBranch and it persists via loadWorkflow', () => {
    h.loadAndStart(PARALLEL_PLAN);
    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const wfId = h.getTask(mergeId)!.config.workflowId!;

    h.persistence.updateWorkflow(wfId, { baseBranch: 'develop' });
    const wf = h.persistence.loadWorkflow(wfId);
    expect(wf.baseBranch).toBe('develop');
  });

  it('listWorkflows returns baseBranch and onFinish per workflow', () => {
    h.loadAndStart(PARALLEL_PLAN);
    const workflows = h.persistence.listWorkflows();
    expect(workflows.length).toBe(1);
    expect(workflows[0].baseBranch).toBe('master');
    expect(workflows[0].onFinish).toBe('merge');
  });

  it('changing baseBranch and restarting merge gate re-executes merge', async () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const wfId = h.getTask(mergeId)!.config.workflowId!;

    // Execute merge gate (succeeds initially)
    const mergeTask = h.getTask(mergeId)!;
    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('completed');

    // Change baseBranch
    h.persistence.updateWorkflow(wfId, { baseBranch: 'develop' });

    // Restart merge gate
    const restarted = h.orchestrator.restartTask(mergeId);
    expect(restarted.some(t => t.id === mergeId && t.status === 'running')).toBe(true);

    // Re-execute merge gate (it will re-run with new baseBranch)
    const runnable = restarted.filter(t => t.status === 'running');
    await h.executor.executeTasks(runnable);
    expect(h.getTask(mergeId)!.status).toBe('completed');

    // Verify the workflow's baseBranch persisted
    const wf = h.persistence.loadWorkflow(wfId);
    expect(wf.baseBranch).toBe('develop');
  });

  it('multiple workflows have independent baseBranch values', () => {
    h.loadAndStart(PARALLEL_PLAN);
    h.loadAndStart({ ...LINEAR_PLAN, name: 'Linear Plan 2', baseBranch: 'develop' }, { allowGraphMutation: true });

    const workflows = h.persistence.listWorkflows();
    expect(workflows.length).toBe(2);

    const branches = workflows.map(w => w.baseBranch).sort();
    expect(branches).toEqual(['develop', 'master']);
  });
});

// ── Flow 6: Content-Addressable Branch Names ────────────────

describe('Flow 6: content-addressable branch names', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('recreateWorkflow clears branch and workspacePath fields', () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    // Simulate branch + workspacePath being set (as WorktreeExecutor would do)
    h.persistence.updateTask('A', {
      execution: { branch: 'experiment/A-abc12345', workspacePath: '/tmp/worktrees/exec-A' },
    });
    h.persistence.updateTask('B', {
      execution: { branch: 'experiment/B-def67890', workspacePath: '/tmp/worktrees/exec-B' },
    });
    (h.orchestrator as any).refreshFromDb();

    expect(h.getTask('A')!.execution.branch).toBe('experiment/A-abc12345');
    expect(h.getTask('B')!.execution.branch).toBe('experiment/B-def67890');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    h.orchestrator.recreateWorkflow(mergeTask.config.workflowId!);

    // branch and workspacePath should be cleared on all tasks
    for (const t of h.getAllTasks().filter(t => !t.config.isMergeNode)) {
      expect(t.execution?.branch).toBeUndefined();
      expect(t.execution?.workspacePath).toBeUndefined();
    }
  });

  it('recreateWorkflow resets tasks so re-execution gets fresh branches', () => {
    h.loadAndStart(LINEAR_PLAN);

    h.completeTask('A');
    h.persistence.updateTask('A', {
      execution: { branch: 'experiment/A-oldHash1', workspacePath: '/tmp/worktrees/exec-A-old' },
    });
    (h.orchestrator as any).refreshFromDb();

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    h.orchestrator.recreateWorkflow(mergeTask.config.workflowId!);

    // After restart, A should be running with no branch (WorktreeExecutor will assign a new one)
    const a = h.getTask('A')!;
    expect(a.status === 'pending' || a.status === 'running').toBe(true);
    expect(a.execution?.branch).toBeUndefined();
    expect(a.execution?.workspacePath).toBeUndefined();
  });

  it('rebase-and-retry full flow: conflict resets DAG, clears stale branches', async () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.persistence.updateTask('A', { execution: { branch: 'experiment/A-oldHash1' } });
    h.persistence.updateTask('B', { execution: { branch: 'experiment/B-oldHash2' } });
    (h.orchestrator as any).refreshFromDb();

    h.completeTask('C');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    // Merge fails
    h.git.onMerge(new Error('CONFLICT'));
    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('failed');

    // Rebase fails (conflict)
    h.git.on(
      (args) => args[0] === 'rebase',
      new Error('CONFLICT in file.txt'),
    );
    const result = await h.executor.rebaseTaskBranches(
      mergeTask.config.workflowId!,
      'master',
    );
    expect(result.success).toBe(false);

    // Reset entire DAG
    h.orchestrator.recreateWorkflow(mergeTask.config.workflowId!);

    // All tasks should have their branch cleared
    for (const t of h.getAllTasks().filter(t => !t.config.isMergeNode)) {
      expect(t.execution?.branch).toBeUndefined();
      expect(t.execution?.workspacePath).toBeUndefined();
    }

    // Root tasks should be re-started and ready for WorktreeExecutor
    // to assign new content-addressable branches
    expect(h.getTask('A')!.status === 'pending' || h.getTask('A')!.status === 'running').toBe(true);
    expect(h.getTask('B')!.status === 'pending' || h.getTask('B')!.status === 'running').toBe(true);
  });
});

// ── Flow 7: Orphan Task Relaunch on Restart ─────────────────

describe('Flow 7: orphan relaunch on restart', () => {
  it('orphaned running tasks are relaunched after simulated restart', () => {
    const h1 = createTestHarness();
    h1.loadAndStart(LINEAR_PLAN);
    expect(h1.getTask('A')!.status).toBe('running');

    // Simulate app restart: new orchestrator from same persistence
    const orchestrator2 = new Orchestrator({
      persistence: h1.persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });
    orchestrator2.syncAllFromDb();

    // t1 is still 'running' in the DB — orphaned
    expect(orchestrator2.getTask('A')?.status).toBe('running');

    // Reconcile: restartTask resets to pending, auto-starts (deps met)
    const restarted: TaskState[] = [];
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        const started = orchestrator2.restartTask(task.id);
        restarted.push(...started.filter(t => t.status === 'running'));
      }
    }

    expect(restarted.length).toBe(1);
    const scopedA = restarted[0].id;
    expect(scopedA.endsWith('/A')).toBe(true);
    expect(orchestrator2.getTask('A')?.status).toBe('running');

    // Complete A → B auto-starts
    orchestrator2.handleWorkerResponse({
      requestId: 'complete-A',
      actionId: scopedA,
      executionGeneration: orchestrator2.getTask(scopedA)?.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    expect(orchestrator2.getTask('A')?.status).toBe('completed');
    expect(orchestrator2.getTask('B')?.status).toBe('running');
  });

  it('multiple orphaned tasks in a chain are all relaunched correctly', () => {
    const h1 = createTestHarness({ maxConcurrency: 10 });

    // Use a plan where all tasks can run in parallel (no deps between A and B)
    const plan: PlanDefinition = {
      name: 'Multi-orphan Plan',
      onFinish: 'none',
      tasks: [
        { id: 'X', description: 'Task X', command: 'echo x' },
        { id: 'Y', description: 'Task Y', command: 'echo y' },
        { id: 'Z', description: 'Task Z', command: 'echo z', dependencies: ['X', 'Y'] },
      ],
    };
    h1.loadAndStart(plan);
    expect(h1.getTask('X')!.status).toBe('running');
    expect(h1.getTask('Y')!.status).toBe('running');
    expect(h1.getTask('Z')!.status).toBe('pending');

    // Simulate restart
    const orchestrator2 = new Orchestrator({
      persistence: h1.persistence,
      messageBus: new InMemoryBus(),
      maxConcurrency: 10,
    });
    orchestrator2.syncAllFromDb();

    // Both X and Y are orphaned running
    const restarted: TaskState[] = [];
    for (const task of orchestrator2.getAllTasks()) {
      if (task.status === 'running') {
        const started = orchestrator2.restartTask(task.id);
        restarted.push(...started.filter(t => t.status === 'running'));
      }
    }

    // Both should be relaunched (task ids are workflow-scoped)
    const restartedLocals = restarted.map((t) => t.id.split('/').pop()!).sort();
    expect(restartedLocals).toEqual(['X', 'Y']);

    // Z should still be pending
    expect(orchestrator2.getTask('Z')?.status).toBe('pending');
  });
});

// ── Flow 8: Restart Workflow with Generation Salt ───────────

describe('Flow 8: restart workflow with generation salt', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('generation bump persists and recreateWorkflow clears branches', () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    // Simulate branches being set
    h.persistence.updateTask('A', {
      execution: { branch: 'experiment/A-gen0hash', workspacePath: '/tmp/worktrees/exec-A' },
    });
    (h.orchestrator as any).refreshFromDb();

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const wfId = h.getTask(mergeId)!.config.workflowId!;

    // Generation starts at 0
    const wf0 = h.persistence.loadWorkflow(wfId);
    expect((wf0 as any)?.generation ?? 0).toBe(0);

    // Bump generation
    h.persistence.updateWorkflow(wfId, { generation: 1 });
    const wf1 = h.persistence.loadWorkflow(wfId);
    expect((wf1 as any).generation).toBe(1);

    // Restart workflow clears all branches
    h.orchestrator.recreateWorkflow(wfId);

    for (const t of h.getAllTasks().filter(t => !t.config.isMergeNode)) {
      expect(t.execution?.branch).toBeUndefined();
      expect(t.execution?.workspacePath).toBeUndefined();
    }

    // Root tasks re-started
    expect(['pending', 'running']).toContain(h.getTask('A')!.status);
    expect(['pending', 'running']).toContain(h.getTask('B')!.status);
  });

  it('recreateWorkflow clears old branch fields so executor gets fresh ones', () => {
    h.loadAndStart(PARALLEL_PLAN);

    h.completeTask('A');
    h.completeTask('B');
    h.completeTask('C');

    // Simulate branches being set
    h.persistence.updateTask('A', {
      execution: { branch: 'experiment/A-oldHash', workspacePath: '/tmp/worktrees/exec-A' },
    });
    h.persistence.updateTask('B', {
      execution: { branch: 'experiment/B-oldHash', workspacePath: '/tmp/worktrees/exec-B' },
    });
    (h.orchestrator as any).refreshFromDb();

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const wfId = h.getTask(mergeId)!.config.workflowId!;

    // Bump generation and restart
    h.persistence.updateWorkflow(wfId, { generation: 2 });
    h.orchestrator.recreateWorkflow(wfId);

    for (const t of h.getAllTasks().filter(t => !t.config.isMergeNode)) {
      expect(t.execution?.branch).toBeUndefined();
      expect(t.execution?.workspacePath).toBeUndefined();
    }

    // Root tasks should be re-started
    expect(['pending', 'running']).toContain(h.getTask('A')!.status);
    expect(['pending', 'running']).toContain(h.getTask('B')!.status);
  });

  it('generation persists through save/load cycle', () => {
    h.loadAndStart(LINEAR_PLAN);

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const wfId = h.getTask(mergeId)!.config.workflowId!;

    // Initially generation is 0
    const wf0 = h.persistence.loadWorkflow(wfId);
    expect((wf0 as any)?.generation ?? 0).toBe(0);

    // Update to 5
    h.persistence.updateWorkflow(wfId, { generation: 5 });

    const wf5 = h.persistence.loadWorkflow(wfId);
    expect((wf5 as any).generation).toBe(5);
  });
});

// ── Flow 9: Manual Merge Mode ───────────────────────────────

const MANUAL_MERGE_PLAN: PlanDefinition = {
  name: 'Manual Merge Plan',
  onFinish: 'merge',
  mergeMode: 'manual',
  baseBranch: 'master',
  featureBranch: 'plan/manual-merge',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
    { id: 'B', description: 'Task B', command: 'echo b' },
  ],
};

describe('Flow 9: manual merge mode', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('merge node enters review_ready after consolidation in manual mode', async () => {
    h.loadAndStart(MANUAL_MERGE_PLAN);

    h.completeTask('A');
    h.completeTask('B');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;
    expect(mergeTask.status).toBe('running');

    await h.executor.executeTasks([mergeTask]);

    // Merge node should be review_ready (not completed)
    expect(h.getTask(mergeId)!.status).toBe('review_ready');

    // Verify git calls: consolidation happened but final merge did not
    const consolidateBranch = h.git.calls.find(c =>
      c[0] === 'checkout' && c[1] === '-b' && c[2] === 'plan/manual-merge',
    );
    expect(consolidateBranch).toBeDefined();

    // No rebase or squash merge (manual only consolidates)
    const rebaseCall = h.git.calls.find(c => c[0] === 'rebase');
    expect(rebaseCall).toBeUndefined();
    const squashCall = h.git.calls.find(c => c[0] === 'merge' && c.includes('--squash'));
    expect(squashCall).toBeUndefined();
  });

  it('approve transitions merge node from review_ready to completed', async () => {
    h.loadAndStart(MANUAL_MERGE_PLAN);

    h.completeTask('A');
    h.completeTask('B');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('review_ready');

    // Clear git history from consolidation phase
    h.git.reset();

    // Approve — hook fires approveMerge automatically for merge nodes
    await h.orchestrator.approve(mergeId);
    expect(h.getTask(mergeId)!.status).toBe('completed');

    // Verify the final squash merge was performed: squash + commit + (update-ref OR ff-only merge)
    const rebaseCall = h.git.calls.find(c => c[0] === 'rebase');
    expect(rebaseCall).toBeUndefined();
    const squashCall = h.git.calls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/manual-merge'));
    expect(squashCall).toBeDefined();
    const commitCall = h.git.calls.find(c => c[0] === 'commit' && c.includes('-m'));
    expect(commitCall).toBeDefined();
    const advancedBase = h.git.calls.find(c =>
      (c[0] === 'update-ref' && c[1] === 'refs/heads/master') ||
      (c[0] === 'merge' && c.includes('--ff-only')),
    );
    expect(advancedBase).toBeDefined();
  });

  it('automatic merge mode performs full merge in merge node', async () => {
    const autoPlan: PlanDefinition = {
      ...MANUAL_MERGE_PLAN,
      name: 'Auto Merge Plan',
      mergeMode: 'automatic',
      featureBranch: 'plan/auto-merge',
    };
    h.loadAndStart(autoPlan);

    h.completeTask('A');
    h.completeTask('B');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    const mergeTask = h.getTask(mergeId)!;

    await h.executor.executeTasks([mergeTask]);
    expect(h.getTask(mergeId)!.status).toBe('completed');

    // Verify git calls include squash merge + commit + (update-ref OR ff-only merge)
    const rebaseCall2 = h.git.calls.find(c => c[0] === 'rebase');
    expect(rebaseCall2).toBeUndefined();
    const squashCall = h.git.calls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/auto-merge'));
    expect(squashCall).toBeDefined();
    const commitCall = h.git.calls.find(c => c[0] === 'commit' && c.includes('-m'));
    expect(commitCall).toBeDefined();
    const advancedBase = h.git.calls.find(c =>
      (c[0] === 'update-ref' && c[1] === 'refs/heads/master') ||
      (c[0] === 'merge' && c.includes('--ff-only')),
    );
    expect(advancedBase).toBeDefined();
  });
});

/** Matches GUI “Manual” + onFinish none — switching to external review must not complete the gate without a PR. */
const MANUAL_MERGE_ONFINISH_NONE_PLAN: PlanDefinition = {
  name: 'Manual OnFinish None',
  onFinish: 'none',
  mergeMode: 'manual',
  baseBranch: 'master',
  featureBranch: 'plan/manual-onfinish-none',
  tasks: [{ id: 'A', description: 'Task A', command: 'echo a' }],
};

// ── Flow 9c: UI external_review merge mode ───────────────────

describe('Flow 9c: set-merge-mode external_review', () => {
  const mockMergeGate: MergeGateProvider = {
    name: 'mock',
    createReview: async () => ({
      url: 'https://github.com/owner/repo/pull/99',
      identifier: 'owner/repo#99',
    }),
    checkApproval: async () => ({
      approved: false,
      rejected: false,
      statusText: 'Open',
      url: 'https://github.com/owner/repo/pull/99',
    }),
  };

  it('switching manual gate to external_review creates PR metadata and persists external_review', async () => {
    const h = createTestHarness({ mergeGateProvider: mockMergeGate });
    h.loadAndStart(MANUAL_MERGE_ONFINISH_NONE_PLAN);
    h.completeTask('A');

    const mergeId = h.getAllTasks().find((t) => t.config.isMergeNode)!.id;
    const wfId = h.getTask(mergeId)!.config.workflowId!;
    await h.executor.executeTasks([h.getTask(mergeId)!]);
    expect(h.getTask(mergeId)!.status).toBe('review_ready');

    await setWorkflowMergeMode(wfId, 'external_review', {
      orchestrator: h.orchestrator,
      persistence: h.persistence,
      taskExecutor: h.executor,
    });

    expect(h.persistence.loadWorkflow(wfId)!.mergeMode).toBe('external_review');
    expect(h.getTask(mergeId)!.status).toBe('review_ready');
    expect(h.getTask(mergeId)!.execution.reviewUrl).toBe('https://github.com/owner/repo/pull/99');
  });
});

// ── Flow 9b: beforeApproveHook ensures merge nodes get git-merged ──────

describe('Flow 9b: beforeApproveHook fires for merge nodes', () => {
  it('without hook: approve transitions state but does NOT perform git merge', async () => {
    const persistence = new InMemoryPersistence();
    const bus = new InMemoryBus();
    const orch = new Orchestrator({ persistence, messageBus: bus, maxConcurrency: 10 });
    const reg = new ExecutorRegistry();
    // Merge nodes now route through the executor pipeline; register a mock
    // that auto-completes so executeMergeNode can handle the finish step.
    reg.register('worktree', { type: 'worktree', start: async (req: any) => { const h = { executionId: `e-${req.actionId}`, taskId: req.actionId, workspacePath: '/tmp/mock', branch: `experiment/${req.actionId}-mock` }; setTimeout(() => (h as any)._cb?.({ requestId: req.requestId, actionId: req.actionId, status: 'completed', outputs: { exitCode: 0 } }), 0); return h; }, onComplete: (_h: any, cb: any) => { _h._cb = cb; return () => {}; }, onOutput: () => () => {}, onHeartbeat: () => () => {}, sendInput: () => {}, kill: async () => {}, getTerminalSpec: () => null, getRestoredTerminalSpec: () => { throw new Error('not impl'); }, destroyAll: async () => {} } as any);
    const exec = new TaskRunner({ orchestrator: orch, persistence: persistence as any, executorRegistry: reg, cwd: '/tmp/test' });
    const git = new MockGit();
    git.install(exec);

    orch.loadPlan(MANUAL_MERGE_PLAN);
    orch.startExecution();
    orch.handleWorkerResponse({
      requestId: 'r1',
      actionId: 'A',
      executionGeneration: orch.getTask('A')?.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    orch.handleWorkerResponse({
      requestId: 'r2',
      actionId: 'B',
      executionGeneration: orch.getTask('B')?.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });

    const mergeId = orch.getAllTasks().find(t => t.config.isMergeNode)!.id;
    await exec.executeTasks([orch.getTask(mergeId)!]);
    expect(orch.getTask(mergeId)!.status).toBe('review_ready');
    git.reset();

    await orch.approve(mergeId);
    expect(orch.getTask(mergeId)!.status).toBe('completed');

    // Without hook: no git merge happens (state transition only)
    expect(git.calls.find(c => c[0] === 'merge' && c.includes('--squash'))).toBeUndefined();
    expect(git.calls.find(c => c[0] === 'commit')).toBeUndefined();
  });

  it('with hook (standard harness): approve performs git merge AND state transition', async () => {
    const h = createTestHarness();
    h.loadAndStart(MANUAL_MERGE_PLAN);
    h.completeTask('A');
    h.completeTask('B');

    const mergeId = h.getAllTasks().find(t => t.config.isMergeNode)!.id;
    await h.executor.executeTasks([h.getTask(mergeId)!]);
    expect(h.getTask(mergeId)!.status).toBe('review_ready');
    h.git.reset();

    await h.orchestrator.approve(mergeId);
    expect(h.getTask(mergeId)!.status).toBe('completed');

    expect(h.git.calls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/manual-merge'))).toBeDefined();
    expect(h.git.calls.find(c => c[0] === 'commit' && c.includes('-m'))).toBeDefined();
    const advancedBase = h.git.calls.find(c =>
      (c[0] === 'update-ref' && c[1] === 'refs/heads/master') ||
      (c[0] === 'merge' && c.includes('--ff-only')),
    );
    expect(advancedBase).toBeDefined();
  });
});

// ── Flow 10: Multi-experiment selection ──────────────────

describe('Flow 10: multi-experiment selection', () => {
  let h: TestHarness;

  const EXPERIMENT_PLAN: PlanDefinition = {
    name: 'Experiment Plan',
    onFinish: 'merge',
    mergeMode: 'automatic',
    baseBranch: 'master',
    featureBranch: 'plan/experiment',
    tasks: [
      { id: 'A', description: 'Pivot task', command: 'echo pivot', pivot: true },
      { id: 'B', description: 'Downstream', command: 'echo down', dependencies: ['A'] },
    ],
  };

  beforeEach(() => {
    h = createTestHarness();
  });

  it('multi-select experiment flow completes reconciliation and unblocks downstream', async () => {
    h.loadAndStart(EXPERIMENT_PLAN);

    // A spawns experiments
    h.orchestrator.handleWorkerResponse({
      requestId: 'spawn-A',
      actionId: 'A',
      executionGeneration: h.getTask('A')?.execution.generation ?? 0,
      status: 'spawn_experiments' as const,
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: 'Try approaches',
          variants: [
            { id: 'v1', description: 'V1', prompt: 'Try A' },
            { id: 'v2', description: 'V2', prompt: 'Try B' },
            { id: 'v3', description: 'V3', prompt: 'Try C' },
          ],
        },
      },
    });

    // Complete all experiments with branches
    const expIds = h.getAllTasks()
      .filter((t) => t.id.includes('/A-exp-'))
      .map(t => t.id);
    expect(expIds).toHaveLength(3);

    for (const id of expIds) {
      h.completeTask(id);
      h.persistence.updateTask(id, {
        execution: { branch: `experiment/${id}-hash`, commit: `commit-${id}` },
      });
    }
    (h.orchestrator as any).refreshFromDb();

    let reconTask = h.getAllTasks().find(t => t.id.includes('reconciliation'));
    expect(reconTask).toBeDefined();
    if (reconTask!.status === 'running') {
      await h.executor.executeTasks([reconTask!]);
    }
    reconTask = h.getTask(reconTask!.id)!;
    expect(['needs_input', 'awaiting_approval']).toContain(reconTask.status);

    // Multi-select: pick v1 and v3
    const selectedIds = [expIds[0], expIds[2]];
    const started = h.orchestrator.selectExperiments(
      reconTask!.id,
      selectedIds,
      'reconciliation/combined',
      'combined-commit',
    );

    // Reconciliation completed
    const reconAfter = h.getTask(reconTask!.id)!;
    expect(reconAfter.status).toBe('completed');
    expect(reconAfter.execution.selectedExperiments).toEqual(selectedIds);
    expect(reconAfter.execution.branch).toBe('reconciliation/combined');

    // Downstream B (original, remapped in-place) should be running
    const b = h.getTask('B')!;
    expect(b.status).toBe('running');
  });

  it('multi-select branch propagation: downstream sees combined reconciliation branch', () => {
    h.loadAndStart(EXPERIMENT_PLAN);

    h.orchestrator.handleWorkerResponse({
      requestId: 'spawn-A',
      actionId: 'A',
      executionGeneration: h.getTask('A')?.execution.generation ?? 0,
      status: 'spawn_experiments' as const,
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: 'Try',
          variants: [
            { id: 'v1', description: 'V1', prompt: 'A' },
            { id: 'v2', description: 'V2', prompt: 'B' },
          ],
        },
      },
    });

    const expIds = h.getAllTasks()
      .filter((t) => t.id.includes('/A-exp-'))
      .map(t => t.id);

    for (const id of expIds) {
      h.completeTask(id);
      h.persistence.updateTask(id, {
        execution: { branch: `experiment/${id}-hash`, commit: `commit-${id}` },
      });
    }
    (h.orchestrator as any).refreshFromDb();

    const reconTask = h.getAllTasks().find(t => t.id.includes('reconciliation'))!;

    h.orchestrator.selectExperiments(
      reconTask.id,
      expIds,
      'reconciliation/combined-branch',
      'combined-hash',
    );

    // Downstream B (original, remapped in-place) should see the combined branch
    const b = h.getTask('B')!;
    const branches = h.executor.collectUpstreamBranches(b);
    expect(branches).toContain('reconciliation/combined-branch');
  });
});

// ── Flow: Scheduler health across experiment lifecycle ───────

describe('Flow: scheduler health across experiment lifecycle', () => {
  let h: TestHarness;

  const EXPERIMENT_PLAN: PlanDefinition = {
    name: 'Scheduler Health Plan',
    onFinish: 'merge',
    mergeMode: 'automatic',
    baseBranch: 'master',
    featureBranch: 'plan/scheduler-health',
    tasks: [
      { id: 'A', description: 'Pivot task', command: 'echo pivot', pivot: true },
      { id: 'B', description: 'Downstream', command: 'echo down', dependencies: ['A'] },
    ],
  };

  beforeEach(() => {
    h = createTestHarness();
  });

  function getSchedulerStatus(orchestrator: any) {
    return orchestrator.getQueueStatus();
  }

  it('multi-select experiment -> downstream tasks execute with healthy scheduler', async () => {
    h.loadAndStart(EXPERIMENT_PLAN);

    h.orchestrator.handleWorkerResponse({
      requestId: 'spawn-A',
      actionId: 'A',
      executionGeneration: h.getTask('A')?.execution.generation ?? 0,
      status: 'spawn_experiments' as const,
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: 'Try',
          variants: [
            { id: 'v1', description: 'V1', prompt: 'A' },
            { id: 'v2', description: 'V2', prompt: 'B' },
          ],
        },
      },
    });

    const expIds = h.getAllTasks()
      .filter((t) => t.id.includes('/A-exp-'))
      .map(t => t.id);

    for (const id of expIds) {
      h.completeTask(id);
      h.persistence.updateTask(id, {
        execution: { branch: `experiment/${id}-hash`, commit: `commit-${id}` },
      });
    }
    (h.orchestrator as any).refreshFromDb();

    let reconTask = h.getAllTasks().find(t => t.id.includes('reconciliation'))!;
    if (reconTask.status === 'running') {
      await h.executor.executeTasks([reconTask]);
    }
    reconTask = h.getTask(reconTask.id)!;
    expect(['needs_input', 'awaiting_approval']).toContain(reconTask.status);

    const started = h.orchestrator.selectExperiments(
      reconTask.id,
      expIds,
      'reconciliation/combined',
      'combined-commit',
    );

    // Scheduler should be healthy
    const status = getSchedulerStatus(h.orchestrator);
    const runningTasks = h.getAllTasks().filter(t => t.status === 'running');
    expect(status.runningCount).toBe(runningTasks.length);

    // Downstream should have started
    expect(started.length).toBeGreaterThan(0);
  });

  it('scheduler recovers from leaked slot during experiment selection', () => {
    h.loadAndStart(EXPERIMENT_PLAN);

    h.orchestrator.handleWorkerResponse({
      requestId: 'spawn-A',
      actionId: 'A',
      executionGeneration: h.getTask('A')?.execution.generation ?? 0,
      status: 'spawn_experiments' as const,
      outputs: { exitCode: 0 },
      dagMutation: {
        spawnExperiments: {
          description: 'Try',
          variants: [
            { id: 'v1', description: 'V1', prompt: 'A' },
            { id: 'v2', description: 'V2', prompt: 'B' },
          ],
        },
      },
    });

    const expIds = h.getAllTasks()
      .filter((t) => t.id.includes('/A-exp-'))
      .map(t => t.id);

    for (const id of expIds) {
      h.completeTask(id);
      h.persistence.updateTask(id, {
        execution: { branch: `experiment/${id}-hash`, commit: `commit-${id}` },
      });
    }
    (h.orchestrator as any).refreshFromDb();

    // Inject a leaked scheduler slot by manually adding a fake running task.
    // The persisted queue view should ignore it even if the helper scheduler
    // still has stale in-memory state.
    const scheduler = (h.orchestrator as any).scheduler;
    scheduler.enqueue({ taskId: 'phantom-leaked', priority: 1 });
    scheduler.dequeue(); // moves phantom to running set
    expect(scheduler.isRunning('phantom-leaked')).toBe(true);

    const reconTask = h.getAllTasks().find(t => t.id.includes('reconciliation'))!;
    h.orchestrator.selectExperiments(
      reconTask.id,
      expIds,
      'reconciliation/combined',
      'combined-commit',
    );

    const queueStatus = h.orchestrator.getQueueStatus();
    expect(queueStatus.running.some((item: { taskId: string }) => item.taskId === 'phantom-leaked')).toBe(false);
    const runningTasks = h.getAllTasks().filter(t => t.status === 'running');
    expect(queueStatus.runningCount).toBe(runningTasks.length);
  });

  it('process-dies-silently: orphaned running task does not permanently block scheduler', () => {
    h.loadAndStart({
      name: 'Process Death Plan',
      onFinish: 'none',
      tasks: [
        { id: 'A', description: 'Task A', command: 'echo a' },
        { id: 'B', description: 'Task B', command: 'echo b' },
        { id: 'C', description: 'Task C', command: 'echo c', dependencies: ['A'] },
      ],
    });

    expect(h.getTask('A')!.status).toBe('running');
    expect(h.getTask('B')!.status).toBe('running');

    // Simulate process death: A's process died, but the scheduler still thinks it's running.
    // We update DB to mark it as pending (as stale-running detection would do before restart).
    h.persistence.updateTask('A', { status: 'pending', execution: {} });
    const wfId = h.orchestrator.getWorkflowIds()[0];
    h.orchestrator.syncFromDb(wfId);

    // The scheduler still has a slot for A (leaked). restartTask triggers drainScheduler.
    const restarted = h.orchestrator.restartTask('A');
    expect(h.getTask('A')!.status).toBe('running');

    // Scheduler should be healthy
    const status = getSchedulerStatus(h.orchestrator);
    const runningTasks = h.getAllTasks().filter(t => t.status === 'running');
    expect(status.runningCount).toBe(runningTasks.length);
  });
});
