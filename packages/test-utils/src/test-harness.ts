import { Orchestrator, type PlanDefinition, type TaskState } from '@invoker/core';
import { TaskExecutor, FamiliarRegistry } from '@invoker/executors';
import type { WorkResponse } from '@invoker/protocol';
import { InMemoryPersistence } from './in-memory-persistence.js';
import { InMemoryBus } from './in-memory-bus.js';
import { MockGit } from './mock-git.js';

export interface TestHarness {
  orchestrator: Orchestrator;
  executor: TaskExecutor;
  persistence: InMemoryPersistence;
  bus: InMemoryBus;
  git: MockGit;

  /** Load a plan and start execution. Returns started tasks. */
  loadAndStart(plan: PlanDefinition, opts?: { allowGraphMutation?: boolean }): TaskState[];

  /** Simulate a task completing (as if a familiar finished). Returns newly started tasks. */
  completeTask(taskId: string, extras?: Partial<WorkResponse['outputs']>): TaskState[];

  /** Simulate a task failing. Returns newly started tasks (usually none). */
  failTask(taskId: string, error?: string): TaskState[];

  /** Get a task by ID. */
  getTask(taskId: string): TaskState | undefined;

  /** Get all tasks. */
  getAllTasks(): TaskState[];
}

/**
 * Create a fully wired Orchestrator + TaskExecutor test harness.
 *
 * Uses InMemoryPersistence, InMemoryBus, MockGit, and a stub FamiliarRegistry.
 * No Electron, no real git, no real child processes.
 */
export function createTestHarness(opts?: { maxConcurrency?: number }): TestHarness {
  const persistence = new InMemoryPersistence();
  const bus = new InMemoryBus();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: bus,
    maxConcurrency: opts?.maxConcurrency ?? 10,
  });

  const familiarRegistry = new FamiliarRegistry();

  const executor = new TaskExecutor({
    orchestrator,
    persistence: persistence as any,
    familiarRegistry,
    cwd: '/tmp/test-harness',
  });

  const git = new MockGit();
  git.install(executor);

  orchestrator.setBeforeApproveHook(async (task) => {
    if (task.config.isMergeNode && task.config.workflowId) {
      await executor.approveMerge(task.config.workflowId);
    }
  });

  return {
    orchestrator,
    executor,
    persistence,
    bus,
    git,

    loadAndStart(plan: PlanDefinition, loadOpts?: { allowGraphMutation?: boolean }): TaskState[] {
      orchestrator.loadPlan(plan, loadOpts);
      return orchestrator.startExecution();
    },

    completeTask(taskId: string, extras?: Partial<WorkResponse['outputs']>): TaskState[] {
      const response: WorkResponse = {
        requestId: `complete-${taskId}`,
        actionId: taskId,
        status: 'completed',
        outputs: { exitCode: 0, ...extras },
      };
      return orchestrator.handleWorkerResponse(response) ?? [];
    },

    failTask(taskId: string, error?: string): TaskState[] {
      const response: WorkResponse = {
        requestId: `fail-${taskId}`,
        actionId: taskId,
        status: 'failed',
        outputs: { exitCode: 1, error: error ?? 'task failed' },
      };
      return orchestrator.handleWorkerResponse(response) ?? [];
    },

    getTask(taskId: string): TaskState | undefined {
      return orchestrator.getTask(taskId);
    },

    getAllTasks(): TaskState[] {
      return orchestrator.getAllTasks();
    },
  };
}
