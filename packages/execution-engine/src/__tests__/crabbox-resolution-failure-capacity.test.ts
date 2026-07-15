import { describe, expect, it } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import type { CrabboxResolver } from '../task-runner.js';
import type { ExecutorRegistry } from '../registry.js';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';

// Regression guard for CodeRabbit PR #1403 (discussion r3458135323):
// when Crabbox lease resolution fails, `selectExecutor` has already stored a
// pending pool selection, so a failed resolve must release it — otherwise
// `poolMemberLoad()` keeps counting the dead selection and the member's
// capacity is permanently reduced for later tasks.

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { command: 'echo hi', runnerKind: 'ssh', poolId: 'ssh-pool' },
    execution: { selectedAttemptId: `${id}-attempt`, generation: 0 },
  } as unknown as TaskState; // Minimal TaskState fixture for the runner under test.
}

const crabboxTarget = {
  type: 'crabbox' as const,
  crabboxCommand: 'crabbox',
  provider: 'do',
  class: 'medium',
  ttl: '30m',
  idleTimeout: '10m',
  network: 'default',
  target: 'ubuntu-22',
  stopAfter: 'completed',
  keepOnFailure: false,
};

describe('crabbox resolution failure capacity', () => {
  it('releases the pending pool selection when crabbox resolution fails', async () => {
    const task = makeTask('wf-1/crab-a');

    // Resolver that always fails the lease (e.g. warmup/status error).
    const failingResolver: CrabboxResolver = {
      resolve: async () => {
        throw new Error('crabbox warmup failed');
      },
    };

    // Minimal orchestrator double: only the surface executeTask's failure path
    // touches. Cast once at the boundary — the full Orchestrator interface is
    // far larger than this test exercises.
    const orchestrator = {
      getTask: (id: string) => (id === task.id ? task : null),
      getAllTasks: () => [task],
      handleWorkerResponse: () => [],
      deferTask: () => {},
    } as unknown as Orchestrator;

    // Minimal persistence double: no-op writes; the runner only logs/persists.
    const persistence = {
      logEvent: () => {},
      updateTask: () => {},
      updateAttempt: () => {},
      appendTaskOutput: () => {},
      loadAttempts: () => [],
    } as unknown as SQLiteAdapter;

    // Executor registry double: SSH tasks never fall back to the default here.
    const executorRegistry = {
      getDefault: () => ({ type: 'worktree' }),
      get: () => null,
      getAll: () => [],
      register: () => {},
    } as unknown as ExecutorRegistry;

    const runner = new TaskRunner({
      orchestrator,
      persistence,
      executorRegistry,
      cwd: '/tmp',
      remoteTargetsProvider: () => ({ 'crab-a': crabboxTarget }),
      executionPoolsProvider: () => ({
        'ssh-pool': {
          selectionStrategy: 'leastLoaded',
          maxConcurrentTasksPerMember: 1,
          members: [{ id: 'crab-a', type: 'ssh' as const, maxConcurrentTasks: 1 }],
        },
      }),
      crabboxResolver: failingResolver,
    });

    // The launch fails (resolve rejects). executeTask swallows the failure into
    // a failed WorkResponse, so it resolves rather than rejecting.
    await runner.executeTask(task);

    // Probe capacity through the public API without touching private state:
    // a second task on the same single-slot member must still be selectable.
    // If the failed selection leaked, selectPoolMember finds the member at
    // capacity and throws "no member capacity available". If it was released,
    // selection succeeds and the crabbox target reports it needs resolution.
    const nextTask = makeTask('wf-2/crab-b');
    expect(() => runner.selectExecutor(nextTask)).toThrow(/must be resolved before use/);
    expect(() => runner.selectExecutor(nextTask)).not.toThrow(/no member capacity/);
  });
});
