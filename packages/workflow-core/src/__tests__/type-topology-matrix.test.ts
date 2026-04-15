/**
 * Type × Topology matrix tests.
 *
 * Tests experiment/reconciliation/claude behavior across fork, diamond,
 * and chain topologies. Pure orchestrator state machine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { reconciliationNeedsInputWorkResponse } from './reconciliation-needs-input-shim.js';
import { rid, sid } from './scoped-test-helpers.js';
import { Orchestrator } from '../orchestrator.js';
import type { PlanDefinition, OrchestratorPersistence, OrchestratorMessageBus } from '../orchestrator.js';
import type { TaskState, TaskStateChanges , Attempt} from '../task-types.js';
import type { WorkResponse } from '@invoker/contracts';

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

function spawnResponse(
  actionId: string,
  variants: Array<{ id: string; description: string; prompt?: string }>,
): WorkResponse {
  return {
    requestId: `req-${actionId}`,
    actionId,
    executionGeneration: generationFor(actionId),
    status: 'spawn_experiments',
    outputs: { exitCode: 0 },
    dagMutation: {
      spawnExperiments: {
        description: `Variants for ${actionId}`,
        variants: variants.map((v) => ({
          id: v.id,
          description: v.description,
          prompt: v.prompt ?? `Try ${v.id}`,
        })),
      },
    },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('Type × Topology Matrix', () => {
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

  // ── Experiment/Reconciliation in topologies ─────────────

  describe('experiment pivot in topologies', () => {
    it('experiment pivot in fork: spawn creates variants, downstream rewired through reconciliation', () => {
      const plan: PlanDefinition = {
        name: 'exp-fork',
        tasks: [
          {
            id: 'pivot',
            description: 'Pivot task',
            command: 'echo pivot',
            pivot: true,
            experimentVariants: [
              { id: 'v1', description: 'V1', prompt: 'Try A' },
              { id: 'v2', description: 'V2', prompt: 'Try B' },
            ],
          },
          { id: 'downstream', description: 'Downstream', command: 'echo down', dependencies: ['pivot'] },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        spawnResponse('pivot', [
          { id: 'v1', description: 'V1' },
          { id: 'v2', description: 'V2' },
        ]),
      );

      const allTasks = orchestrator.getAllTasks();
      const e1 = sid(orchestrator, 0, 'pivot-exp-v1');
      const e2 = sid(orchestrator, 0, 'pivot-exp-v2');
      const reconId = rid(orchestrator, 0, 'pivot');
      const expV1 = allTasks.find((t) => t.id === e1);
      const expV2 = allTasks.find((t) => t.id === e2);
      const recon = allTasks.find((t) => t.id === reconId);

      expect(expV1).toBeDefined();
      expect(expV2).toBeDefined();
      expect(recon).toBeDefined();
      expect(recon!.config.isReconciliation).toBe(true);

      const downstreamClone = allTasks.find(
        (t) => t.description === 'Downstream' && t.status !== 'stale',
      );
      expect(downstreamClone).toBeDefined();
      expect(downstreamClone!.dependencies).toContain(reconId);
    });

    it('experiment pivot at B in diamond: recon replaces B, D remapped to depend on B-recon and C', () => {
      const plan: PlanDefinition = {
        name: 'exp-diamond',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          {
            id: 'B',
            description: 'Pivot',
            dependencies: ['A'],
            pivot: true,
            experimentVariants: [
              { id: 'v1', description: 'V1' },
              { id: 'v2', description: 'V2' },
            ],
          },
          { id: 'C', description: 'Right', command: 'echo C', dependencies: ['A'] },
          { id: 'D', description: 'Join', command: 'echo D', dependencies: ['B', 'C'] },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(complete('A'));

      // B starts running, then spawns experiments
      orchestrator.handleWorkerResponse(
        spawnResponse('B', [
          { id: 'v1', description: 'V1' },
          { id: 'v2', description: 'V2' },
        ]),
      );

      const allTasks = orchestrator.getAllTasks();
      const reconId = rid(orchestrator, 0, 'B');
      const recon = allTasks.find((t) => t.id === reconId);
      expect(recon).toBeDefined();

      const d = orchestrator.getTask('D')!;
      expect(d.status).toBe('pending');
      expect(d.dependencies).toContain(reconId);
      expect(d.dependencies).toContain(sid(orchestrator, 0, 'C'));
    });

    it('all experiments fail → reconciliation still gets needs_input', () => {
      const plan: PlanDefinition = {
        name: 'exp-all-fail',
        tasks: [
          { id: 'setup', description: 'Setup', command: 'echo setup' },
          {
            id: 'pivot',
            description: 'Pivot',
            dependencies: ['setup'],
            pivot: true,
            experimentVariants: [
              { id: 'v1', description: 'V1' },
              { id: 'v2', description: 'V2' },
              { id: 'v3', description: 'V3' },
            ],
          },
          { id: 'downstream', description: 'Down', command: 'echo down', dependencies: ['pivot'] },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(complete('setup'));
      orchestrator.handleWorkerResponse(
        spawnResponse('pivot', [
          { id: 'v1', description: 'V1' },
          { id: 'v2', description: 'V2' },
          { id: 'v3', description: 'V3' },
        ]),
      );

      orchestrator.handleWorkerResponse(fail(sid(orchestrator, 0, 'pivot-exp-v1')));
      orchestrator.handleWorkerResponse(fail(sid(orchestrator, 0, 'pivot-exp-v2')));
      orchestrator.handleWorkerResponse(fail(sid(orchestrator, 0, 'pivot-exp-v3')));

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'pivot')));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'pivot'))!;
      expect(recon.status).toBe('needs_input');
      expect(recon.execution.experimentResults).toBeDefined();
      expect(recon.execution.experimentResults!.length).toBe(3);
      expect(recon.execution.experimentResults!.every((r) => r.status === 'failed')).toBe(true);
    });

    it('reconciliation in diamond: recon at B, command at C → select experiment → D starts', () => {
      const plan: PlanDefinition = {
        name: 'recon-diamond',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          {
            id: 'B',
            description: 'Pivot',
            dependencies: ['A'],
            pivot: true,
            experimentVariants: [
              { id: 'v1', description: 'V1' },
            ],
          },
          { id: 'C', description: 'Right', command: 'echo C', dependencies: ['A'] },
          { id: 'D', description: 'Join', command: 'echo D', dependencies: ['B', 'C'] },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();
      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('C'));

      orchestrator.handleWorkerResponse(
        spawnResponse('B', [{ id: 'v1', description: 'V1' }]),
      );

      // Complete the single experiment
      orchestrator.handleWorkerResponse(complete(sid(orchestrator, 0, 'B-exp-v1')));

      orchestrator.handleWorkerResponse(reconciliationNeedsInputWorkResponse(rid(orchestrator, 0, 'B')));

      const recon = orchestrator.getTask(rid(orchestrator, 0, 'B'))!;
      expect(recon.status).toBe('needs_input');

      persistence.updateTask(sid(orchestrator, 0, 'B-exp-v1'), {
        execution: { branch: 'experiment/B-exp-v1-hash', commit: 'abc123' },
      });

      orchestrator.selectExperiment(rid(orchestrator, 0, 'B'), sid(orchestrator, 0, 'B-exp-v1'));
      expect(orchestrator.getTask(rid(orchestrator, 0, 'B'))!.status).toBe('completed');

      // D-clone should now start (both B-recon and C are completed)
      const allTasks = orchestrator.getAllTasks();
      const dClone = allTasks.find(
        (t) => t.description === 'Join' && t.status === 'running',
      );
      expect(dClone).toBeDefined();
    });
  });

  // ── Mixed types ─────────────────────────────────────────

  describe('mixed action types', () => {
    it('chain: command→claude→command, all complete sequentially', () => {
      const plan: PlanDefinition = {
        name: 'mixed-chain',
        tasks: [
          { id: 'A', description: 'Command task', command: 'echo A' },
          { id: 'B', description: 'Claude task', prompt: 'Do B' },
          { id: 'C', description: 'Command task 2', command: 'echo C', dependencies: ['B'] },
        ],
      };
      // B depends on A
      plan.tasks[1].dependencies = ['A'];

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      expect(orchestrator.getTask('A')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('A'));
      expect(orchestrator.getTask('B')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('B', { agentSessionId: 'sess-1' }));
      expect(orchestrator.getTask('C')!.status).toBe('running');

      orchestrator.handleWorkerResponse(complete('C'));

      expect(orchestrator.getTask('A')!.status).toBe('completed');
      expect(orchestrator.getTask('B')!.status).toBe('completed');
      expect(orchestrator.getTask('C')!.status).toBe('completed');
    });

    it('claude task fails → restart → agentSessionId not carried over', () => {
      const plan: PlanDefinition = {
        name: 'claude-restart',
        tasks: [
          { id: 'A', description: 'Claude task', prompt: 'Do A' },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(
        complete('A', { agentSessionId: 'sess-1' }),
      );
      expect(orchestrator.getTask('A')!.execution.agentSessionId).toBe('sess-1');

      orchestrator.restartTask('A');
      const restarted = orchestrator.getTask('A')!;
      expect(restarted.status).toBe('running');
      expect(restarted.execution.commit).toBeUndefined();
      expect(restarted.execution.agentSessionId).toBeUndefined();
    });

    it('diamond: B(claude) + C(command), both complete → D starts', () => {
      const plan: PlanDefinition = {
        name: 'mixed-diamond',
        tasks: [
          { id: 'A', description: 'Root', command: 'echo A' },
          { id: 'B', description: 'Claude', prompt: 'Do B', dependencies: ['A'] },
          { id: 'C', description: 'Command', command: 'echo C', dependencies: ['A'] },
          { id: 'D', description: 'Join', command: 'echo D', dependencies: ['B', 'C'] },
        ],
      };

      orchestrator.loadPlan(plan);
      orchestrator.startExecution();

      orchestrator.handleWorkerResponse(complete('A'));
      orchestrator.handleWorkerResponse(complete('B'));
      orchestrator.handleWorkerResponse(complete('C'));

      expect(orchestrator.getTask('D')!.status).toBe('running');
    });
  });
});
