import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { LaunchDispatcher } from '../launch-dispatcher.js';

function makeRepairTask(attemptId: string, generation: number): TaskState {
  return {
    id: 'wf-admin/pr-614-repair',
    description: 'Repair admin-bypass PR #614',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-09-15T04:16:00.000Z'),
    config: { workflowId: 'wf-admin' },
    execution: { selectedAttemptId: attemptId, generation },
    taskStateVersion: 1,
  };
}

describe('LaunchDispatcher ready repair top-up dedupe', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.close();
  });

  async function runScenario(topUpEnabled: boolean) {
    const adapter = await SQLiteAdapter.create(':memory:');
    adapters.push(adapter);

    adapter.saveWorkflow({
      id: 'wf-admin',
      name: 'wf-admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    let generation = 0;
    let task = makeRepairTask('attempt-0', generation);
    adapter.saveTask('wf-admin', task);
    adapter.enqueueLaunchDispatch({
      taskId: task.id,
      attemptId: task.execution.selectedAttemptId!,
      workflowId: 'wf-admin',
      generation,
    });

    const prepareTaskForNewAttempt = vi.fn((taskId: string) => {
      generation += 1;
      task = makeRepairTask(`attempt-${generation}`, generation);
      adapter.updateTask(taskId, {
        execution: {
          selectedAttemptId: task.execution.selectedAttemptId,
          generation: task.execution.generation,
        },
      });
      adapter.enqueueLaunchDispatch({
        taskId,
        attemptId: task.execution.selectedAttemptId!,
        workflowId: 'wf-admin',
        generation,
      });
    });
    const executeTask = vi.fn(() => new Promise<void>(() => {}));

    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      ownerId: topUpEnabled ? 'owner-topup-on' : 'owner-topup-off',
      topUpReadyLaunchesEnabled: () => topUpEnabled,
      orchestrator: {
        prepareTaskForNewAttempt,
        getTask: () => task,
        getTaskLaunchReadiness: () => ({ ready: true, task }),
        getExecutableReadyTasks: () => [task],
        getQueueStatus: () => ({ runningCount: 0, maxConcurrency: 1 }),
        isLaunchParked: () => false,
        startExecution: () => [],
      },
      taskRunnerProvider: () => ({ executeTask }),
      maxLeasesPerPoll: 4,
    });

    for (let i = 0; i < 3; i += 1) {
      dispatcher.poll();
    }

    return {
      prepareCalls: prepareTaskForNewAttempt.mock.calls.length,
      dispatchedAttempts: executeTask.mock.calls.map(([dispatched]) => dispatched.execution.selectedAttemptId),
      liveDispatches: adapter.listLaunchDispatchesByState(['enqueued', 'leased']).map((row) => ({
        attemptId: row.attemptId,
        state: row.state,
      })),
    };
  }

  it('does not top up a ready repair task while its selected dispatch has not settled', async () => {
    const withoutTopUp = await runScenario(false);
    const withTopUp = await runScenario(true);

    expect(withoutTopUp).toMatchObject({
      prepareCalls: 0,
      dispatchedAttempts: ['attempt-0'],
      liveDispatches: [{ attemptId: 'attempt-0', state: 'leased' }],
    });

    expect(withTopUp).toMatchObject({
      prepareCalls: 0,
      dispatchedAttempts: ['attempt-0'],
      liveDispatches: [{ attemptId: 'attempt-0', state: 'leased' }],
    });
  });
});
