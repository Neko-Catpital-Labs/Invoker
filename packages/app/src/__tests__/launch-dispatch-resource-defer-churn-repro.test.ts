import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';
import { LaunchDispatcher } from '../launch-dispatcher.js';

/**
 * Repro for the launch-dispatch churn behind stuck-pending tasks.
 *
 * Observed in production (invoker.log): a queued task loops forever —
 * `[launch-dispatcher] complete accepted:false` every cycle, no executor
 * spawns, the task stays `pending`, generations climb into the thousands.
 *
 * Root cause: on the resource-limit path, `executeTask` calls
 * `orchestrator.deferTask()`, which invalidates launch artifacts and
 * `abandonLaunchDispatchesForTasks()` flips the leased dispatch row to
 * `abandoned`. `executeTask` then calls `completeDispatch()` on the same
 * row, which is now terminal — so it returns false. The dispatch is
 * double-terminated (abandoned by defer, never completed) and the task
 * re-drains into a fresh row that hits the same wall.
 *
 * This test models that exact ordering with the real adapter + dispatcher
 * and a fake TaskRunner. It fails on current code (accepted:false, row
 * abandoned); the fix should let the launch complete cleanly.
 */
function makeLogger(): Logger & {
  records: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const records: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    records.push({ level, msg, fields });
  };
  const logger: Logger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
  };
  return Object.assign(logger, { records });
}

describe('launch-dispatch resource-limit defer churn (repro)', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  // `it.fails`: this asserts the DESIRED behavior, which the current code does
  // not satisfy — it documents the bug and stays green in CI. The fix slice
  // removes `.fails` once the launch completes cleanly instead of churning.
  it.fails('does not double-terminate the dispatch row when a launch defers on resource limit', () => {
    const attemptId = 'attempt-resource-limit';
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'wf-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-1', {
      id: 'wf-1/t1',
      description: 'one',
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-1' },
      execution: {},
      taskStateVersion: 1,
    });
    adapter.updateTask('wf-1/t1', {
      execution: { selectedAttemptId: attemptId, generation: 0 },
    });
    const enqueued = adapter.enqueueLaunchDispatch({
      taskId: 'wf-1/t1',
      attemptId,
      workflowId: 'wf-1',
      generation: 0,
    });

    const logger = makeLogger();
    const task = { id: 'wf-1/t1', execution: { selectedAttemptId: attemptId, generation: 0 } };

    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      ownerId: 'owner-test',
      logger,
      orchestrator: {
        prepareTaskForNewAttempt: vi.fn(),
        startExecution: () => [],
        getTask: () => task as never,
      },
      // A launch that hits a saturated pool: defer (invalidates + abandons
      // the leased dispatch row), then complete the same row. This is the
      // executeTask resource-limit branch, faithfully ordered.
      taskRunnerProvider: () => ({
        executeTask: (t, opts) => {
          adapter.abandonLaunchDispatchesForTasks([t.id], 'task deferred');
          opts?.launchOutbox.completeDispatch(opts.dispatchId);
          return Promise.resolve();
        },
      }),
    });

    dispatcher.poll();

    const completeLog = logger.records.find(
      (r) => r.msg.includes('[launch-dispatcher] complete'),
    );
    const row = adapter.loadLaunchDispatchById(enqueued.id);

    // Bug signature: the dispatch is abandoned by the defer, so completeDispatch
    // is rejected — the exact `accepted:false` churn seen in production.
    expect(completeLog?.fields?.accepted).toBe(true);
    expect(row?.state).toBe('completed');
  });
});
