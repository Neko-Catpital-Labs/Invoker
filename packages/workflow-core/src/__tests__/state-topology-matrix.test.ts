/**
 * State × Topology matrix tests.
 *
 * Tests every meaningful combination of state transitions across
 * diamond, fork, join, butterfly, and mesh topologies. Pure orchestrator
 * state machine — no executor, no git.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator, TopologyForkRequired } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskStateChanges, Attempt } from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';
import { MUTATION_POLICIES } from '../invalidation-policy.js';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();
  private attempts = new Map<string, Attempt[]>();

  saveWorkflow(workflow: { id: string; name: string; status: string }): void {
    const now = new Date().toISOString();
    this.workflows.set(workflow.id, { ...workflow, createdAt: now, updatedAt: now });
  }

  updateWorkflow(workflowId: string, changes: { status?: string }): void {
    const wf = this.workflows.get(workflowId);
    if (wf && changes.status) wf.status = changes.status;
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

  logEvent(): void {}

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

// ── In-Memory MessageBus Mock ───────────────────────────────

class InMemoryBus implements OrchestratorMessageBus {
  published: Array<{ channel: string; message: unknown }> = [];

  publish<T>(channel: string, message: T): void {
    this.published.push({ channel, message });
  }
}

// ── Topology plan builders ──────────────────────────────────

function diamondPlan(): PlanDefinition {
  return {
    name: 'diamond',
    tasks: [
      { id: 'A', description: 'Root', command: 'echo A' },
      { id: 'B', description: 'Left', command: 'echo B', dependencies: ['A'] },
      { id: 'C', description: 'Right', command: 'echo C', dependencies: ['A'] },
      { id: 'D', description: 'Join', command: 'echo D', dependencies: ['B', 'C'] },
    ],
  };
}

function forkPlan(): PlanDefinition {
  return {
    name: 'fork',
    tasks: [
      { id: 'A', description: 'Root', command: 'echo A' },
      { id: 'B', description: 'Left', command: 'echo B', dependencies: ['A'] },
      { id: 'C', description: 'Right', command: 'echo C', dependencies: ['A'] },
    ],
  };
}

function joinPlan(): PlanDefinition {
  return {
    name: 'join',
    tasks: [
      { id: 'A', description: 'Left', command: 'echo A' },
      { id: 'B', description: 'Right', command: 'echo B' },
      { id: 'C', description: 'Join', command: 'echo C', dependencies: ['A', 'B'] },
    ],
  };
}

function butterflyPlan(): PlanDefinition {
  return {
    name: 'butterfly',
    tasks: [
      { id: 'A', description: 'Root', command: 'echo A' },
      { id: 'B', description: 'Left1', command: 'echo B', dependencies: ['A'] },
      { id: 'C', description: 'Right1', command: 'echo C', dependencies: ['A'] },
      { id: 'D', description: 'Mid', command: 'echo D', dependencies: ['B', 'C'] },
      { id: 'E', description: 'Left2', command: 'echo E', dependencies: ['D'] },
      { id: 'F', description: 'Right2', command: 'echo F', dependencies: ['D'] },
      { id: 'G', description: 'Tail', command: 'echo G', dependencies: ['E', 'F'] },
    ],
  };
}

function meshPlan(): PlanDefinition {
  return {
    name: 'mesh',
    tasks: [
      { id: 'A', description: 'Source1', command: 'echo A' },
      { id: 'B', description: 'Source2', command: 'echo B' },
      { id: 'C', description: 'Sink1', command: 'echo C', dependencies: ['A', 'B'] },
      { id: 'D', description: 'Sink2', command: 'echo D', dependencies: ['A', 'B'] },
    ],
  };
}

// ── Response helpers ────────────────────────────────────────

let activeOrchestrator: Orchestrator | null = null;

function generationFor(actionId: string): number {
  return activeOrchestrator?.getTask(actionId)?.execution.generation ?? 0;
}

function complete(actionId: string, extras?: Partial<WorkResponse['outputs']>): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration: generationFor(actionId),
    status: 'completed',
    outputs: { exitCode: 0, ...extras },
  };
}

function fail(actionId: string, error = 'task failed'): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration: generationFor(actionId),
    status: 'failed',
    outputs: { exitCode: 1, error },
  };
}

function needsInput(actionId: string, prompt = 'Enter value'): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration: generationFor(actionId),
    status: 'needs_input',
    outputs: { prompt },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('State × Topology Matrix', () => {
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
    activeOrchestrator = orchestrator;
  });

  // ── Diamond: A→{B,C}→D ─────────────────────────────────

  describe('diamond topology: A→{B,C}→D', () => {
    it('B fails → D stays pending, C unaffected', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));

      expect(orchestrator.getTask('D')!.status).toBe('pending');
      expect(orchestrator.getTask('C')!.status).toBe('completed');
    });

    it('B fails and restarts → after B and C complete, D starts', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.restartTask('B');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.handleWorkerResponse(complete('B'));
      expect(orchestrator.getTask('D')!.status).toBe('running');
    });

    it('B and C both fail → D stays pending', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.handleWorkerResponse(fail('C'));
      expect(orchestrator.getTask('D')!.status).toBe('pending');
    });

    it('B and C both fail → restart B only → D still pending (C still failed)', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      orchestrator.handleWorkerResponse(fail('C'));

      orchestrator.restartTask('B');
      orchestrator.handleWorkerResponse(complete('B'));

      expect(orchestrator.getTask('D')!.status).toBe('pending');
    });

    it('all complete → restart B → D is invalidated to pending', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(complete('D'));

      orchestrator.restartTask('B');

      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('D')!.status).toBe('pending');
    });

    it('all complete → editTaskCommand on A → A restarts and downstream is invalidated', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(complete('D'));

      orchestrator.editTaskCommand('A', 'echo A-v2');

      // A restarts with new command
      expect(orchestrator.getTask('A')!.status).toBe('running');
      expect(orchestrator.getTask('A')!.config.command).toBe('echo A-v2');

      // Downstream tasks are invalidated to pending (no fork, no stale clones)
      expect(orchestrator.getTask('B')!.status).toBe('pending');
      expect(orchestrator.getTask('C')!.status).toBe('pending');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      // No clones created
      const allTasks = orchestrator.getAllTasks();
      expect(allTasks.find((t) => t.id === 'B-v2')).toBeUndefined();
      expect(allTasks.find((t) => t.id === 'C-v2')).toBeUndefined();
      expect(allTasks.find((t) => t.id === 'D-v2')).toBeUndefined();
    });

    it('matrix entry: executor-type edit is retry-class / task scope (root + descendants get gen bump; root branch/workspacePath preserved)', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(complete('D'));

      // Hydrate workspace lineage on the root so the preservation half
      // of the assertion is meaningful (the in-memory persistence mock
      // does not write branch/workspacePath itself for completed work).
      // `editTaskType()` calls `refreshFromDb()` internally, which
      // re-loads from the persistence mock — no manual sync needed.
      // Tasks in the matrix tests are persisted under their fully-qualified
      // `<workflowId>/<bareId>` key (e.g. `wf-test-N/A`), even though
      // `orchestrator.getTask('A')` accepts the bare id via state-machine
      // resolution. Find the persisted key for `A` so the seed actually
      // updates the right entry.
      const persistedAKey = Array.from(persistence.tasks.keys()).find(
        (k) => k === 'A' || k.endsWith('/A'),
      );
      if (!persistedAKey) throw new Error('Test setup: could not find persisted key for task A');
      persistence.updateTask(persistedAKey, {
        execution: {
          branch: 'experiment/preserved-branch',
          commit: 'cafef00d',
          workspacePath: '/tmp/preserved-workspace',
        },
      });

      const genBefore = {
        A: orchestrator.getTask('A')!.execution.generation ?? 0,
        B: orchestrator.getTask('B')!.execution.generation ?? 0,
        C: orchestrator.getTask('C')!.execution.generation ?? 0,
        D: orchestrator.getTask('D')!.execution.generation ?? 0,
      };

      orchestrator.editTaskType('A', 'worktree');

      const genAfter = {
        A: orchestrator.getTask('A')!.execution.generation ?? 0,
        B: orchestrator.getTask('B')!.execution.generation ?? 0,
        C: orchestrator.getTask('C')!.execution.generation ?? 0,
        D: orchestrator.getTask('D')!.execution.generation ?? 0,
      };

      // ── Task-scope generation bump (root + transitive dependents). ──
      expect(genAfter.A).toBe(genBefore.A + 1);
      expect(genAfter.B).toBe(genBefore.B + 1);
      expect(genAfter.C).toBe(genBefore.C + 1);
      expect(genAfter.D).toBe(genBefore.D + 1);

      const rootAfter = orchestrator.getTask('A')!;
      expect(rootAfter.config.executorType).toBe('worktree');
      expect(rootAfter.execution.branch).toBe('experiment/preserved-branch');
      expect(rootAfter.execution.workspacePath).toBe('/tmp/preserved-workspace');
    });

    it('matrix entry: command edit is recreate-class / task scope (root + descendants get gen bump)', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(complete('D'));

      const genBefore = {
        A: orchestrator.getTask('A')!.execution.generation ?? 0,
        B: orchestrator.getTask('B')!.execution.generation ?? 0,
        C: orchestrator.getTask('C')!.execution.generation ?? 0,
        D: orchestrator.getTask('D')!.execution.generation ?? 0,
      };

      orchestrator.editTaskCommand('A', 'echo A-v2');

      const genAfter = {
        A: orchestrator.getTask('A')!.execution.generation ?? 0,
        B: orchestrator.getTask('B')!.execution.generation ?? 0,
        C: orchestrator.getTask('C')!.execution.generation ?? 0,
        D: orchestrator.getTask('D')!.execution.generation ?? 0,
      };

      // Task scope: root + transitive dependents within the same workflow.
      expect(genAfter.A).toBe(genBefore.A + 1);
      expect(genAfter.B).toBe(genBefore.B + 1);
      expect(genAfter.C).toBe(genBefore.C + 1);
      expect(genAfter.D).toBe(genBefore.D + 1);
    });
  });

  // ── Fork: A→{B,C} ──────────────────────────────────────

  describe('fork topology: A→{B,C}', () => {
    it('root A fails → both B and C stay pending', () => {
      orchestrator.loadPlan(forkPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));

      expect(orchestrator.getTask('B')!.status).toBe('pending');
      expect(orchestrator.getTask('C')!.status).toBe('pending');
    });

    it('root A fails, restart A, complete A → B and C both start', () => {
      orchestrator.loadPlan(forkPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));
      expect(orchestrator.getTask('B')!.status).toBe('pending');

      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(complete('A'));

      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('C')!.status).toBe('running');
    });
  });

  // ── Join: {A,B}→C ──────────────────────────────────────

  describe('join topology: {A,B}→C', () => {
    it('A completes, B fails → C stays pending → restart B, complete B → C starts', () => {
      orchestrator.loadPlan(joinPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      orchestrator.restartTask('B');
      orchestrator.handleWorkerResponse(complete('B'));

      expect(orchestrator.getTask('C')!.status).toBe('running');
    });

    it('A and B both fail → C stays pending → restart both → C starts', () => {
      orchestrator.loadPlan(joinPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      orchestrator.restartTask('A');
      orchestrator.restartTask('B');

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));

      expect(orchestrator.getTask('C')!.status).toBe('running');
    });
  });

  // ── Butterfly: A→{B,C}→D→{E,F}→G ──────────────────────

  describe('butterfly topology: A→{B,C}→D→{E,F}→G', () => {
    it('full lifecycle: all tasks complete in topological order', () => {
      orchestrator.loadPlan(butterflyPlan());
      orchestrator.startExecution();

      expect(orchestrator.getTask('A')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('A'));
      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('C')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      expect(orchestrator.getTask('D')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('D'));
      expect(orchestrator.getTask('E')!.status).toBe('running');
      expect(orchestrator.getTask('F')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('E'));
      orchestrator.handleWorkerResponse(complete('F'));
      expect(orchestrator.getTask('G')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('G'));

      const userTasks = orchestrator.getAllTasks().filter((t) => !t.config.isMergeNode);
      for (const t of userTasks) {
        expect(t.status).toBe('completed');
      }
    });

    it('B fails → D,E,F,G stay pending → restart B → cascade unblocks', () => {
      orchestrator.loadPlan(butterflyPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));

      expect(orchestrator.getTask('D')!.status).toBe('pending');
      expect(orchestrator.getTask('E')!.status).toBe('pending');
      expect(orchestrator.getTask('F')!.status).toBe('pending');
      expect(orchestrator.getTask('G')!.status).toBe('pending');

      orchestrator.restartTask('B');
      orchestrator.handleWorkerResponse(complete('B'));
      expect(orchestrator.getTask('D')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('D'));
      expect(orchestrator.getTask('E')!.status).toBe('running');
      expect(orchestrator.getTask('F')!.status).toBe('running');
    });

    it('D fails → E,F,G stay pending but B,C unaffected', () => {
      orchestrator.loadPlan(butterflyPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('D'));

      expect(orchestrator.getTask('E')!.status).toBe('pending');
      expect(orchestrator.getTask('F')!.status).toBe('pending');
      expect(orchestrator.getTask('G')!.status).toBe('pending');

      expect(orchestrator.getTask('B')!.status).toBe('completed');
      expect(orchestrator.getTask('C')!.status).toBe('completed');
    });
  });

  // ── Mesh: {A,B}→{C,D} ─────────────────────────────────

  describe('mesh topology: {A,B}→{C,D}', () => {
    it('A fails → C and D stay pending', () => {
      orchestrator.loadPlan(meshPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(fail('A'));

      expect(orchestrator.getTask('C')!.status).toBe('pending');
      expect(orchestrator.getTask('D')!.status).toBe('pending');
    });

    it('A and B both fail → restart A only → C,D still pending (B still failed)', () => {
      orchestrator.loadPlan(meshPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));
      orchestrator.handleWorkerResponse(fail('B'));

      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(complete('A'));

      expect(orchestrator.getTask('C')!.status).toBe('pending');
      expect(orchestrator.getTask('D')!.status).toBe('pending');
    });
  });

  // ── Special states in topologies ───────────────────────

  describe('special states in diamond', () => {
    it('B transitions to needs_input → D waits, C completes, D still waits for B', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(needsInput('B'));

      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.provideInput('B', 'some value');
      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.handleWorkerResponse(complete('B'));
      expect(orchestrator.getTask('D')!.status).toBe('running');
    });

    it('B gets awaiting_approval → approve after C completes → D starts', async () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.setTaskAwaitingApproval('B');

      expect(orchestrator.getTask('B')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      await orchestrator.approve('B');
      expect(orchestrator.getTask('B')!.status).toBe('completed');
      expect(orchestrator.getTask('D')!.status).toBe('running');
    });
  });

  describe('edit in fork topology', () => {
    it('edit completed root A → A restarts with new command, B and C invalidated', () => {
      orchestrator.loadPlan(forkPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));

      orchestrator.editTaskCommand('A', 'echo A-v2');

      // A restarts with new command
      expect(orchestrator.getTask('A')!.status).toBe('running');
      expect(orchestrator.getTask('A')!.config.command).toBe('echo A-v2');

      // Downstream is invalidated to pending (no fork, no stale clones)
      expect(orchestrator.getTask('B')!.status).toBe('pending');
      expect(orchestrator.getTask('C')!.status).toBe('pending');

      // No clones created
      const allTasks = orchestrator.getAllTasks();
      expect(allTasks.find((t) => t.id === 'B-v2')).toBeUndefined();
      expect(allTasks.find((t) => t.id === 'C-v2')).toBeUndefined();
    });
  });

  // Step 11 (`docs/architecture/task-invalidation-roadmap.md`):
  // The chart's Decision Table row "Change graph topology" is the lone
  // **fork-class** / workflow-scope row. Unlike Steps 2–10 (per-mutation
  // routes that resolve to retry/recreate × task scope), topology
  // mutations CANNOT be applied in place on a live workflow — they must
  // create a new workflow fork rooted from the offending node/result.
  // Step 12 wires the matching `forkWorkflow*` lifecycle dep; Step 11
  // surfaces the gate via `Orchestrator.replaceTask` and the
  // `MUTATION_POLICIES.topology` policy entry.
  //
  // The matrix asserts two distinct invariants compared to every
  // earlier (per-attribute) entry:
  //
  //   1. **Policy classification.** `MUTATION_POLICIES.topology` is
  //      the only entry whose `action` is `'workflowFork'`. All other
  //      spec-changing entries route to retry/recreate × task or
  //      workflow scope. This is what makes "graph topology" a
  //      first-class fork-class entry rather than a special-cased
  //      restart.
  //
  //   2. **Live-workflow gating.** `Orchestrator.replaceTask` now
  //      throws `TopologyForkRequired` whenever any non-merge task in
  //      the same workflow is in a live status, surfacing both the
  //      workflow id and the offending task id so the caller can
  //      route the request to the (Step 12) fork API. In-place
  //      remains permitted on a fully terminal workflow because there
  //      is no in-flight work to race with.
  describe('graph topology is fork-class / workflow scope', () => {
    it('MUTATION_POLICIES.topology classifies the row as fork-class / workflow scope', () => {
      const policy = MUTATION_POLICIES.topology;
      expect(policy).toBeDefined();
      expect(policy.action).toBe('workflowFork');
      expect(policy.invalidatesExecutionSpec).toBe(true);
      expect(policy.invalidateIfActive).toBe(true);
    });

    it('topology is the only fork-class entry in the policy table', () => {
      const forkEntries = Object.entries(MUTATION_POLICIES).filter(
        ([, p]) => p.action === 'workflowFork',
      );
      expect(forkEntries.map(([k]) => k)).toEqual(['topology']);
    });

    it('replaceTask throws TopologyForkRequired on a live diamond workflow', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));
      // D is `pending` (blocked by failed B) — workflow is live.

      const bTask = orchestrator.getTask('B')!;
      const wfId = bTask.config.workflowId!;
      const scopedBId = bTask.id;

      let caught: unknown;
      try {
        orchestrator.replaceTask('B', [
          { id: 'B-fix', description: 'Fix B', command: 'echo fix' },
        ]);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TopologyForkRequired);
      const err = caught as TopologyForkRequired;
      expect(err.workflowId).toBe(wfId);
      expect(err.taskId).toBe(scopedBId);

      // No in-place mutation: B stays failed, no replacement node was
      // created, and the merge gate's deps are unchanged.
      expect(orchestrator.getTask('B')!.status).toBe('failed');
      expect(orchestrator.getTask('B-fix')).toBeUndefined();
    });

    it('replaceTask succeeds in place on a terminal diamond workflow', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));
      // Cancel D so the workflow has no live non-merge tasks.
      orchestrator.cancelTask('D');

      orchestrator.replaceTask('B', [
        { id: 'B-fix', description: 'Fix B', command: 'echo fix' },
      ]);

      // B is staled and the replacement node now exists.
      expect(orchestrator.getTask('B')!.status).toBe('stale');
      expect(orchestrator.getTask('B-fix')).toBeDefined();
    });
  });
});
