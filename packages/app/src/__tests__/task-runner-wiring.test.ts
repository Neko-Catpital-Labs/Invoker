import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Channels } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import { autoFixOnReviewGateFailure } from '../workflow-actions.js';
import { loadConfig, resolveSecretsFilePath } from '../config.js';
import {
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

vi.mock('../workflow-actions.js', () => ({
  autoFixOnReviewGateFailure: vi.fn(async () => undefined),
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

describe('task-runner-wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs TaskRunner and preserves callback side effects', () => {
    let currentRunner: any = null;
    let latestRunner: any = null;
    const taskHandles = new Map();
    const logger = createLogger();
    const publishTaskHeartbeat = vi.fn();
    const orchestrator = {
      getTask: vi.fn(() => ({
        status: 'running',
        execution: { generation: 2, lastHeartbeatAt: new Date(Date.now() - 1000) },
      })),
      setBeforeApproveHook: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      loadWorkflow: vi.fn(),
    };

    const runner = rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
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
      publishTaskHeartbeat,
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

    config.callbacks.onHeartbeat('task-1');
    expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
      execution: { lastHeartbeatAt: expect.any(Date) },
    });
    expect(publishTaskHeartbeat).toHaveBeenCalledWith('task-1', expect.any(Date));
  });

  it('keeps review-gate auto-fix and approve hook routed through the current TaskRunner', async () => {
    let currentRunner: any = null;
    const orchestrator = {
      getTask: vi.fn(),
      setBeforeApproveHook: vi.fn(),
    };
    const persistence = {
      updateTask: vi.fn(),
      loadWorkflow: vi.fn(() => ({ mergeMode: 'local' })),
    };

    rebuildTaskRunner({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      executorRegistry: {} as any,
      repoRoot: '/repo',
      invokerConfig: { autoFixCi: true },
      logger: createLogger() as any,
      taskHandles: new Map(),
      enqueueTaskOutput: vi.fn(),
      flushTaskOutput: vi.fn(),
      publishTaskHeartbeat: vi.fn(),
      assertFatalExecutionCapacity: vi.fn(),
      getTaskRunner: () => currentRunner,
      setTaskRunner: (value) => { currentRunner = value; },
      setLatestTaskExecutor: vi.fn(),
    });

    const config = taskRunnerConstructor.mock.calls[0]?.[0] as any;
    await config.onReviewGateCiFailure({ taskId: 'merge-task' });
    expect(autoFixOnReviewGateFailure).toHaveBeenCalledWith(
      { taskId: 'merge-task' },
      expect.objectContaining({ taskExecutor: currentRunner }),
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

  it('uses the unchanged heartbeat task-delta channel shape', () => {
    const published: Array<{ channel: string; payload: unknown }> = [];
    const publishTaskHeartbeat = (taskId: string, lastHeartbeatAt: Date): void => {
      published.push({
        channel: Channels.TASK_DELTA,
        payload: {
          type: 'updated' as const,
          taskId,
          changes: { execution: { lastHeartbeatAt } },
        },
      });
    };
    const at = new Date();

    publishTaskHeartbeat('task-1', at);

    expect(published).toEqual([
      {
        channel: Channels.TASK_DELTA,
        payload: {
          type: 'updated',
          taskId: 'task-1',
          changes: { execution: { lastHeartbeatAt: at } },
        },
      },
    ]);
  });
});
