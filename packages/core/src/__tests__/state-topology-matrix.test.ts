/**
 * State × Topology matrix tests.
 *
 * Tests every meaningful combination of state transitions across
 * diamond, fork, join, butterfly, and mesh topologies. Pure orchestrator
 * state machine — no executor, no git.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskStateChanges } from '../task-types.js';
import type { WorkResponse } from '@invoker/protocol';

// ── In-Memory Persistence Mock ──────────────────────────────

class InMemoryPersistence implements OrchestratorPersistence {
  workflows = new Map<string, { id: string; name: string; status: string; createdAt: string; updatedAt: string }>();
  tasks = new Map<string, { workflowId: string; task: TaskState }>();

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

function complete(actionId: string, extras?: Partial<WorkResponse['outputs']>): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    status: 'completed',
    outputs: { exitCode: 0, ...extras },
  };
}

function fail(actionId: string, error = 'task failed'): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    status: 'failed',
    outputs: { exitCode: 1, error },
  };
}

function needsInput(actionId: string, prompt = 'Enter value'): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
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
  });

  // ── Diamond: A→{B,C}→D ─────────────────────────────────

  describe('diamond topology: A→{B,C}→D', () => {
    it('B fails → D blocked, C unaffected', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));

      expect(orchestrator.getTask('D')!.status).toBe('blocked');
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('B');
      expect(orchestrator.getTask('C')!.status).toBe('completed');
    });

    it('B fails and restarts → after B and C complete, D starts', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('D')!.status).toBe('blocked');

      orchestrator.restartTask('B');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.handleWorkerResponse(complete('B'));
      expect(orchestrator.getTask('D')!.status).toBe('running');
    });

    it('B and C both fail → D.blockedBy is the last failure', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('B');

      orchestrator.handleWorkerResponse(fail('C'));
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('C');
    });

    it('B and C both fail → restart B only → D still blocked by C', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      orchestrator.handleWorkerResponse(fail('C'));

      orchestrator.restartTask('B');

      expect(orchestrator.getTask('D')!.status).toBe('blocked');
      expect(orchestrator.getTask('D')!.execution.blockedBy).toBe('C');
    });

    it('all complete → restart B → D stays completed (no auto-invalidation)', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(complete('D'));

      orchestrator.restartTask('B');

      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('D')!.status).toBe('completed');
    });

    it('all complete → editTaskCommand on A → B, C, D become stale, clones created', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(complete('D'));

      orchestrator.editTaskCommand('A', 'echo A-v2');

      expect(orchestrator.getTask('B')!.status).toBe('stale');
      expect(orchestrator.getTask('C')!.status).toBe('stale');
      expect(orchestrator.getTask('D')!.status).toBe('stale');

      const allTasks = orchestrator.getAllTasks();
      const cloneB = allTasks.find((t) => t.id === 'B-v2');
      const cloneC = allTasks.find((t) => t.id === 'C-v2');
      const cloneD = allTasks.find((t) => t.id === 'D-v2');

      expect(cloneB).toBeDefined();
      expect(cloneC).toBeDefined();
      expect(cloneD).toBeDefined();
      expect(cloneD!.dependencies).toContain('B-v2');
      expect(cloneD!.dependencies).toContain('C-v2');
    });
  });

  // ── Fork: A→{B,C} ──────────────────────────────────────

  describe('fork topology: A→{B,C}', () => {
    it('root A fails → both B and C blocked', () => {
      orchestrator.loadPlan(forkPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));

      expect(orchestrator.getTask('B')!.status).toBe('blocked');
      expect(orchestrator.getTask('C')!.status).toBe('blocked');
    });

    it('root A fails, restart A, complete A → B and C both start', () => {
      orchestrator.loadPlan(forkPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));
      expect(orchestrator.getTask('B')!.status).toBe('blocked');

      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(complete('A'));

      expect(orchestrator.getTask('B')!.status).toBe('running');
      expect(orchestrator.getTask('C')!.status).toBe('running');
    });
  });

  // ── Join: {A,B}→C ──────────────────────────────────────

  describe('join topology: {A,B}→C', () => {
    it('A completes, B fails → C blocked → restart B, complete B → C starts', () => {
      orchestrator.loadPlan(joinPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('C')!.status).toBe('blocked');

      orchestrator.restartTask('B');
      orchestrator.handleWorkerResponse(complete('B'));

      expect(orchestrator.getTask('C')!.status).toBe('running');
    });

    it('A and B both fail → C.blockedBy overwritten → restart both → C starts', () => {
      orchestrator.loadPlan(joinPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));
      orchestrator.handleWorkerResponse(fail('B'));
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('B');

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

    it('B fails → D,E,F,G all blocked → restart B → cascade unblocks', () => {
      orchestrator.loadPlan(butterflyPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('B'));

      expect(orchestrator.getTask('D')!.status).toBe('blocked');
      expect(orchestrator.getTask('E')!.status).toBe('blocked');
      expect(orchestrator.getTask('F')!.status).toBe('blocked');
      expect(orchestrator.getTask('G')!.status).toBe('blocked');

      orchestrator.restartTask('B');
      orchestrator.handleWorkerResponse(complete('B'));
      expect(orchestrator.getTask('D')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('D'));
      expect(orchestrator.getTask('E')!.status).toBe('running');
      expect(orchestrator.getTask('F')!.status).toBe('running');
    });

    it('D fails → E,F,G blocked but B,C unaffected', () => {
      orchestrator.loadPlan(butterflyPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.handleWorkerResponse(fail('D'));

      expect(orchestrator.getTask('E')!.status).toBe('blocked');
      expect(orchestrator.getTask('F')!.status).toBe('blocked');
      expect(orchestrator.getTask('G')!.status).toBe('blocked');

      expect(orchestrator.getTask('B')!.status).toBe('completed');
      expect(orchestrator.getTask('C')!.status).toBe('completed');
    });
  });

  // ── Mesh: {A,B}→{C,D} ─────────────────────────────────

  describe('mesh topology: {A,B}→{C,D}', () => {
    it('A fails → C and D both blocked', () => {
      orchestrator.loadPlan(meshPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(fail('A'));

      expect(orchestrator.getTask('C')!.status).toBe('blocked');
      expect(orchestrator.getTask('D')!.status).toBe('blocked');
    });

    it('A and B both fail → restart A only → C,D still blocked by B', () => {
      orchestrator.loadPlan(meshPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(fail('A'));
      orchestrator.handleWorkerResponse(fail('B'));

      orchestrator.restartTask('A');
      orchestrator.handleWorkerResponse(complete('A'));

      expect(orchestrator.getTask('C')!.status).toBe('blocked');
      expect(orchestrator.getTask('D')!.status).toBe('blocked');
      expect(orchestrator.getTask('C')!.execution.blockedBy).toBe('B');
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

    it('B gets awaiting_approval → approve after C completes → D starts', () => {
      orchestrator.loadPlan(diamondPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));
      orchestrator.setTaskAwaitingApproval('B');

      expect(orchestrator.getTask('B')!.status).toBe('awaiting_approval');
      expect(orchestrator.getTask('D')!.status).toBe('pending');

      orchestrator.approve('B');
      expect(orchestrator.getTask('B')!.status).toBe('completed');
      expect(orchestrator.getTask('D')!.status).toBe('running');
    });
  });

  describe('edit in fork topology', () => {
    it('edit completed root A → B and C become stale, clones created', () => {
      orchestrator.loadPlan(forkPlan());
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));

      orchestrator.editTaskCommand('A', 'echo A-v2');

      expect(orchestrator.getTask('B')!.status).toBe('stale');
      expect(orchestrator.getTask('C')!.status).toBe('stale');

      const allTasks = orchestrator.getAllTasks();
      const cloneB = allTasks.find((t) => t.id === 'B-v2');
      const cloneC = allTasks.find((t) => t.id === 'C-v2');
      expect(cloneB).toBeDefined();
      expect(cloneC).toBeDefined();
      expect(cloneB!.dependencies).toContain('A');
    });
  });
});
