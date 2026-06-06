import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse, Logger } from '@invoker/contracts';
import { TaskRunner, type LaunchOutboxAck } from '../task-runner.js';
import { ResourceLimitError } from '../repo-pool.js';

function makeLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    debug: vi.fn(noop),
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    child: vi.fn(),
  };
  (logger.child as any).mockReturnValue(logger);
  return logger;
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-d/t1',
    description: 'launch-dispatch test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    config: { workflowId: 'wf-d' },
    execution: { selectedAttemptId: 'attempt-1', generation: 1, phase: 'launching' },
    ...overrides,
  } as TaskState;
}

interface RunnerEnv {
  runner: TaskRunner;
  orchestrator: {
    getTask: ReturnType<typeof vi.fn>;
    markTaskRunningAfterLaunch: ReturnType<typeof vi.fn>;
    handleWorkerResponse: ReturnType<typeof vi.fn>;
    deferTask: ReturnType<typeof vi.fn>;
  };
  executor: {
    start: ReturnType<typeof vi.fn>;
    onComplete: ReturnType<typeof vi.fn>;
    onOutput: ReturnType<typeof vi.fn>;
    onHeartbeat: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    destroyAll: ReturnType<typeof vi.fn>;
    type: string;
  };
  triggerComplete: () => void;
}

