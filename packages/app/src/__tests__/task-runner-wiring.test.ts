import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { publishReviewGateCiFailedLifecycleEvent } from '../lifecycle-event-bridge.js';
import { loadConfig, resolveSecretsFilePath } from '../config.js';
import {
  killRunningTaskExecution,
  rebuildTaskRunner,
  requireWiredTaskRunner,
} from '../execution/task-runner-wiring.js';

const taskRunnerConstructor = vi.fn();
const gitHubMergeGateProviderConstructor = vi.fn();
const reviewProviderRegistryRegister = vi.fn();

vi.mock('@invoker/execution-engine', () => {
  class MockTaskRunner {
    config: unknown;
    approveMerge = vi.fn(async () => undefined);
    executeTasks = vi.fn(async () => undefined);

    constructor(config: unknown) {
      this.config = config;
      taskRunnerConstructor(config, this);
    }
  }

  class MockGitHubMergeGateProvider {
    constructor() {
      gitHubMergeGateProviderConstructor();
    }
  }

  class MockReviewProviderRegistry {
    register(provider: unknown) {
      reviewProviderRegistryRegister(provider);
    }
  }

  return {
    TaskRunner: MockTaskRunner,
    GitHubMergeGateProvider: MockGitHubMergeGateProvider,
    ReviewProviderRegistry: MockReviewProviderRegistry,
  };
});

vi.mock('../lifecycle-event-bridge.js', () => ({
  publishReviewGateCiFailedLifecycleEvent: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    remoteTargets: { remote: { host: 'host' } },
    executionPools: { pool: { members: [] } },
    autoFixAgent: 'codex',
    autoApproveAIFixes: true,
  })),
  resolveSecretsFilePath: vi.fn(() => '/tmp/secrets.env'),
}));

