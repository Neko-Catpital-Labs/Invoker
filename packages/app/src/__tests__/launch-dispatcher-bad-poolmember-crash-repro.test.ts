import { describe, it, expect, vi, afterEach } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { TaskRunner } from '@invoker/execution-engine';
import { LaunchDispatcher } from '../launch-dispatcher.js';

/**
 * Repro for a live DO1 incident: a task's config pinned poolMemberId
 * "local-worktree" against a pool member of that id, but worktreeTargets
 * had no matching entry (the config didn't ship one). selectExecutor()
 * throws for that task by design -- the question this test answers is
 * whether that throw stays scoped to the one task/dispatch, or whether it
 * escapes as an unhandled rejection and takes the whole owner process down.
 */
describe('LaunchDispatcher + real TaskRunner: bad poolMemberId does not crash the process', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it('fails only the offending dispatch instead of throwing out of poll()', async () => {
    const persistence = await SQLiteAdapter.create(':memory:');
    adapters.push(persistence);

    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      maxConcurrency: 4,
    });

    orchestrator.loadPlan({
      name: 'wf-a',
      tasks: [
        {
          id: 'verify-routing-command',
          description: 'verify-routing-command',
          command: 'echo hi',
          poolId: 'mixed-local-ssh',
          poolMemberId: 'local-worktree',
        },
      ],
    } as any);

    // Mirrors DO1's live config.json: a pool member named "local-worktree"
    // but an empty worktreeTargets map -- nothing backs that member id.
    const taskRunner = new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      executorRegistry: {
        get: () => null,
        getAll: () => [],
        register: vi.fn(),
      } as any,
      cwd: '/tmp',
      worktreeTargetsProvider: () => ({}),
      executionPoolsProvider: () => ({
        'mixed-local-ssh': {
          selectionStrategy: 'leastLoaded',
          maxConcurrentTasksPerMember: 1,
          members: [{ id: 'local-worktree', type: 'worktree' as const, maxConcurrentTasks: 2 }],
        },
      }),
    });

    const dispatcher = new LaunchDispatcher({
      persistence,
      ownerId: 'repro-owner',
      orchestrator: {
        prepareTaskForNewAttempt: (taskId, reason) => orchestrator.prepareTaskForNewAttempt(taskId, reason),
        getTask: (taskId) => orchestrator.getTask(taskId),
        getTaskLaunchReadiness: (taskId) => orchestrator.getTaskLaunchReadiness(taskId),
        getExecutableReadyTasks: () => orchestrator.getExecutableReadyTasks(),
        startExecution: (opts) => orchestrator.startExecution(opts),
      },
      taskRunnerProvider: () => taskRunner,
    });

    let unhandled: unknown;
    const onUnhandledRejection = (reason: unknown) => {
      unhandled = reason;
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      // poll() itself must stay synchronous-safe regardless of what the
      // fire-and-forget executeTask() promise later does.
      expect(() => dispatcher.poll()).not.toThrow();

      // Let the fire-and-forget executeTask() promise chain settle.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }

    expect(unhandled).toBeUndefined();

    const task = orchestrator.getTask('wf-a/verify-routing-command');
    // The task must land in a normal failed/retryable state, not disappear
    // or leave the orchestrator/owner process in an inconsistent spot.
    expect(task?.status).not.toBe('running');
  });
});
