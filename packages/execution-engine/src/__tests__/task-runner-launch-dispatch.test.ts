import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse, Logger } from '@invoker/contracts';
import { TaskRunner, type LaunchOutboxAck } from '../task-runner.js';

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

function buildRunnerEnv(task: TaskState, options: { startThrows?: Error } = {}): RunnerEnv {
  let completeCallback: ((response: WorkResponse) => void) | undefined;
  const executor = {
    type: 'worktree',
    start: vi.fn().mockImplementation(async (request: any) => {
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
  ackCalls: Array<[number, string]>;
  completeCalls: number[];
  failCalls: Array<[number, unknown]>;
} {
  const ackCalls: Array<[number, string]> = [];
  const completeCalls: number[] = [];
  const failCalls: Array<[number, unknown]> = [];
  return {
    ackCalls,
    completeCalls,
    failCalls,
    ackDispatch(id, runnerId) {
      ackCalls.push([id, runnerId]);
      return true;
    },
    completeDispatch(id) {
      completeCalls.push(id);
      return true;
    },
    failDispatch(id, err) {
      failCalls.push([id, err]);
      return true;
    },
  };
}

describe('TaskRunner launch-dispatch wiring', () => {
  it('acks dispatch at the top of executeTask and proceeds to executor.start when accepted', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('isolated start sentinel') });
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 42, launchOutbox });

    expect(launchOutbox.ackCalls).toHaveLength(1);
    expect(launchOutbox.ackCalls[0][0]).toBe(42);
    expect(launchOutbox.ackCalls[0][1]).toMatch(/^[0-9a-f-]+$/);
    expect(env.executor.start).toHaveBeenCalledTimes(1);
  });

  it('does NOT call the executor when ackDispatch returns false', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task);
    const launchOutbox = makeLaunchOutbox();
    launchOutbox.ackDispatch = vi.fn().mockReturnValue(false);

    await env.runner.executeTask(task, { dispatchId: 99, launchOutbox });

    expect(env.executor.start).not.toHaveBeenCalled();
    expect(env.orchestrator.markTaskRunningAfterLaunch).not.toHaveBeenCalled();
    expect(launchOutbox.completeCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(0);
  });

  it('calls failDispatch when the executor start throws', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('startup explosion') });
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 7, launchOutbox });

    expect(launchOutbox.ackCalls).toHaveLength(1);
    expect(launchOutbox.completeCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(1);
    expect(launchOutbox.failCalls[0][0]).toBe(7);
    const failArg = launchOutbox.failCalls[0][1];
    expect(failArg).toBeInstanceOf(Error);
    expect((failArg as Error).message).toMatch(/startup explosion/);
  });

  it('is a no-op for the outbox when dispatchOpts is omitted', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('start sentinel') });
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task);

    expect(launchOutbox.ackCalls).toHaveLength(0);
    expect(launchOutbox.completeCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(0);
    expect(env.executor.start).toHaveBeenCalled();
  });

  it('fails the dispatch and short-circuits when the attempt is already launching', async () => {
    const task = makeTask();
    const env = buildRunnerEnv(task, { startThrows: new Error('unused') });
    (env.runner as any).launchingAttemptIds.add('attempt-1');
    const launchOutbox = makeLaunchOutbox();

    await env.runner.executeTask(task, { dispatchId: 123, launchOutbox });

    expect(env.executor.start).not.toHaveBeenCalled();
    expect(launchOutbox.ackCalls).toHaveLength(0);
    expect(launchOutbox.failCalls).toHaveLength(1);
    expect(launchOutbox.failCalls[0][0]).toBe(123);
    expect((launchOutbox.failCalls[0][1] as Error).message).toMatch(/Duplicate launch suppressed/);
  });
});