function createLogger() {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function createMessageBus() {
  return {
    publish: vi.fn(),
  };
}

describe('task-runner-wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs TaskRunner and preserves callback side effects', () => {
    let currentRunner: any = null;
    let latestRunner: any = null;
    const taskHandles = new Map();
    const logger = createLogger();
    const orchestrator = {
      getTask: vi.fn(() => ({
        status: 'running',
        execution: { generation: 2, lastHeartbeatAt: new Date(Date.now() - 1000) },
      })),
      recordTaskHeartbeat: vi.fn(),
      setBeforeApproveHook: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      loadWorkflow: vi.fn(),
    };

    const runner = rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      messageBus: createMessageBus() as any,
      executorRegistry: {} as any,
      executionAgentRegistry: {} as any,
      repoRoot: '/repo',
      invokerConfig: {
        defaultBranch: 'main',
        docker: { imageName: 'image' },
        autoFixCi: true,
      },
      logger: logger as any,
      taskHandles,
      enqueueTaskOutput: vi.fn(),
      flushTaskOutput: vi.fn(),
      assertFatalExecutionCapacity: vi.fn(),
      getTaskRunner: () => currentRunner,
      setTaskRunner: (value) => { currentRunner = value; },
      setLatestTaskExecutor: (value) => { latestRunner = value; },
    });

    expect(currentRunner).toBe(runner);
    expect(latestRunner).toBe(runner);
    expect(resolveSecretsFilePath).toHaveBeenCalledWith(expect.objectContaining({ defaultBranch: 'main' }));
    expect(gitHubMergeGateProviderConstructor).toHaveBeenCalledTimes(2);
    expect(reviewProviderRegistryRegister).toHaveBeenCalledTimes(1);

    const config = taskRunnerConstructor.mock.calls[0]?.[0] as any;
    expect(config.cwd).toBe('/repo');
    expect(config.dockerConfig).toEqual({ imageName: 'image', secretsFile: '/tmp/secrets.env' });
    expect(config.remoteTargetsProvider()).toEqual({ remote: { host: 'host' } });
    expect(config.executionPoolsProvider()).toEqual({ pool: { members: [] } });
    expect(loadConfig).toHaveBeenCalledTimes(2);

    config.callbacks.onOutput('task-1', 'chunk');
    expect(taskRunnerConstructor.mock.calls[0]?.[0].callbacks.onOutput).toBe(config.callbacks.onOutput);

    const handle = { executionId: 'exec-1', workspacePath: '/repo/wt', branch: 'feature' };
    const executor = { type: 'worktree' };
    config.callbacks.onSpawned('task-1', handle, executor);
    expect(taskHandles.get('task-1')).toEqual({ handle, executor });

    config.callbacks.onComplete('task-1', {
      status: 'completed',
      executionGeneration: 2,
      outputs: { exitCode: 0 },
    });
    expect(taskHandles.has('task-1')).toBe(false);

    const heartbeatAt = new Date('2026-06-03T01:02:03.000Z');
    config.callbacks.onHeartbeat('task-1', { at: heartbeatAt, source: 'remote_workload' });
    expect(persistence.updateTask).not.toHaveBeenCalled();
    expect(orchestrator.recordTaskHeartbeat).toHaveBeenCalledWith('task-1', {
      at: heartbeatAt,
      source: 'remote_workload',
    });
  });

  it('persists a durable startup-failure diagnostic when launch fails before spawn', () => {
    let currentRunner: any = null;
    const task = {
      id: 'task-1',
      status: 'running',
      execution: { generation: 1 },
    };
    const orchestrator = {
      getTask: vi.fn(() => task),
      recordTaskHeartbeat: vi.fn(),
      setBeforeApproveHook: vi.fn(),
    };
    const appended: string[] = [];
    const persistence = {
      updateTask: vi.fn(),
      loadWorkflow: vi.fn(),
      getOutputTail: vi.fn(() => [{ data: 'FAIL src/startup.test.ts\n', offset: 0 }]),
      appendTaskOutput: vi.fn((_id: string, data: string) => { appended.push(data); }),
    };
    const flushTaskOutput = vi.fn();

    rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      executorRegistry: {} as any,
      repoRoot: '/repo',
      invokerConfig: {},
      logger: createLogger() as any,
      taskHandles: new Map(),
      enqueueTaskOutput: vi.fn(),
      flushTaskOutput,
      assertFatalExecutionCapacity: vi.fn(),
      getTaskRunner: () => currentRunner,
      setTaskRunner: (value) => { currentRunner = value; },
      setLatestTaskExecutor: vi.fn(),
    });

    const config = taskRunnerConstructor.mock.calls[0]?.[0] as any;
    config.callbacks.onLaunchFailed(
      'task-1',
      new Error('Executor startup failed (worktree): missing repoUrl'),
      { type: 'worktree' },
    );

    expect(flushTaskOutput).toHaveBeenCalledWith('task-1');
    expect(appended).toHaveLength(1);
    const block = appended[0];
    expect(block).toContain('[Startup Failure Diagnostic]');
    expect(block).toContain('forcedStopReason=Executor startup failed (worktree)');
    expect(block).toContain('detail=Executor startup failed (worktree): missing repoUrl');
    expect(block).toContain('FAIL src/startup.test.ts');
  });

  it('does not persist a startup diagnostic when the task is already gone', () => {
    let currentRunner: any = null;
    const orchestrator = {
      getTask: vi.fn(() => undefined),
      recordTaskHeartbeat: vi.fn(),
      setBeforeApproveHook: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      loadWorkflow: vi.fn(),
      getOutputTail: vi.fn(() => []),
      appendTaskOutput: vi.fn(),
    };

    rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      executorRegistry: {} as any,
      repoRoot: '/repo',
      invokerConfig: {},
      logger: createLogger() as any,
      taskHandles: new Map(),
      enqueueTaskOutput: vi.fn(),
      flushTaskOutput: vi.fn(),
      assertFatalExecutionCapacity: vi.fn(),
      getTaskRunner: () => currentRunner,
      setTaskRunner: (value) => { currentRunner = value; },
      setLatestTaskExecutor: vi.fn(),
    });

    const config = taskRunnerConstructor.mock.calls[0]?.[0] as any;
    config.callbacks.onLaunchFailed('gone', new Error('boom'), { type: 'worktree' });

    expect(persistence.appendTaskOutput).not.toHaveBeenCalled();
  });

  it('publishes review-gate failure lifecycle events and keeps approve hook routed through the current TaskRunner', async () => {
    let currentRunner: any = null;
    const orchestrator = {
      getTask: vi.fn(),
      recordTaskHeartbeat: vi.fn(),
      setBeforeApproveHook: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      loadWorkflow: vi.fn(() => ({ mergeMode: 'local' })),
    };

    rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      messageBus: createMessageBus() as any,
      executorRegistry: {} as any,
      repoRoot: '/repo',
      invokerConfig: { autoFixCi: true },
      logger: createLogger() as any,
      taskHandles: new Map(),
      enqueueTaskOutput: vi.fn(),
      flushTaskOutput: vi.fn(),
      assertFatalExecutionCapacity: vi.fn(),
      getTaskRunner: () => currentRunner,
      setTaskRunner: (value) => { currentRunner = value; },
      setLatestTaskExecutor: vi.fn(),
    });

    const config = taskRunnerConstructor.mock.calls[0]?.[0] as any;
    await config.reviewGateCiFailurePublisher.publish({ taskId: 'merge-task' });
    expect(publishReviewGateCiFailedLifecycleEvent).toHaveBeenCalledWith(
      { taskId: 'merge-task' },
      expect.objectContaining({ messageBus: expect.any(Object), getTask: expect.any(Function) }),
    );

    const approveHook = orchestrator.setBeforeApproveHook.mock.calls[0]?.[0];
    const mergeTask = {
      config: { isMergeNode: true, workflowId: 'wf-1' },
      execution: {},
    } as TaskState;
    await approveHook(mergeTask);
    expect(currentRunner.approveMerge).toHaveBeenCalledWith('wf-1');

    persistence.loadWorkflow.mockReturnValueOnce({ mergeMode: 'external_review' });
    await approveHook(mergeTask);
    expect(currentRunner.approveMerge).toHaveBeenCalledTimes(1);
  });


  it('kills preempted tasks through TaskRunner so SSH pool capacity is released', async () => {
    const handle = { executionId: 'exec-1', taskId: 'task-1' };
    const executor = { type: 'ssh', kill: vi.fn(async () => undefined) };
    const taskHandles = new Map([[handle.taskId, { handle, executor }]]);
    const taskRunner = {
      killActiveExecution: vi.fn(async () => true),
    };

    await killRunningTaskExecution({
      getTaskRunner: () => taskRunner as any,
      logger: createLogger() as any,
      taskHandles: taskHandles as any,
    }, handle.taskId);

    expect(taskRunner.killActiveExecution).toHaveBeenCalledWith(handle.taskId);
    expect(executor.kill).not.toHaveBeenCalled();
    expect(taskHandles.has(handle.taskId)).toBe(false);
  });

  it('still asks TaskRunner to kill when the app handle map missed the spawned task', async () => {
    const taskHandles = new Map();
    const taskRunner = {
      killActiveExecution: vi.fn(async () => true),
    };

    await killRunningTaskExecution({
      getTaskRunner: () => taskRunner as any,
      logger: createLogger() as any,
      taskHandles: taskHandles as any,
    }, 'task-1');

    expect(taskRunner.killActiveExecution).toHaveBeenCalledWith('task-1');
  });

  it('falls back to the stored handle when TaskRunner no longer has the active entry', async () => {
    const handle = { executionId: 'exec-1', taskId: 'task-1' };
    const executor = { type: 'ssh', kill: vi.fn(async () => undefined) };
    const taskHandles = new Map([[handle.taskId, { handle, executor }]]);
    const taskRunner = {
      killActiveExecution: vi.fn(async () => false),
    };

    await killRunningTaskExecution({
      getTaskRunner: () => taskRunner as any,
      logger: createLogger() as any,
      taskHandles: taskHandles as any,
    }, handle.taskId);

    expect(taskRunner.killActiveExecution).toHaveBeenCalledWith(handle.taskId);
    expect(executor.kill).toHaveBeenCalledWith(handle);
    expect(taskHandles.has(handle.taskId)).toBe(false);
  });
  it('throws the existing follower-mode execution error before dispatch', () => {
    expect(() => requireWiredTaskRunner(() => null)).toThrow(
      'Mutation execution is unavailable in read-only follower mode',
    );
  });

  it('documents task dispatch through the wired TaskRunner executeTasks method', async () => {
    const runner = requireWiredTaskRunner(() => ({
      executeTasks: vi.fn(async () => undefined),
    } as any));
    await runner.executeTasks([{ id: 'task-1' }] as any);
    expect(runner.executeTasks).toHaveBeenCalledWith([{ id: 'task-1' }]);
  });
  it('routes heartbeat metadata through orchestrator-owned task deltas', () => {
    const at = new Date('2026-06-03T02:03:04.000Z');
    const recordTaskHeartbeat = vi.fn();
    const orchestrator = {
      getTask: vi.fn(() => ({ status: 'running', execution: {} })),
      recordTaskHeartbeat,
      setBeforeApproveHook: vi.fn(),
    };

    rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: { updateTask: vi.fn(), loadWorkflow: vi.fn() } as any,
      messageBus: createMessageBus() as any,
      executorRegistry: {} as any,
      repoRoot: '/repo',
      invokerConfig: {},
      logger: createLogger() as any,
      taskHandles: new Map(),
      enqueueTaskOutput: vi.fn(),
      flushTaskOutput: vi.fn(),
      assertFatalExecutionCapacity: vi.fn(),
      getTaskRunner: () => null,
      setTaskRunner: vi.fn(),
      setLatestTaskExecutor: vi.fn(),
    });

    const config = taskRunnerConstructor.mock.calls[0]?.[0] as any;
    config.callbacks.onHeartbeat('task-1', { at, source: 'executor' });

    expect(recordTaskHeartbeat).toHaveBeenCalledWith('task-1', {
      at,
      source: 'executor',
    });
  });
});