function buildRunnerEnv(task: TaskState, options: {
  startThrows?: Error;
  startImpl?: (request: any) => Promise<any>;
} = {}): RunnerEnv {
  let completeCallback: ((response: WorkResponse) => void) | undefined;
  const executor = {
    type: 'worktree',
    start: vi.fn().mockImplementation(async (request: any) => {
      if (options.startImpl) return options.startImpl(request);
      if (options.startThrows) throw options.startThrows;
      return {
        executionId: `exec-${request.actionId}`,
        taskId: request.actionId,
        workspacePath: '/tmp/mock-ws',
        branch: `experiment/${request.actionId}-mock`,
      };
    }),
    onComplete: vi.fn().mockImplementation((_h: any, cb: any) => {
      completeCallback = cb;
      return () => {};
    }),
    onOutput: vi.fn().mockReturnValue(() => {}),
    onHeartbeat: vi.fn().mockReturnValue(() => {}),
    kill: vi.fn().mockResolvedValue(undefined),
    destroyAll: vi.fn().mockResolvedValue(undefined),
  };
  const orchestrator = {
    getTask: vi.fn().mockReturnValue(task),
    getAllTasks: vi.fn().mockReturnValue([task]),
    markTaskRunningAfterLaunch: vi.fn().mockReturnValue(true),
    handleWorkerResponse: vi.fn().mockReturnValue([]),
    deferTask: vi.fn(),
  };
  const runner = new TaskRunner({
    orchestrator: orchestrator as any,
    persistence: {
      updateTask: vi.fn(),
      loadAttempts: vi.fn().mockReturnValue([]),
      logEvent: vi.fn(),
    } as any,
    executorRegistry: {
      get: vi.fn().mockReturnValue(executor),
      getAll: vi.fn().mockReturnValue([['worktree', executor]]),
      getDefault: vi.fn().mockReturnValue(executor),
    } as any,
    cwd: '/tmp/test-runner-dispatch',
    logger: makeLogger(),
  });
  return {
    runner,
    orchestrator,
    executor,
    triggerComplete: () => {
      completeCallback?.({
        requestId: 'req',
        actionId: task.id,
        attemptId: task.execution.selectedAttemptId,
        executionGeneration: task.execution.generation ?? 0,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
    },
  };
}

function makeLaunchOutbox(): LaunchOutboxAck & {
  completeCalls: number[];
  failCalls: Array<[number, unknown]>;
  renewCalls: number[];
} {
  const completeCalls: number[] = [];
  const failCalls: Array<[number, unknown]> = [];
  const renewCalls: number[] = [];
  return {
    completeCalls,
    failCalls,
    renewCalls,
    completeDispatch(id) {
      completeCalls.push(id);
      return true;
    },
    failDispatch(id, err) {
      failCalls.push([id, err]);
      return true;
    },
    renewDispatch(id) {
      renewCalls.push(id);
      return true;
    },
  };
}

describe('TaskRunner launch-dispatch wiring', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps dispatch leased and proceeds to executor.start', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('isolated start sentinel') });
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 42, launchOutbox });

    expect(env.executor.start).toHaveBeenCalledTimes(1);
  });

  it('calls failDispatch when the executor start throws', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('startup explosion') });
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 7, launchOutbox });

    expect(launchOutbox.completeCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(1);
    expect(launchOutbox.failCalls[0][0]).toBe(7);
    const failArg = launchOutbox.failCalls[0][1];
    expect(failArg).toBeInstanceOf(Error);
    expect((failArg as Error).message).toMatch(/startup explosion/);
  });

  it('renews the dispatch lease while executor.start is still pending', async () => {
    vi.useFakeTimers();
    const task = makeTask();
    let resolveStart: ((handle: any) => void) | undefined;
    const env = buildRunnerEnv(task, {
      startImpl: async (request) => new Promise((resolve) => {
        resolveStart = () => resolve({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-ws',
          branch: `experiment/${request.actionId}-mock`,
        });
      }),
    });
    const launchOutbox = makeLaunchOutbox();

    const run = env.runner.executeTask(task, { dispatchId: 99, launchOutbox });
    await vi.advanceTimersByTimeAsync(16_000);

    expect(launchOutbox.renewCalls).toContain(99);
    resolveStart?.({
      executionId: `exec-${task.id}`,
      taskId: task.id,
      workspacePath: '/tmp/mock-ws',
      branch: `experiment/${task.id}-mock`,
    });
    await vi.advanceTimersByTimeAsync(0);
    env.triggerComplete();
    await run;
  });

  it('completes the dispatch only after the completion listener is registered', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task);
    const originalOnComplete = env.executor.onComplete.getMockImplementation();
    const order: string[] = [];
    env.executor.onComplete.mockImplementation((handle: unknown, cb: unknown) => {
      order.push('onComplete');
      return originalOnComplete?.(handle, cb);
    });
    const launchOutbox: LaunchOutboxAck = {
      completeDispatch(id) {
        expect(id).toBe(77);
        order.push('completeDispatch');
        return true;
      },
      failDispatch: vi.fn().mockReturnValue(true),
      renewDispatch: vi.fn().mockReturnValue(true),
    };

    const run = env.runner.executeTask(task, { dispatchId: 77, launchOutbox });
    await vi.waitFor(() => expect(order).toContain('completeDispatch'));

    expect(order).toEqual(['onComplete', 'completeDispatch']);

    env.triggerComplete();
    await run;
  });

  it('fails the dispatch when markTaskRunningAfterLaunch rejects the launch', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task);
    env.orchestrator.markTaskRunningAfterLaunch.mockReturnValue(false);
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 8, launchOutbox });

    expect(env.executor.start).toHaveBeenCalledTimes(1);
    expect(env.executor.kill).toHaveBeenCalledTimes(1);
    expect(launchOutbox.completeCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(1);
    expect(launchOutbox.failCalls[0][0]).toBe(8);
    expect((launchOutbox.failCalls[0][1] as Error).message).toMatch(/Launch rejected/);
  });

  it('completes the dispatch row when resource-limit defers the launch', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task);
    const message = 'Execution pool "pnpm-ssh" has no member capacity available';
    const resourceLimit = new ResourceLimitError(message);
    (env.runner as any).executeTaskInner = vi.fn().mockRejectedValue(
      new Error(message, { cause: resourceLimit }),
    );
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 321, launchOutbox });

    expect(env.orchestrator.deferTask).toHaveBeenCalledWith(task.id);
    expect(launchOutbox.completeCalls).toEqual([321]);
    expect(launchOutbox.failCalls).toHaveLength(0);
  });

  it('is a no-op for the outbox when dispatchOpts is omitted', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('start sentinel') });
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task);

    expect(launchOutbox.completeCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(0);
    expect(env.executor.start).toHaveBeenCalled();
  });

  it('does not recursively execute newly-started tasks when launched from the outbox', async () => {
    const task = makeTask();
    const child = makeTask({
      id: 'wf-d/child',
      description: 'child',
      execution: { selectedAttemptId: 'child-attempt-1', generation: 0, phase: 'launching' },
    });
    const env = buildRunnerEnv(task);
    env.orchestrator.handleWorkerResponse.mockReturnValue([child]);
    const launchOutbox = makeLaunchOutbox();

    const run = env.runner.executeTask(task, { dispatchId: 314, launchOutbox });
    await new Promise<void>((resolve) => setImmediate(resolve));
    env.triggerComplete();
    await run;

    expect(env.executor.start).toHaveBeenCalledTimes(1);
    expect(env.executor.start.mock.calls[0]?.[0].actionId).toBe(task.id);
    expect(launchOutbox.completeCalls).toEqual([314]);
  });

  it('fails the dispatch and short-circuits when the attempt is already launching', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('unused') });
    (env.runner as any).launchingAttemptIds.add('attempt-1');
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 123, launchOutbox });

    expect(env.executor.start).not.toHaveBeenCalled();
    expect(launchOutbox.failCalls).toHaveLength(1);
    expect(launchOutbox.failCalls[0][0]).toBe(123);
    expect((launchOutbox.failCalls[0][1] as Error).message).toMatch(/Duplicate launch suppressed/);
  });

  it('CD.1: pivot tasks terminate the dispatch row via completeDispatch', async () => {
    // Issue 13: pivot/spawn-experiments returns from executeTaskInner
    // BEFORE the normal markTaskRunningAfterLaunch completeDispatch
    // path (it synthesises a spawn_experiments WorkResponse and
    // returns). Without an explicit completeDispatch here, the parent
    // pivot's outbox row stays leased and is retried or abandoned.
    const pivotTask = makeTask({
      id: 'wf-pivot/parent',
      config: {
        workflowId: 'wf-pivot',
        pivot: true,
        experimentVariants: [
          { id: 'v1', description: 'V1', prompt: 'A' },
          { id: 'v2', description: 'V2', prompt: 'B' },
        ],
      } as any,
      execution: { selectedAttemptId: 'pivot-attempt-1', generation: 0, phase: 'launching' },
    });
    const env = buildRunnerEnv(pivotTask);
    // handleWorkerResponse returns the spawned variants as a TaskState[];
    // we don't need real instances — the test asserts on the dispatch
    // row, not the spawned executions.
    env.orchestrator.handleWorkerResponse.mockReturnValue([]);
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(pivotTask, { dispatchId: 555, launchOutbox });

    // The pivot path emits a spawn_experiments WorkResponse and then,
    // critically, terminates the parent's dispatch row.
    expect(env.orchestrator.handleWorkerResponse).toHaveBeenCalled();
    const synthResponse = env.orchestrator.handleWorkerResponse.mock.calls[0][0];
    expect(synthResponse.status).toBe('spawn_experiments');
    expect(launchOutbox.completeCalls).toEqual([555]);
    expect(launchOutbox.failCalls).toHaveLength(0);
    // The executor must NOT have been called — pivot short-circuits.
    expect(env.executor.start).not.toHaveBeenCalled();
  });
});
