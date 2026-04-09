import { Orchestrator, type PlanDefinition, type TaskState } from '@invoker/workflow-core';
import { TaskRunner, ExecutorRegistry, type MergeGateProvider } from '@invoker/execution-engine';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { Executor, ExecutorHandle, PersistedTaskMeta, TerminalSpec } from '@invoker/execution-engine';
import { InMemoryPersistence } from './in-memory-persistence.js';
import { InMemoryBus } from './in-memory-bus.js';
import { MockGit } from './mock-git.js';

/**
 * A minimal executor that auto-completes on start().
 * Used by the test harness so merge nodes (which now route through the
 * executor pipeline) can complete without real git or child processes.
 */
class MockExecutor implements Executor {
  readonly type = 'worktree';
  private completeCallbacks = new Map<string, (response: WorkResponse) => void>();

  async start(request: WorkRequest): Promise<ExecutorHandle> {
    const handle: ExecutorHandle = {
      executionId: `mock-exec-${request.actionId}-${Date.now()}`,
      taskId: request.actionId,
      workspacePath: '/tmp/mock-worktree',
      branch: `experiment/${request.actionId}-mock0000`,
    };
    setTimeout(() => {
      const cb = this.completeCallbacks.get(handle.executionId);
      if (cb) {
        cb({
          requestId: request.requestId,
          actionId: request.actionId,
          status: 'completed',
          outputs: { exitCode: 0 },
        });
      }
    }, 0);
    return handle;
  }

  onComplete(handle: ExecutorHandle, callback: (response: WorkResponse) => void) {
    this.completeCallbacks.set(handle.executionId, callback);
    return () => { this.completeCallbacks.delete(handle.executionId); };
  }

  onOutput() { return () => {}; }
  onHeartbeat() { return () => {}; }
  sendInput() {}
  async kill() {}
  getTerminalSpec() { return null; }
  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    return { cwd: meta.workspacePath ?? '/tmp/mock-worktree' };
  }
  async destroyAll() { this.completeCallbacks.clear(); }
}

export interface TestHarness {
  orchestrator: Orchestrator;
  executor: TaskRunner;
  persistence: InMemoryPersistence;
  bus: InMemoryBus;
  git: MockGit;

  /** Load a plan and start execution. Returns started tasks. */
  loadAndStart(plan: PlanDefinition, opts?: { allowGraphMutation?: boolean }): TaskState[];

  /** Simulate a task completing (as if an executor finished). Returns newly started tasks. */
  completeTask(taskId: string, extras?: Partial<WorkResponse['outputs']>): TaskState[];

  /** Simulate a task failing. Returns newly started tasks (usually none). */
  failTask(taskId: string, error?: string): TaskState[];

  /** Get a task by ID. */
  getTask(taskId: string): TaskState | undefined;

  /** Get all tasks. */
  getAllTasks(): TaskState[];
}

/**
 * Create a fully wired Orchestrator + TaskRunner test harness.
 *
 * Uses InMemoryPersistence, InMemoryBus, MockGit, and a stub ExecutorRegistry.
 * No Electron, no real git, no real child processes.
 */
export function createTestHarness(opts?: {
  maxConcurrency?: number;
  mergeGateProvider?: MergeGateProvider;
}): TestHarness {
  const persistence = new InMemoryPersistence();
  const bus = new InMemoryBus();
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: bus,
    maxConcurrency: opts?.maxConcurrency ?? 10,
  });

  const executorRegistry = new ExecutorRegistry();
  executorRegistry.register('worktree', new MockExecutor());

  const executor = new TaskRunner({
    orchestrator,
    persistence: persistence as any,
    executorRegistry,
    cwd: '/tmp/test-harness',
    mergeGateProvider: opts?.mergeGateProvider,
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
      const task = orchestrator.getTask(taskId);
      if (!task) return [];
      const id = task.id;
      if (!task.execution.branch) {
        persistence.updateTask(id, {
          execution: { branch: `experiment/${id}-test0000` },
        });
      }
      const response: WorkResponse = {
        requestId: `complete-${id}`,
        actionId: id,
        status: 'completed',
        outputs: { exitCode: 0, ...extras },
      };
      return orchestrator.handleWorkerResponse(response) ?? [];
    },

    failTask(taskId: string, error?: string): TaskState[] {
      const task = orchestrator.getTask(taskId);
      if (!task) return [];
      const id = task.id;
      const response: WorkResponse = {
        requestId: `fail-${id}`,
        actionId: id,
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
