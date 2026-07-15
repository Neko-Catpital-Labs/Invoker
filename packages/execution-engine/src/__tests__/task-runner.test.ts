import { execSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { collectDirectNonMergeTaskIds } from '../merge-runner.js';
import { SshExecutor } from '../ssh-executor.js';
import { WorktreeExecutor } from '../worktree-executor.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse, Logger } from '@invoker/contracts';
import { EventEmitter } from 'events';
import { buildCanonicalPrBody, validateCanonicalPrBody } from '../pr-authoring.js';
import type { PrAuthoringContext } from '../pr-authoring.js';
import { registerBuiltinAgents } from '../agents/index.js';

/**
 * Creates a mock executor that auto-completes on start().
 * For merge nodes (no command/prompt), this simulates the executor's
 * handleProcessExit(0) path which immediately completes.
 */
function createAutoCompleteExecutor() {
  let completeCallback: ((response: WorkResponse) => void) | undefined;
  return {
    type: 'worktree',
    start: vi.fn().mockImplementation(async (request: any) => {
      const handle = {
        executionId: `exec-${request.actionId}`,
        taskId: request.actionId,
        workspacePath: '/tmp/mock-worktree',
        branch: `experiment/${request.actionId}-mock`,
      };
      // Auto-complete after start (simulates no-command path)
      setTimeout(() => {
        if (completeCallback) {
          completeCallback({
            requestId: request.requestId,
            actionId: request.actionId,
            executionGeneration: request.executionGeneration,
            status: 'completed',
            outputs: { exitCode: 0 },
          });
        }
      }, 0);
      return handle;
    }),
    onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
      completeCallback = cb;
    }),
    onOutput: vi.fn(),
    onHeartbeat: vi.fn(),
    kill: vi.fn(),
    destroyAll: vi.fn(),
  };
}

function makeTask(overrides: {
  id?: string;
  description?: string;
  status?: string;
  dependencies?: string[];
  createdAt?: Date;
  config?: Partial<TaskState['config']>;
  execution?: Partial<TaskState['execution']>;
} = {}): TaskState {
  return {
    id: overrides.id ?? 'test',
    description: overrides.description ?? 'Test task',
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? new Date(),
    config: { ...overrides.config },
    execution: { ...overrides.execution },
  } as TaskState;
}

function createExecutorWithTasks(tasks: Map<string, TaskState>): TaskRunner {
  const orchestrator = {
    getTask: (id: string) => tasks.get(id),
  };

  return new TaskRunner({
    orchestrator: orchestrator as any,
    persistence: {} as any,
    executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
    cwd: '/tmp',
  });
}

function createMockLogger(): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  (logger.child as any).mockReturnValue(logger);
  return logger;
}

const tempWorkspaces: string[] = [];
function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-task-executor-test-'));
  tempWorkspaces.push(dir);
  return dir;
}

afterEach(() => {
  while (tempWorkspaces.length > 0) {
    const dir = tempWorkspaces.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('TaskRunner', () => {
  it('closes every current review gate artifact and continues after one close failure', async () => {
    const logger = createMockLogger();
    const closeReview = vi.fn()
      .mockRejectedValueOnce(new Error('first close failed'))
      .mockResolvedValue(undefined);
    const tasks = [
      makeTask({
        id: '__merge__wf-1',
        status: 'review_ready',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: {
          workspacePath: '/tmp/review-workspace',
          reviewGate: {
            activeGeneration: 4,
            completion: { required: 'all', status: 'approved' },
            artifacts: [
              { id: 'contracts', providerId: 'pr-1', required: true, status: 'open', generation: 4 },
              { id: 'runtime', providerId: 'pr-2', required: true, status: 'approved', generation: 4 },
              { id: 'old', providerId: 'pr-old', required: true, status: 'open', generation: 3 },
              { id: 'discarded', providerId: 'pr-discarded', required: true, status: 'discarded', generation: 4 },
              { id: 'local', required: true, status: 'open', generation: 4 },
            ],
          },
        },
      }),
    ];
    const runner = new TaskRunner({
      orchestrator: { getAllTasks: () => tasks } as any,
      persistence: {} as any,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      mergeGateProvider: { closeReview } as any,
      logger,
      cwd: '/tmp/fallback',
    });

    await runner.closeWorkflowReview('wf-1');

    expect(closeReview).toHaveBeenCalledTimes(2);
    expect(closeReview).toHaveBeenNthCalledWith(1, { identifier: 'pr-1', cwd: '/tmp/review-workspace' });
    expect(closeReview).toHaveBeenNthCalledWith(2, { identifier: 'pr-2', cwd: '/tmp/review-workspace' });
    expect(logger.error).toHaveBeenCalledWith('[merge-gate] Failed to close review pr-1', { err: expect.any(Error) });
  });

  it('falls back to scalar review id when no review gate exists', async () => {
    const closeReview = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      makeTask({
        id: '__merge__wf-1',
        status: 'review_ready',
        config: { workflowId: 'wf-1', isMergeNode: true },
        execution: {
          reviewId: 'scalar-pr',
          workspacePath: '/tmp/review-workspace',
        },
      }),
    ];
    const runner = new TaskRunner({
      orchestrator: { getAllTasks: () => tasks } as any,
      persistence: {} as any,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      mergeGateProvider: { closeReview } as any,
      cwd: '/tmp/fallback',
    });

    await runner.closeWorkflowReview('wf-1');

    expect(closeReview).toHaveBeenCalledWith({ identifier: 'scalar-pr', cwd: '/tmp/review-workspace' });
  });
  it('uses configured default execution settings when task overrides are absent', async () => {
    let seenRequest: any;
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => {
        seenRequest = request;
        return {
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `experiment/${request.actionId}-mock`,
        };
      }),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const runner = new TaskRunner({
      orchestrator: { getTask: () => undefined, handleWorkerResponse: vi.fn() } as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: { getDefault: () => executorImpl, get: () => executorImpl, getAll: () => [executorImpl] } as any,
      executionDefaultsProvider: () => ({ executionAgent: 'omp', executionModel: 'chatgpt-5.4' }),
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'default-task',
      status: 'running',
      config: { prompt: 'Fix failing tests' },
      execution: { generation: 2, selectedAttemptId: 'default-task-a1' },
    });

    const done = runner.executeTask(task);
    await vi.waitFor(() => expect(seenRequest?.inputs).toMatchObject({ executionAgent: 'omp', executionModel: 'chatgpt-5.4' }));
    await vi.waitFor(() => expect(completeCallback).toBeTypeOf('function'));
    completeCallback({
      requestId: seenRequest.requestId,
      actionId: task.id,
      attemptId: seenRequest.attemptId,
      executionGeneration: seenRequest.executionGeneration,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await done;
  });
  it('rejects incompatible fix models before spawning the agent', async () => {
    const runner = new TaskRunner({
      orchestrator: { getTask: () => undefined, handleWorkerResponse: vi.fn() } as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: { getDefault: vi.fn(), get: vi.fn(), getAll: vi.fn(() => []) } as any,
      executionAgentRegistry: registerBuiltinAgents(),
      cwd: '/tmp',
    });

    expect(() => runner.spawnAgentFix('Fix the bug', '/tmp', 'codex', 'claude')).toThrow(
      'Execution model "claude" is not supported for execution agent "codex".',
    );
  });

  it('sends attemptId and executionGeneration in work requests and preserves them in responses', async () => {
    const handleWorkerResponse = vi.fn();
    let seenRequest: any;
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => {
        seenRequest = request;
        return {
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `experiment/${request.actionId}-mock`,
        };
      }),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const registry = {
      getDefault: () => executorImpl,
      get: () => executorImpl,
      getAll: () => [executorImpl],
    };
    const orchestrator = {
      getTask: () => undefined,
      handleWorkerResponse,
    };

    const runner = new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: registry as any,
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'gen-task',
      status: 'running',
      config: { command: 'echo hi' },
      execution: { generation: 7, selectedAttemptId: 'gen-task-a1' },
    });

    const done = runner.executeTask(task);
    await vi.waitFor(() => expect(seenRequest?.executionGeneration).toBe(7));
    expect(seenRequest?.attemptId).toBe('gen-task-a1');
    completeCallback?.({
      requestId: seenRequest.requestId,
      actionId: task.id,
      attemptId: seenRequest.attemptId,
      executionGeneration: seenRequest.executionGeneration,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await done;

    expect(handleWorkerResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: task.id,
        attemptId: 'gen-task-a1',
        executionGeneration: 7,
        status: 'completed',
      }),
    );
  });

  it('dispatches newly ready tasks after executor startup failure', async () => {
    const failedTask = makeTask({
      id: 'docker-no-image',
      status: 'running',
      config: { command: 'echo never', runnerKind: 'docker' },
      execution: { selectedAttemptId: 'docker-no-image-a1' },
    });
    const newlyReady = makeTask({
      id: 'docker-concurrent-b',
      status: 'running',
      config: { command: 'sleep 2 && echo done', runnerKind: 'docker' },
      execution: { selectedAttemptId: 'docker-concurrent-b-a1' },
    });

    const handleWorkerResponse = vi.fn(() => [newlyReady]);
    const failingExecutor = {
      type: 'docker',
      start: vi.fn(async () => {
        throw new Error('No such image: invoker-nonexistent-image:v999');
      }),
      onComplete: vi.fn(),
      onOutput: vi.fn(),
      onHeartbeat: vi.fn(),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };

    const runner = new TaskRunner({
      orchestrator: {
        getTask: (id: string) => id === failedTask.id ? failedTask : newlyReady,
        handleWorkerResponse,
      } as any,
      persistence: {
        updateTask: vi.fn(),
        updateAttempt: vi.fn(),
        appendTaskOutput: vi.fn(),
      } as any,
      executorRegistry: {
        getDefault: () => failingExecutor,
        get: () => failingExecutor,
        getAll: () => [failingExecutor],
        deregister: vi.fn(),
      } as any,
      cwd: '/tmp',
    });
    const executeTasksSpy = vi.spyOn(runner, 'executeTasks').mockResolvedValue(undefined);

    await runner.executeTask(failedTask);

    expect(handleWorkerResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'docker-no-image',
        status: 'failed',
      }),
    );
    expect(executeTasksSpy).toHaveBeenCalledWith([newlyReady]);
  });

  it('deduplicates concurrent launches for the same attempt', async () => {
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const start = vi.fn().mockImplementation(async (request: any) => ({
      executionId: `exec-${request.actionId}`,
      taskId: request.actionId,
      workspacePath: '/tmp/mock-worktree',
      branch: `experiment/${request.actionId}-mock`,
    }));
    const executorImpl = {
      type: 'worktree',
      start,
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const registry = {
      getDefault: () => executorImpl,
      get: () => executorImpl,
      getAll: () => [executorImpl],
    };
    const orchestrator = {
      getTask: () => undefined,
      handleWorkerResponse: vi.fn(() => []),
    };

    const runner = new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: registry as any,
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'dup-task',
      status: 'running',
      config: { command: 'echo hi' },
      execution: { selectedAttemptId: 'dup-task-a1' },
    });

    const first = runner.executeTask(task);
    const second = runner.executeTask(task);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    completeCallback?.({
      requestId: 'req-dup-task',
      actionId: task.id,
      attemptId: 'dup-task-a1',
      status: 'completed',
      outputs: { exitCode: 0 },
    });

    await Promise.all([first, second]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('kills the active execution for a task by resolving its current attempt', async () => {
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const kill = vi.fn();
    const handle = {
      executionId: 'exec-kill',
      taskId: 'kill-task',
      workspacePath: '/tmp/mock-worktree',
      branch: 'experiment/kill-task-mock',
    };
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockResolvedValue(handle),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill,
      destroyAll: vi.fn(),
    };
    const registry = {
      getDefault: () => executorImpl,
      get: () => executorImpl,
      getAll: () => [executorImpl],
    };
    const orchestrator = {
      getTask: () => undefined,
      handleWorkerResponse: vi.fn(),
    };
    const runner = new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: registry as any,
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'kill-task',
      status: 'running',
      config: { command: 'echo hi' },
      execution: { selectedAttemptId: 'kill-task-a1' },
    });

    const execution = runner.executeTask(task);
    await vi.waitFor(() => expect(executorImpl.start).toHaveBeenCalledTimes(1));

    await runner.killActiveExecution(task.id);
    expect(kill).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-kill',
      taskId: 'kill-task',
      attemptId: 'kill-task-a1',
    }));

    completeCallback?.({
      requestId: 'req-kill',
      actionId: task.id,
      attemptId: 'kill-task-a1',
      executionGeneration: 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await execution;
  });

  it('kills the selected attempt when an older attempt for the same task is still active', async () => {
    const completeCallbacks = new Map<string, (response: WorkResponse) => void>();
    const kill = vi.fn();
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => ({
        executionId: `exec-${request.attemptId}`,
        taskId: request.actionId,
        workspacePath: `/tmp/mock-worktree-${request.attemptId}`,
        branch: `experiment/${request.attemptId}-mock`,
      })),
      onComplete: vi.fn().mockImplementation((handle: any, cb: any) => {
        completeCallbacks.set(handle.executionId.replace(/^exec-/, ''), cb);
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill,
      destroyAll: vi.fn(),
    };
    const registry = {
      getDefault: () => executorImpl,
      get: () => executorImpl,
      getAll: () => [executorImpl],
    };
    const currentTask = makeTask({
      id: 'kill-selected-task',
      status: 'running',
      config: { command: 'echo current' },
      execution: { selectedAttemptId: 'kill-selected-task-a2' },
    });
    const orchestrator = {
      getTask: (id: string) => id === currentTask.id ? currentTask : undefined,
      handleWorkerResponse: vi.fn(() => []),
    };
    const runner = new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: registry as any,
      cwd: '/tmp',
    });

    const oldAttemptTask = makeTask({
      id: currentTask.id,
      status: 'running',
      config: { command: 'echo old' },
      execution: { selectedAttemptId: 'kill-selected-task-a1' },
    });
    const selectedAttemptTask = makeTask({
      id: currentTask.id,
      status: 'running',
      config: { command: 'echo current' },
      execution: { selectedAttemptId: 'kill-selected-task-a2' },
    });

    const oldExecution = runner.executeTask(oldAttemptTask);
    const selectedExecution = runner.executeTask(selectedAttemptTask);
    await vi.waitFor(() => expect(executorImpl.start).toHaveBeenCalledTimes(2));

    await runner.killActiveExecution(currentTask.id);

    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(expect.objectContaining({
      executionId: 'exec-kill-selected-task-a2',
      taskId: currentTask.id,
      attemptId: 'kill-selected-task-a2',
    }));

    completeCallbacks.get('kill-selected-task-a1')?.({
      requestId: 'req-kill-old',
      actionId: currentTask.id,
      attemptId: 'kill-selected-task-a1',
      executionGeneration: 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    completeCallbacks.get('kill-selected-task-a2')?.({
      requestId: 'req-kill-selected',
      actionId: currentTask.id,
      attemptId: 'kill-selected-task-a2',
      executionGeneration: 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await Promise.all([oldExecution, selectedExecution]);
  });

  it('kills an older active attempt when the selected attempt has no live execution', async () => {
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const kill = vi.fn().mockResolvedValue(undefined);
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => ({
        executionId: `exec-${request.attemptId}`,
        taskId: request.actionId,
        attemptId: request.attemptId,
        workspacePath: `/tmp/mock-worktree-${request.attemptId}`,
        branch: `experiment/${request.attemptId}-mock`,
      })),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill,
      destroyAll: vi.fn(),
    };
    const registry = {
      getDefault: () => executorImpl,
      get: () => executorImpl,
      getAll: () => [executorImpl],
    };
    const currentTask = makeTask({
      id: 'stale-active-task',
      status: 'running',
      config: { command: 'echo current' },
      execution: { selectedAttemptId: 'stale-active-task-a2' },
    });
    const orchestrator = {
      getTask: (id: string) => id === currentTask.id ? currentTask : undefined,
      handleWorkerResponse: vi.fn(() => []),
    };
    const runner = new TaskRunner({
      orchestrator: orchestrator as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: registry as any,
      cwd: '/tmp',
    });

    const staleExecution = runner.executeTask(makeTask({
      id: currentTask.id,
      status: 'running',
      config: { command: 'echo stale' },
      execution: { selectedAttemptId: 'stale-active-task-a1' },
    }));
    await vi.waitFor(() => expect(executorImpl.start).toHaveBeenCalledTimes(1));

    await expect(runner.killActiveExecution(currentTask.id)).resolves.toBe(true);
    expect(kill).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'stale-active-task-a1',
      taskId: currentTask.id,
    }));

    completeCallback?.({
      requestId: 'req-stale-active',
      actionId: currentTask.id,
      attemptId: 'stale-active-task-a1',
      executionGeneration: 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await staleExecution;
  });

  it('marks recreateTask-style executions as requiring a fresh workspace', async () => {
    let seenRequest: any;
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => {
        seenRequest = request;
        return {
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `experiment/${request.actionId}-mock`,
        };
      }),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      } as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: {
        getDefault: () => executorImpl,
        get: () => executorImpl,
        getAll: () => [executorImpl],
      } as any,
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'recreated-task',
      status: 'running',
      config: { command: 'echo hi' },
      execution: {
        generation: 1,
        branch: undefined,
        workspacePath: undefined,
      },
    });

    const done = runner.executeTask(task);
    await vi.waitFor(() => expect(seenRequest).toBeDefined());
    expect(seenRequest.inputs.freshWorkspace).toBe(true);
    completeCallback?.({
      requestId: seenRequest.requestId,
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await done;
  });

  it('marks recreateWorkflow-style root task executions as requiring a fresh workspace', async () => {
    let seenRequest: any;
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => {
        seenRequest = request;
        return {
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `experiment/${request.actionId}-mock`,
        };
      }),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      } as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: {
        getDefault: () => executorImpl,
        get: () => executorImpl,
        getAll: () => [executorImpl],
      } as any,
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'wf-1/root-a',
      status: 'running',
      config: { command: 'echo hi', workflowId: 'wf-1' },
      execution: {
        generation: 3,
        branch: undefined,
        workspacePath: undefined,
      },
    });

    const done = runner.executeTask(task);
    await vi.waitFor(() => expect(seenRequest).toBeDefined());
    expect(seenRequest.inputs.freshWorkspace).toBe(true);
    completeCallback?.({
      requestId: seenRequest.requestId,
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await done;
  });

  it('keeps restart-style executions reusable when branch or workspace state is still present', async () => {
    let seenRequest: any;
    let completeCallback: ((response: WorkResponse) => void) | undefined;
    const executorImpl = {
      type: 'worktree',
      start: vi.fn().mockImplementation(async (request: any) => {
        seenRequest = request;
        return {
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `experiment/${request.actionId}-mock`,
        };
      }),
      onComplete: vi.fn().mockImplementation((_handle: any, cb: any) => {
        completeCallback = cb;
        return () => {};
      }),
      onOutput: vi.fn().mockReturnValue(() => {}),
      onHeartbeat: vi.fn().mockReturnValue(() => {}),
      kill: vi.fn(),
      destroyAll: vi.fn(),
    };
    const runner = new TaskRunner({
      orchestrator: {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      } as any,
      persistence: { updateTask: vi.fn() } as any,
      executorRegistry: {
        getDefault: () => executorImpl,
        get: () => executorImpl,
        getAll: () => [executorImpl],
      } as any,
      cwd: '/tmp',
    });

    const task = makeTask({
      id: 'restart-task',
      status: 'running',
      config: { command: 'echo hi' },
      execution: {
        generation: 1,
        branch: 'experiment/restart-task-old',
        workspacePath: '/tmp/existing-worktree',
      },
    });

    const done = runner.executeTask(task);
    await vi.waitFor(() => expect(seenRequest).toBeDefined());
    expect(seenRequest.inputs.freshWorkspace).toBe(false);
    completeCallback?.({
      requestId: seenRequest.requestId,
      actionId: task.id,
      executionGeneration: task.execution.generation ?? 0,
      status: 'completed',
      outputs: { exitCode: 0 },
    });
    await done;
  });

  describe('collectDirectNonMergeTaskIds', () => {
    it('returns only direct non-merge dependencies', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('verify-ui-tests', makeTask({ id: 'verify-ui-tests', dependencies: [] }));
      tasks.set('distinguish', makeTask({ id: 'distinguish', dependencies: ['verify-ui-tests'] }));
      const merge = makeTask({
        id: '__merge__wf-1',
        dependencies: ['distinguish'],
        config: { isMergeNode: true },
      });
      const ids = collectDirectNonMergeTaskIds(merge, (id) => tasks.get(id));
      expect([...ids].sort()).toEqual(['distinguish']);
    });

    it('excludes direct dependencies that are merge nodes', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('a', makeTask({ id: 'a', dependencies: [] }));
      const innerMerge = makeTask({ id: '__merge__inner', dependencies: ['a'], config: { isMergeNode: true } });
      tasks.set('__merge__inner', innerMerge);
      tasks.set('b', makeTask({ id: 'b', dependencies: ['__merge__inner'] }));
      const rootMerge = makeTask({
        id: '__merge__root',
        dependencies: ['b'],
        config: { isMergeNode: true },
      });
      const ids = collectDirectNonMergeTaskIds(rootMerge, (id) => tasks.get(id));
      expect([...ids].sort()).toEqual(['b']);
    });
  });

  describe('collectUpstreamBranches', () => {
    it('collects branches from completed dependencies', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-1', makeTask({
        id: 'dep-1',
        status: 'completed',
        execution: { branch: 'experiment/dep-1' },
      }));
      tasks.set('dep-2', makeTask({
        id: 'dep-2',
        status: 'completed',
        execution: { branch: 'experiment/dep-2' },
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-1', 'dep-2'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual(['experiment/dep-1', 'experiment/dep-2']);
    });

    it('excludes local dependencies without a branch field', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-with-branch', makeTask({
        id: 'dep-with-branch',
        status: 'completed',
        execution: { branch: 'experiment/dep-with-branch' },
      }));
      tasks.set('dep-worktree', makeTask({
        id: 'dep-worktree',
        status: 'completed',
        config: { runnerKind: 'worktree' },
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-with-branch', 'dep-worktree'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual(['experiment/dep-with-branch']);
    });

    it('excludes non-completed dependencies', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-running', makeTask({
        id: 'dep-running',
        status: 'running',
        execution: { branch: 'experiment/dep-running' },
      }));
      tasks.set('dep-failed', makeTask({
        id: 'dep-failed',
        status: 'failed',
        execution: { branch: 'experiment/dep-failed' },
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-running', 'dep-failed'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual([]);
    });

    it('returns empty array for tasks with no dependencies', () => {
      const executor = createExecutorWithTasks(new Map());
      const task = makeTask({ id: 'root', dependencies: [] });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual([]);
    });

    it('handles missing dependency tasks gracefully', () => {
      const executor = createExecutorWithTasks(new Map());
      const task = makeTask({
        id: 'child',
        dependencies: ['nonexistent'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual([]);
    });

    it('collects branch from reconciliation with propagated winner branch', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('recon', makeTask({
        id: 'recon',
        status: 'completed',
        config: { isReconciliation: true },
        execution: {
          selectedExperiment: 'exp-v1',
          branch: 'experiment/exp-v1-abc12345',
        },
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'downstream',
        dependencies: ['recon'],
      });

      const branches = executor.collectUpstreamBranches(task);
      expect(branches).toEqual(['experiment/exp-v1-abc12345']);
    });

    it('diamond: collects branches from both deps in dependency order', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-b', makeTask({
        id: 'dep-b',
        status: 'completed',
        execution: { branch: 'experiment/dep-b' },
      }));
      tasks.set('dep-c', makeTask({
        id: 'dep-c',
        status: 'completed',
        execution: { branch: 'experiment/dep-c' },
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'dep-d',
        dependencies: ['dep-b', 'dep-c'],
      });

      const branches = executor.collectUpstreamBranches(task);
      // Order matches dependency array order
      expect(branches).toEqual(['experiment/dep-b', 'experiment/dep-c']);
    });

    it('fan-out: same parent branch collected by multiple children independently', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('parent', makeTask({
        id: 'parent',
        status: 'completed',
        execution: { branch: 'experiment/parent' },
      }));

      const executor = createExecutorWithTasks(tasks);

      const childB = makeTask({ id: 'child-b', dependencies: ['parent'] });
      const childC = makeTask({ id: 'child-c', dependencies: ['parent'] });

      expect(executor.collectUpstreamBranches(childB)).toEqual(['experiment/parent']);
      expect(executor.collectUpstreamBranches(childC)).toEqual(['experiment/parent']);
    });

    it('fan-in: prepends workflow baseBranch when two or more upstream branches exist', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
        execution: { branch: 'experiment/dep-a' },
      }));
      tasks.set('dep-b', makeTask({
        id: 'dep-b',
        status: 'completed',
        execution: { branch: 'experiment/dep-b' },
      }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-1', baseBranch: 'origin/main' }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const child = makeTask({
        id: 'fan-in-child',
        dependencies: ['dep-a', 'dep-b'],
        config: { workflowId: 'wf-1' },
      });

      expect(executor.collectUpstreamBranches(child)).toEqual([
        'origin/main',
        'experiment/dep-a',
        'experiment/dep-b',
      ]);
    });

    it('includes completed external dependency branches', () => {
      const externalTasks = new Map<string, TaskState>();
      externalTasks.set('wf-ext/gate-task', makeTask({
        id: 'wf-ext/gate-task',
        status: 'completed',
        execution: { branch: 'experiment/wf-ext/gate-task-abc123' },
      }));

      const orchestrator = {
        getTask: (id: string) => externalTasks.get(id),
      };
      const persistence = {
        loadTasks: (workflowId: string) => workflowId === 'wf-ext'
          ? [externalTasks.get('wf-ext/gate-task')!]
          : [],
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'wf-local/downstream',
        config: {
          workflowId: 'wf-local',
          externalDependencies: [{ workflowId: 'wf-ext', taskId: 'gate-task', requiredStatus: 'completed' }],
        },
      });

      expect(executor.collectUpstreamBranches(task)).toEqual(['experiment/wf-ext/gate-task-abc123']);
    });
  });

  describe('executeTask error handling', () => {
    it('sends failed WorkResponse when executor.start throws', async () => {
      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse,
      };
      const throwingExecutor = {
        type: 'worktree',
        start: async () => { throw new Error('worktree creation failed'); },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onComplete = vi.fn();

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const task = makeTask({ id: 'failing-start', status: 'running', config: { command: 'echo hi' } });
      await executor.executeTask(task);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'failing-start',
          status: 'failed',
        }),
      );
      expect(onComplete).toHaveBeenCalled();
    });

    it('appends a durable diagnostic block for startup stderr/stdout', async () => {
      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse,
      };
      const startupError = Object.assign(new Error('spawn failed before handle'), {
        stderr: 'remote setup stderr\nmissing dependency\n',
        stdout: 'remote setup stdout\n',
      });
      const throwingExecutor = {
        type: 'ssh',
        start: async () => { throw startupError; },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const appendTaskOutput = vi.fn();
      const onOutput = vi.fn();

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onOutput },
      });

      const task = makeTask({ id: 'failing-start', status: 'running', config: { command: 'echo hi' } });
      await executor.executeTask(task);

      expect(onOutput).toHaveBeenCalledWith(
        'failing-start',
        expect.stringContaining('Executor startup failed (ssh): spawn failed before handle'),
      );
      expect(appendTaskOutput).toHaveBeenCalledWith(
        'failing-start',
        expect.stringContaining('[Startup Failure Diagnostic]'),
      );
      const output = appendTaskOutput.mock.calls[0]?.[1] as string;
      expect(output).toContain('executor=ssh');
      expect(output).toContain('message=spawn failed before handle');
      expect(output).toContain('--- startup stderr ---');
      expect(output).toContain('missing dependency');
      expect(output).toContain('--- startup stdout ---');
      expect(output).toContain('remote setup stdout');
      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          outputs: expect.objectContaining({ exitCode: 1 }),
        }),
      );
    });

    it('startup error includes phase prefix in outputs.error', async () => {
      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse,
      };
      const throwingExecutor = {
        type: 'worktree',
        start: async () => { throw new Error('bad key'); },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onComplete = vi.fn();

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const task = makeTask({ id: 'failing-start', status: 'running', config: { command: 'echo hi' } });
      await executor.executeTask(task);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: expect.objectContaining({
            error: expect.stringContaining('Executor startup failed (worktree): bad key'),
          }),
        }),
      );
    });

    it('startup error includes stack trace in outputs.error', async () => {
      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse,
      };
      const throwingExecutor = {
        type: 'worktree',
        start: async () => { throw new Error('bad key'); },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onComplete = vi.fn();

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const task = makeTask({ id: 'failing-start', status: 'running', config: { command: 'echo hi' } });
      await executor.executeTask(task);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: expect.objectContaining({
            error: expect.stringContaining('at '),
          }),
        }),
      );
    });

    it('persists startup metadata from executor errors before failing task', async () => {
      const handleWorkerResponse = vi.fn();
      const updateTask = vi.fn();
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse,
      };
      const startupErr: any = new Error('merge conflict');
      startupErr.workspacePath = '~/.invoker/worktrees/repo/task-1';
      startupErr.branch = 'experiment/task-1-abc12345';
      startupErr.agentSessionId = 'sess-start-1';
      const throwingExecutor = {
        type: 'ssh',
        start: async () => { throw startupErr; },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'failing-start',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'ssh' as any },
      });
      await executor.executeTask(task);

      expect(updateTask).toHaveBeenCalledWith('failing-start', {
        config: { runnerKind: 'ssh' },
        execution: {
          workspacePath: '~/.invoker/worktrees/repo/task-1',
          branch: 'experiment/task-1-abc12345',
          agentSessionId: 'sess-start-1',
          lastAgentSessionId: 'sess-start-1',
        },
      });
      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: expect.objectContaining({
            error: expect.stringContaining('Executor startup failed (ssh): merge conflict'),
          }),
        }),
      );
    });
  });

  describe('stale startup-failure lineage guard', () => {
    it('suppresses metadata write and failed response when selectedAttemptId has advanced', async () => {
      const handleWorkerResponse = vi.fn();
      const updateTask = vi.fn();
      // Orchestrator returns a task whose selectedAttemptId has moved forward
      const orchestrator = {
        getTask: () => makeTask({
          id: 'stale-1',
          status: 'running',
          execution: { selectedAttemptId: 'attempt-2', generation: 0 },
        }),
        handleWorkerResponse,
      };
      const startupErr: any = new Error('SSH connection refused');
      startupErr.workspacePath = '/tmp/stale-worktree';
      startupErr.branch = 'experiment/stale-branch';
      const throwingExecutor = {
        type: 'ssh',
        start: async () => { throw startupErr; },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onLaunchFailed = vi.fn();

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask, logEvent: vi.fn() } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onLaunchFailed },
      });

      // Task was launched with attempt-1 but orchestrator now shows attempt-2
      const task = makeTask({
        id: 'stale-1',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'ssh' as any },
        execution: { selectedAttemptId: 'attempt-1', generation: 0 },
      });
      await runner.executeTask(task);

      // Startup-failure metadata must NOT be persisted
      expect(updateTask).not.toHaveBeenCalledWith(
        'stale-1',
        expect.objectContaining({
          execution: expect.objectContaining({ workspacePath: '/tmp/stale-worktree' }),
        }),
      );
      // Failed WorkResponse must NOT be emitted
      expect(handleWorkerResponse).not.toHaveBeenCalled();
      expect(onLaunchFailed).not.toHaveBeenCalled();
    });

    it('suppresses metadata write and failed response when generation has advanced', async () => {
      const handleWorkerResponse = vi.fn();
      const updateTask = vi.fn();
      // Orchestrator returns a task whose generation has bumped
      const orchestrator = {
        getTask: () => makeTask({
          id: 'stale-gen',
          status: 'running',
          execution: { generation: 2 },
        }),
        handleWorkerResponse,
      };
      const startupErr: any = new Error('provision failed');
      startupErr.workspacePath = '/tmp/old-worktree';
      startupErr.branch = 'experiment/old-branch';
      const throwingExecutor = {
        type: 'ssh',
        start: async () => { throw startupErr; },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onLaunchFailed = vi.fn();

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask, logEvent: vi.fn() } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onLaunchFailed },
      });

      const task = makeTask({
        id: 'stale-gen',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'ssh' as any },
        execution: { generation: 1 },
      });
      await runner.executeTask(task);

      // Metadata must not be written for the old generation
      expect(updateTask).not.toHaveBeenCalledWith(
        'stale-gen',
        expect.objectContaining({
          execution: expect.objectContaining({ workspacePath: '/tmp/old-worktree' }),
        }),
      );
      expect(handleWorkerResponse).not.toHaveBeenCalled();
      expect(onLaunchFailed).not.toHaveBeenCalled();
    });

    it('still persists metadata and emits response when lineage is current', async () => {
      const handleWorkerResponse = vi.fn();
      const updateTask = vi.fn();
      // Orchestrator returns a task with matching lineage
      const orchestrator = {
        getTask: () => makeTask({
          id: 'current-1',
          status: 'running',
          execution: { selectedAttemptId: 'attempt-1', generation: 0 },
        }),
        handleWorkerResponse,
      };
      const startupErr: any = new Error('git clone failed');
      startupErr.workspacePath = '/tmp/current-worktree';
      startupErr.branch = 'experiment/current-branch';
      const throwingExecutor = {
        type: 'ssh',
        start: async () => { throw startupErr; },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onLaunchFailed = vi.fn();

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onLaunchFailed },
      });

      const task = makeTask({
        id: 'current-1',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'ssh' as any },
        execution: { selectedAttemptId: 'attempt-1', generation: 0 },
      });
      await runner.executeTask(task);

      // Metadata SHOULD be persisted when lineage is current
      expect(updateTask).toHaveBeenCalledWith('current-1', {
        config: { runnerKind: 'ssh' },
        execution: {
          workspacePath: '/tmp/current-worktree',
          branch: 'experiment/current-branch',
        },
      });
      // Failed WorkResponse SHOULD be emitted
      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'current-1',
          status: 'failed',
        }),
      );
      expect(onLaunchFailed).toHaveBeenCalledWith(
        'current-1',
        expect.objectContaining({ message: expect.stringContaining('Executor startup failed (ssh)') }),
        throwingExecutor,
      );
    });

    it('suppresses both inner metadata and outer response when lineage is stale throughout', async () => {
      const handleWorkerResponse = vi.fn();
      const updateTask = vi.fn();
      const orchestrator = {
        getTask: () => makeTask({
          id: 'inner-stale',
          status: 'running',
          execution: { selectedAttemptId: 'attempt-new', generation: 0 },
        }),
        handleWorkerResponse,
      };
      const startupErr: any = new Error('timeout');
      startupErr.workspacePath = '/tmp/inner-stale-ws';
      startupErr.branch = 'experiment/inner-stale';
      startupErr.agentSessionId = 'sess-old';
      const throwingExecutor = {
        type: 'ssh',
        start: async () => { throw startupErr; },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingExecutor,
        get: () => throwingExecutor,
        getAll: () => [throwingExecutor],
      };
      const onLaunchFailed = vi.fn();

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask, logEvent: vi.fn() } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        callbacks: { onLaunchFailed },
      });

      const task = makeTask({
        id: 'inner-stale',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'ssh' as any },
        execution: { selectedAttemptId: 'attempt-old', generation: 0 },
      });
      await runner.executeTask(task);

      // Neither inner metadata nor outer response should be written
      expect(updateTask).not.toHaveBeenCalledWith(
        'inner-stale',
        expect.objectContaining({
          execution: expect.objectContaining({ workspacePath: '/tmp/inner-stale-ws' }),
        }),
      );
      expect(handleWorkerResponse).not.toHaveBeenCalled();
      expect(onLaunchFailed).not.toHaveBeenCalled();
    });
  });

  describe('post-start lineage guard (generation)', () => {
    // Builds a runner whose executor.start() RESOLVES with a handle (the
    // success path), with a mutable live task so the test can advance its
    // generation while keeping selectedAttemptId fixed.
    function makePostStartEnv(launchGeneration: number) {
      const handle = {
        executionId: 'exec-post-start',
        taskId: 'gen-task',
        workspacePath: '/tmp/post-start-ws',
        branch: 'experiment/post-start-branch',
        agentSessionId: 'sess-post-start',
        containerId: 'container-post-start',
      };
      let completeCallback: ((response: WorkResponse) => void) | undefined;
      let resolveStart: (() => void) | undefined;
      const executor = {
        type: 'worktree',
        // Default: resolve immediately. Tests that need to advance the
        // generation mid-start override `start` before launching.
        start: vi.fn(async () => handle),
        startDeferred: () => {
          executor.start = vi.fn(() => new Promise((res) => {
            resolveStart = () => res(handle);
          }));
        },
        resolveStart: () => resolveStart?.(),
        onComplete: vi.fn((_h: any, cb: any) => { completeCallback = cb; }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn().mockResolvedValue(undefined),
        destroyAll: vi.fn(),
      };
      const liveTask = makeTask({
        id: 'gen-task',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'worktree' as any },
        execution: { selectedAttemptId: 'attempt-1', generation: launchGeneration },
      });
      const markTaskRunningAfterLaunch = vi.fn(() => true);
      const handleWorkerResponse = vi.fn(() => []);
      const orchestrator = {
        getTask: () => liveTask,
        getAllTasks: () => [liveTask],
        markTaskRunningAfterLaunch,
        handleWorkerResponse,
      };
      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const logEvent = vi.fn();
      const onSpawned = vi.fn();
      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {
          updateTask,
          updateAttempt,
          logEvent,
          loadAttempts: () => [],
          appendTaskOutput: vi.fn(),
        } as any,
        executorRegistry: {
          getDefault: () => executor,
          get: () => executor,
          getAll: () => [executor],
        } as any,
        cwd: '/tmp',
        callbacks: { onSpawned },
      });
      const launchTask = makeTask({
        id: 'gen-task',
        status: 'running',
        config: { command: 'echo hi', runnerKind: 'worktree' as any },
        execution: { selectedAttemptId: 'attempt-1', generation: launchGeneration },
      });
      const triggerComplete = () => completeCallback?.({
        requestId: 'req-post-start',
        actionId: 'gen-task',
        attemptId: 'attempt-1',
        executionGeneration: launchGeneration,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
      return {
        runner, executor, handle, liveTask, launchTask, triggerComplete,
        markTaskRunningAfterLaunch, handleWorkerResponse, updateTask, updateAttempt,
        logEvent, onSpawned,
      };
    }

    const tick = () => new Promise<void>((r) => setImmediate(r));

    it('rejects a launch whose start resolves after the generation advances (attempt unchanged)', async () => {
      const env = makePostStartEnv(1);
      env.executor.startDeferred();

      const run = env.runner.executeTask(env.launchTask);
      await tick();
      expect(env.executor.start).toHaveBeenCalledTimes(1);

      // Generation advances to N+1 while the attempt id is unchanged, then
      // the in-flight start resolves.
      env.liveTask.execution.generation = 2;
      env.executor.resolveStart();
      await run;

      // Stale post-start metadata must NOT be written to the task row.
      expect(env.updateTask).not.toHaveBeenCalledWith(
        'gen-task',
        expect.objectContaining({
          execution: expect.objectContaining({ workspacePath: '/tmp/post-start-ws' }),
        }),
      );
      expect(env.updateAttempt).not.toHaveBeenCalledWith(
        'attempt-1',
        expect.objectContaining({ workspacePath: '/tmp/post-start-ws' }),
      );
      // A stale generation must never be marked running.
      expect(env.markTaskRunningAfterLaunch).not.toHaveBeenCalled();
      // The spawned handle is killed, consistent with the stale-attempt path.
      expect(env.executor.kill).toHaveBeenCalledWith(env.handle);
      // No active execution is registered, and no completion is processed.
      expect((env.runner as any).activeExecutions.size).toBe(0);
      expect(env.onSpawned).not.toHaveBeenCalled();
      expect(env.handleWorkerResponse).not.toHaveBeenCalled();
      expect(env.logEvent).toHaveBeenCalledWith(
        'gen-task',
        'task.executor.stale_post_start',
        expect.objectContaining({ startGeneration: 1, currentGeneration: 2 }),
      );
    });

    it('fails the dispatch and kills the handle when generation advances during start', async () => {
      const env = makePostStartEnv(1);
      env.executor.startDeferred();
      const completeCalls: number[] = [];
      const failCalls: Array<[number, unknown]> = [];
      const launchOutbox = {
        completeDispatch(id: number) { completeCalls.push(id); return true; },
        failDispatch(id: number, err: unknown) { failCalls.push([id, err]); return true; },
      };

      const run = env.runner.executeTask(env.launchTask, { dispatchId: 55, launchOutbox });
      await tick();
      env.liveTask.execution.generation = 2;
      env.executor.resolveStart();
      await run;

      expect(env.executor.kill).toHaveBeenCalledWith(env.handle);
      expect(completeCalls).toHaveLength(0);
      expect(failCalls).toHaveLength(1);
      expect(failCalls[0][0]).toBe(55);
      expect((failCalls[0][1] as Error).message).toMatch(/Launch rejected/);
    });

    it('persists metadata and registers the active execution when lineage is current', async () => {
      const env = makePostStartEnv(1); // launch and live both at generation 1

      const run = env.runner.executeTask(env.launchTask);
      await tick();

      // Valid launch persists workspace/branch/session metadata.
      expect(env.updateTask).toHaveBeenCalledWith(
        'gen-task',
        expect.objectContaining({
          execution: expect.objectContaining({
            workspacePath: '/tmp/post-start-ws',
            branch: 'experiment/post-start-branch',
            agentSessionId: 'sess-post-start',
            containerId: 'container-post-start',
          }),
        }),
      );
      expect(env.markTaskRunningAfterLaunch).toHaveBeenCalledWith('gen-task', 'attempt-1');
      expect(env.onSpawned).toHaveBeenCalled();
      expect((env.runner as any).activeExecutions.size).toBe(1);
      expect(env.executor.kill).not.toHaveBeenCalled();

      env.triggerComplete();
      await run;
      expect(env.handleWorkerResponse).toHaveBeenCalled();
    });
  });

  describe('upstream branch metadata guard', () => {
    it('fails task when a completed worktree dep has no branch', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
        config: { runnerKind: 'worktree' },
      }));

      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        handleWorkerResponse,
      };
      const onComplete = vi.fn();

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-a'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('completed without branch metadata'),
          }),
        }),
      );
    });

    it('fails task when a completed external dependency has no branch metadata', async () => {
      const externalTasks = new Map<string, TaskState>();
      externalTasks.set('wf-ext/verify', makeTask({
        id: 'wf-ext/verify',
        status: 'completed',
      }));

      const handleWorkerResponse = vi.fn();
      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => externalTasks.get(id),
          handleWorkerResponse,
        } as any,
        persistence: {
          loadTasks: (workflowId: string) => workflowId === 'wf-ext'
            ? [externalTasks.get('wf-ext/verify')!]
            : [],
          updateTask: vi.fn(),
        } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'wf-local/child-task',
        status: 'running',
        config: {
          command: 'echo test',
          externalDependencies: [{ workflowId: 'wf-ext', taskId: 'verify', requiredStatus: 'completed' }],
        },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'wf-local/child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('external dependency "wf-ext/verify" completed without branch metadata'),
          }),
        }),
      );
    });

    it('passes external dependency branches through WorkRequest upstreamBranches', async () => {
      let capturedRequest: any;
      const externalTasks = new Map<string, TaskState>();
      externalTasks.set('wf-ext/verify', makeTask({
        id: 'wf-ext/verify',
        status: 'completed',
        description: 'external verify',
        execution: {
          branch: 'experiment/wf-ext/verify-abc123',
          commit: 'abc123',
        },
      }));

      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-1', taskId: 'wf-local/child-task' };
        },
        onOutput: () => () => {},
        onComplete: (_h: any, cb: any) => {
          cb({ requestId: 'r', actionId: 'wf-local/child-task', status: 'completed', outputs: { exitCode: 0 } });
          return () => {};
        },
        onHeartbeat: () => () => {},
      };

      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => externalTasks.get(id),
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: {
          loadTasks: (workflowId: string) => workflowId === 'wf-ext'
            ? [externalTasks.get('wf-ext/verify')!]
            : [],
          updateTask: vi.fn(),
        } as any,
        executorRegistry: {
          getDefault: () => capturingExecutor,
          get: () => capturingExecutor,
          getAll: () => [capturingExecutor],
        } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'wf-local/child-task',
        status: 'running',
        config: {
          command: 'echo test',
          externalDependencies: [{ workflowId: 'wf-ext', taskId: 'verify', requiredStatus: 'completed' }],
        },
      });

      await executor.executeTask(child);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.upstreamBranches).toEqual(['experiment/wf-ext/verify-abc123']);
      expect(capturedRequest.inputs.upstreamContext).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ taskId: 'wf-ext/verify' }),
        ]),
      );
    });

    it('rejects completed worktree dep with no branch (no type exceptions)', async () => {
      const handleWorkerResponse = vi.fn();
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-worktree', makeTask({
        id: 'dep-worktree',
        status: 'completed',
        config: { runnerKind: 'worktree' },
      }));

      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => tasks.get(id),
          handleWorkerResponse,
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => ({ type: 'worktree' }),
          get: () => ({ type: 'worktree' }),
          getAll: () => [{ type: 'worktree' }],
        } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-worktree'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('completed without branch metadata'),
          }),
        }),
      );
    });

    it('allows completed dep with branch (happy path)', async () => {
      let capturedRequest: any;
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
        execution: { branch: 'experiment/dep-a-abc123' },
      }));

      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-1', taskId: 'child-task' };
        },
        onOutput: () => () => {},
        onComplete: (_h: any, cb: any) => {
          cb({ requestId: 'r', actionId: 'child-task', status: 'completed', outputs: { exitCode: 0 } });
          return () => {};
        },
        onHeartbeat: () => () => {},
      };

      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => tasks.get(id),
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => capturingExecutor,
          get: () => capturingExecutor,
          getAll: () => [capturingExecutor],
        } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-a'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.upstreamBranches).toEqual(['experiment/dep-a-abc123']);
    });

    it('fails when dep has no runnerKind set and no branch', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
      }));

      const handleWorkerResponse = vi.fn();
      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => tasks.get(id),
          handleWorkerResponse,
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-a'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('completed without branch metadata'),
          }),
        }),
      );
    });
  });

  describe('upstream branch metadata guard', () => {
    it('fails task when a completed worktree dep has no branch', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
        config: { runnerKind: 'worktree' },
      }));

      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        handleWorkerResponse,
      };
      const onComplete = vi.fn();

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-a'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('completed without branch metadata'),
          }),
        }),
      );
    });

    it('rejects completed worktree dep with no branch (no type exceptions)', async () => {
      const handleWorkerResponse = vi.fn();
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-worktree', makeTask({
        id: 'dep-worktree',
        status: 'completed',
        config: { runnerKind: 'worktree' },
      }));

      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => tasks.get(id),
          handleWorkerResponse,
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => ({ type: 'worktree' }),
          get: () => ({ type: 'worktree' }),
          getAll: () => [{ type: 'worktree' }],
        } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-worktree'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('completed without branch metadata'),
          }),
        }),
      );
    });

    it('allows completed dep with branch (happy path)', async () => {
      let capturedRequest: any;
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
        execution: { branch: 'experiment/dep-a-abc123' },
      }));

      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-1', taskId: 'child-task' };
        },
        onOutput: () => () => {},
        onComplete: (_h: any, cb: any) => {
          cb({ requestId: 'r', actionId: 'child-task', status: 'completed', outputs: { exitCode: 0 } });
          return () => {};
        },
        onHeartbeat: () => () => {},
      };

      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => tasks.get(id),
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => capturingExecutor,
          get: () => capturingExecutor,
          getAll: () => [capturingExecutor],
        } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-a'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.upstreamBranches).toEqual(['experiment/dep-a-abc123']);
    });

    it('fails when dep has no runnerKind set and no branch', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
      }));

      const handleWorkerResponse = vi.fn();
      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => tasks.get(id),
          handleWorkerResponse,
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const child = makeTask({
        id: 'child-task',
        status: 'running',
        dependencies: ['dep-a'],
        config: { command: 'echo test' },
      });

      await executor.executeTask(child);

      expect(handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'child-task',
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('completed without branch metadata'),
          }),
        }),
      );
    });
  });

  describe('pre-start heartbeat', () => {
    it('fires onHeartbeat while awaiting a slow executor.start', async () => {
      vi.useFakeTimers();
      try {
        const heartbeats: string[] = [];
        const handle = { executionId: 'exec-slow', taskId: 'slow-start' };
        const slowExecutor = {
          type: 'worktree',
          start: vi.fn(async () => {
            await new Promise<void>((r) => { setTimeout(r, 65_000); });
            return handle;
          }),
          onOutput: () => () => {},
          onComplete: (_h: unknown, cb: (r: unknown) => void) => {
            cb({ requestId: 'r', actionId: 'slow-start', status: 'completed', outputs: { exitCode: 0 } });
            return () => {};
          },
          onHeartbeat: () => () => {},
        };
        const executor = new TaskRunner({
          orchestrator: { getTask: () => undefined, handleWorkerResponse: vi.fn() } as any,
          persistence: { updateTask: vi.fn() } as any,
          executorRegistry: {
            getDefault: () => slowExecutor,
            get: () => slowExecutor,
            getAll: () => [slowExecutor],
          } as any,
          cwd: '/tmp',
          callbacks: {
            onHeartbeat: (taskId: string) => { heartbeats.push(taskId); },
          },
        });
        const task = makeTask({ id: 'slow-start', status: 'running', config: { command: 'echo' } });
        const done = executor.executeTask(task);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(heartbeats.length).toBeGreaterThanOrEqual(1);
        expect(heartbeats.every((taskId) => taskId === 'slow-start')).toBe(true);
        await vi.advanceTimersByTimeAsync(35_000);
        await done;
        expect(heartbeats.length).toBeGreaterThanOrEqual(2);
        expect(heartbeats.every((taskId) => taskId === 'slow-start')).toBe(true);
        expect(slowExecutor.start).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('launch timeout repro', () => {
    it('reports launch-in-progress callbacks while executor.start is still pending', async () => {
      const launchStart = vi.fn();
      const launchFailed = vi.fn();
      const deferred = new Promise<never>(() => {});
      const hangingExecutor = {
        type: 'ssh',
        start: vi.fn(async () => await deferred),
        onOutput: vi.fn(),
        onComplete: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
      const runner = new TaskRunner({
        orchestrator: {
          getTask: () => undefined,
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: {
          updateTask: vi.fn(),
          updateAttempt: vi.fn(),
        } as any,
        executorRegistry: {
          getDefault: () => hangingExecutor,
          get: () => hangingExecutor,
          getAll: () => [hangingExecutor],
        } as any,
        cwd: '/tmp',
        callbacks: {
          onLaunchStart: launchStart,
          onLaunchFailed: launchFailed,
        },
      });

      const task = makeTask({
        id: 'launch-in-progress',
        status: 'running',
        config: { command: 'echo hello' },
        execution: { selectedAttemptId: 'launch-in-progress-a1' },
      });

      void runner.executeTask(task);
      await vi.waitFor(() => expect(hangingExecutor.start).toHaveBeenCalledTimes(1));

      expect(launchStart).toHaveBeenCalledWith('launch-in-progress', hangingExecutor);
      expect(launchFailed).not.toHaveBeenCalled();
    });

    it('fails a task when executor.start never resolves and keeps it in launching', async () => {
      vi.useFakeTimers();
      const previousTimeout = process.env.INVOKER_EXECUTOR_START_TIMEOUT_MS;
      process.env.INVOKER_EXECUTOR_START_TIMEOUT_MS = '100';
      try {
        const handleWorkerResponse = vi.fn();
        const onComplete = vi.fn();
        const onLaunchStart = vi.fn();
        const onLaunchFailed = vi.fn();
        const persistence = {
          updateTask: vi.fn(),
          updateAttempt: vi.fn(),
        };
        const task = makeTask({
          id: 'launch-hang',
          status: 'running',
          config: { command: 'echo never-launches' },
          execution: {
            generation: 5,
            phase: 'launching',
            startedAt: new Date('2026-04-16T05:25:16.531Z'),
            launchStartedAt: new Date('2026-04-16T05:25:16.531Z'),
            lastHeartbeatAt: new Date('2026-04-16T05:25:16.531Z'),
            selectedAttemptId: 'launch-hang-a1',
          },
        });
        const hangingExecutor = {
          type: 'worktree',
          start: vi.fn(async () => await new Promise<never>(() => {})),
          onOutput: vi.fn(),
          onComplete: vi.fn(),
          onHeartbeat: vi.fn(),
          kill: vi.fn(),
          destroyAll: vi.fn(),
        };
        const runner = new TaskRunner({
          orchestrator: {
            getTask: () => task,
            handleWorkerResponse,
          } as any,
          persistence: persistence as any,
          executorRegistry: {
            getDefault: () => hangingExecutor,
            get: () => hangingExecutor,
            getAll: () => [hangingExecutor],
          } as any,
          cwd: '/tmp',
          callbacks: { onComplete, onLaunchStart, onLaunchFailed },
        });

        const done = runner.executeTask(task);
        await vi.advanceTimersByTimeAsync(110);
        await done;

        expect(onComplete).toHaveBeenCalledWith(
          'launch-hang',
          expect.objectContaining({
            status: 'failed',
            outputs: expect.objectContaining({
              error: expect.stringContaining('Executor startup timed out after 100ms'),
            }),
          }),
        );
        expect(onLaunchStart).toHaveBeenCalledWith('launch-hang', hangingExecutor);
        expect(onLaunchFailed).toHaveBeenCalledWith(
          'launch-hang',
          expect.objectContaining({
            message: expect.stringContaining('Executor startup failed (worktree): Executor startup timed out after 100ms'),
          }),
          hangingExecutor,
        );
        expect(handleWorkerResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            actionId: 'launch-hang',
            status: 'failed',
            outputs: expect.objectContaining({
              error: expect.stringContaining('Executor startup timed out after 100ms'),
            }),
          }),
        );
        expect(persistence.updateTask).toHaveBeenCalledWith(
          'launch-hang',
          expect.objectContaining({
            execution: expect.objectContaining({
              phase: 'launching',
              launchCompletedAt: expect.any(Date),
            }),
          }),
        );
      } finally {
        if (previousTimeout === undefined) {
          delete process.env.INVOKER_EXECUTOR_START_TIMEOUT_MS;
        } else {
          process.env.INVOKER_EXECUTOR_START_TIMEOUT_MS = previousTimeout;
        }
        vi.useRealTimers();
      }
    });
  });

  describe('merge git operation timeout', () => {
    it('rejects instead of leaving merge consolidation pending when git never exits', async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'invoker-merge-git-timeout-'));
      const fakeBin = join(tmp, 'bin');
      mkdirSync(fakeBin);
      const fakeGit = join(fakeBin, 'git');
      writeFileSync(fakeGit, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
      chmodSync(fakeGit, 0o755);

      const previousPath = process.env.PATH;
      const previousTimeout = process.env.INVOKER_GIT_NETWORK_TIMEOUT_MS;
      process.env.PATH = `${fakeBin}:${previousPath ?? ''}`;
      process.env.INVOKER_GIT_NETWORK_TIMEOUT_MS = '50';

      try {
        const runner = new TaskRunner({
          orchestrator: {
            getTask: vi.fn(),
            getAllTasks: vi.fn(() => []),
            handleWorkerResponse: vi.fn(),
          } as any,
          persistence: {} as any,
          executorRegistry: {
            getDefault: vi.fn(),
            get: vi.fn(),
            getAll: vi.fn(() => []),
          } as any,
          cwd: tmp,
        });

        const startedAt = Date.now();
        await expect(runner.execGitIn(['fetch', 'origin', '+refs/heads/main:refs/heads/main'], tmp))
          .rejects.toThrow(/exceeded git operation timeout \(50ms\)/);
        expect(Date.now() - startedAt).toBeLessThan(2_000);
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        if (previousTimeout === undefined) {
          delete process.env.INVOKER_GIT_NETWORK_TIMEOUT_MS;
        } else {
          process.env.INVOKER_GIT_NETWORK_TIMEOUT_MS = previousTimeout;
        }
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('baseBranch in WorkRequest', () => {
    it('translates workflow intermediateRepoUrl into executor branchRepoUrl', async () => {
      let capturedRequest: any;
      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-branch-repo', taskId: 'task-branch-repo' };
        },
        onOutput: () => () => {},
        onComplete: (_handle: any, cb: any) => {
          cb({ requestId: 'r', actionId: 'task-branch-repo', status: 'completed', outputs: { exitCode: 0 } });
          return () => {};
        },
        onHeartbeat: () => () => {},
      };
      const registry = {
        getDefault: () => capturingExecutor,
        get: () => capturingExecutor,
        getAll: () => [capturingExecutor],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 0, intermediateRepoUrl: '  git@example.com:owner/branches.git  ' }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'task-branch-repo',
        status: 'running',
        config: { command: 'echo hi', workflowId: 'wf-branch-repo' },
      });
      await executor.executeTask(task);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.branchRepoUrl).toBe('git@example.com:owner/branches.git');
      expect(capturedRequest.inputs.intermediateRepoUrl).toBeUndefined();
    });

    it('encodes workflow generation, task generation, and attemptId in request lifecycleTag', async () => {
      let capturedRequest: any;
      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-salt-1', taskId: 'task-salt-1' };
        },
        onOutput: () => () => {},
        onComplete: (_handle: any, cb: any) => {
          cb({ requestId: 'r', actionId: 'task-salt-1', status: 'completed', outputs: { exitCode: 0 } });
          return () => {};
        },
        onHeartbeat: () => () => {},
      };
      const registry = {
        getDefault: () => capturingExecutor,
        get: () => capturingExecutor,
        getAll: () => [capturingExecutor],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 3 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'task-salt-1',
        status: 'running',
        config: { command: 'echo hi', workflowId: 'wf-1' },
        execution: { generation: 5, selectedAttemptId: 'attempt-abc' },
      });
      await executor.executeTask(task);

      expect(capturedRequest).toBeDefined();
      // Lifecycle tag embeds wfGen=3, taskGen=5, attemptShort sanitized from
      // 'attempt-abc' (truncated to 12 chars, lowercased, kept dash chars).
      expect(capturedRequest.inputs.lifecycleTag).toBe('g3.t5.aattempt-abc');
    });

    it('still includes attemptId in lifecycleTag when both generations are zero', async () => {
      let capturedRequest: any;
      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-salt-2', taskId: 'task-salt-2' };
        },
        onOutput: () => () => {},
        onComplete: (_handle: any, cb: any) => {
          cb({ requestId: 'r', actionId: 'task-salt-2', status: 'completed', outputs: { exitCode: 0 } });
          return () => {};
        },
        onHeartbeat: () => () => {},
      };
      const registry = {
        getDefault: () => capturingExecutor,
        get: () => capturingExecutor,
        getAll: () => [capturingExecutor],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'task-salt-2',
        status: 'running',
        config: { command: 'echo hi', workflowId: 'wf-1' },
        execution: { generation: 0, selectedAttemptId: 'attempt-xyz' },
      });
      await executor.executeTask(task);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.lifecycleTag).toBe('g0.t0.aattempt-xyz');
    });

    it('includes workflow baseBranch in request inputs', async () => {
      let capturedRequest: any;
      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-1', taskId: 'task-bb' };
        },
        onOutput: () => () => {},
        onComplete: (_handle: any, cb: any) => { cb({ requestId: 'r', actionId: 'task-bb', status: 'completed', outputs: { exitCode: 0 } }); return () => {}; },
        onHeartbeat: () => () => {},
      };
      const registry = {
        getDefault: () => capturingExecutor,
        get: () => capturingExecutor,
        getAll: () => [capturingExecutor],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ baseBranch: 'main', generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'task-bb',
        status: 'running',
        config: { command: 'echo hi', workflowId: 'wf-1' },
      });
      await executor.executeTask(task);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.baseBranch).toBe('main');
    });

    it('uses defaultBranch when workflow has no baseBranch', async () => {
      let capturedRequest: any;
      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-1', taskId: 'task-bb2' };
        },
        onOutput: () => () => {},
        onComplete: (_handle: any, cb: any) => { cb({ requestId: 'r', actionId: 'task-bb2', status: 'completed', outputs: { exitCode: 0 } }); return () => {}; },
        onHeartbeat: () => () => {},
      };
      const registry = {
        getDefault: () => capturingExecutor,
        get: () => capturingExecutor,
        getAll: () => [capturingExecutor],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
        defaultBranch: 'develop',
      });

      const task = makeTask({
        id: 'task-bb2',
        status: 'running',
        config: { command: 'echo hi', workflowId: 'wf-1' },
      });
      await executor.executeTask(task);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.baseBranch).toBe('develop');
    });

    it('omits baseBranch when neither workflow nor defaultBranch is set', async () => {
      let capturedRequest: any;
      const capturingExecutor = {
        type: 'worktree',
        start: async (req: any) => {
          capturedRequest = req;
          return { executionId: 'exec-1', taskId: 'task-bb3' };
        },
        onOutput: () => () => {},
        onComplete: (_handle: any, cb: any) => { cb({ requestId: 'r', actionId: 'task-bb3', status: 'completed', outputs: { exitCode: 0 } }); return () => {}; },
        onHeartbeat: () => () => {},
      };
      const registry = {
        getDefault: () => capturingExecutor,
        get: () => capturingExecutor,
        getAll: () => [capturingExecutor],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
      });

      const task = makeTask({
        id: 'task-bb3',
        status: 'running',
        config: { command: 'echo hi', workflowId: 'wf-1' },
      });
      await executor.executeTask(task);

      expect(capturedRequest).toBeDefined();
      expect(capturedRequest.inputs.baseBranch).toBeUndefined();
    });
  });

  describe('detectDefaultBranch', () => {
    it('returns branch from git symbolic-ref when available', async () => {
      const executor = createExecutorWithTasks(new Map());

      const origExecGitReadonly = (executor as any).execGitReadonly.bind(executor);
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args.includes('symbolic-ref')) {
          return 'refs/remotes/origin/master';
        }
        return origExecGitReadonly(args);
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args.includes('symbolic-ref')) {
          return 'refs/remotes/origin/master';
        }
        return origExecGitReadonly(args);
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const branch = await executor.detectDefaultBranch();
      expect(branch).toBe('master');
    });

    it('falls back to main when symbolic-ref fails but main exists', async () => {
      const executor = createExecutorWithTasks(new Map());

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('not set');
        }
        if (args.includes('rev-parse') && args.includes('main')) {
          return 'abc123';
        }
        throw new Error('unexpected');
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('not set');
        }
        if (args.includes('rev-parse') && args.includes('main')) {
          return 'abc123';
        }
        throw new Error('unexpected');
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const branch = await executor.detectDefaultBranch();
      expect(branch).toBe('main');
    });

    it('falls back to master when both symbolic-ref and main fail', async () => {
      const executor = createExecutorWithTasks(new Map());

      (executor as any).execGitReadonly = async () => {
        throw new Error('not found');
      };
      (executor as any).execGitIn = async (_args: string[], _dir: string) => {
        throw new Error('not found');
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const branch = await executor.detectDefaultBranch();
      expect(branch).toBe('master');
    });
  });

  describe('execGitReadonly error format', () => {
    it('includes stdout in error message when present', async () => {
      const spawn = await import('child_process').then(m => m.spawn);
      vi.mock('child_process', async (importOriginal) => {
        const orig = await importOriginal<typeof import('child_process')>();
        return { ...orig };
      });

      const executor = createExecutorWithTasks(new Map());

      const fakeChild = new EventEmitter() as any;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      fakeChild.stdout = stdoutEmitter;
      fakeChild.stderr = stderrEmitter;

      const origExecGitReadonly = (executor as any).execGitReadonly.bind(executor);
      (executor as any).execGitReadonly = (args: string[]) => {
        return new Promise((_resolve, reject) => {
          if (args[0] === 'merge') {
            reject(new Error(
              `git ${args.join(' ')} failed (code 1): Auto-merging file.txt\nCONFLICT (content): Merge conflict in file.txt`
            ));
          } else {
            _resolve('ok');
          }
        });
      };
      (executor as any).execGitIn = (args: string[], _dir: string) => {
        return new Promise((_resolve, reject) => {
          if (args[0] === 'merge') {
            reject(new Error(
              `git ${args.join(' ')} failed (code 1): Auto-merging file.txt\nCONFLICT (content): Merge conflict in file.txt`
            ));
          } else {
            _resolve('ok');
          }
        });
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      try {
        await (executor as any).execGitReadonly(['merge', '--no-ff', 'some-branch']);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).toContain('CONFLICT');
        expect(err.message).toContain('file.txt');
      }
    });
  });

  describe('consolidateAndMerge cleanup', () => {
    it('aborts merge and restores branch on failure', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout' && args[1] === '-b') return '';
        if (args[0] === 'merge' && args.includes('--no-ff')) {
          throw new Error('git merge --no-ff failed (code 1): CONFLICT (content): file.txt');
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout' && args[1] === '-b') return '';
        if (args[0] === 'merge' && args.includes('--no-ff')) {
          throw new Error('git merge --no-ff failed (code 1): CONFLICT (content): file.txt');
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      const mergeAbortCall = gitCalls.find(c => c[0] === 'merge' && c[1] === '--abort');
      expect(mergeAbortCall).toBeDefined();

      expect(onComplete).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('CONFLICT'),
          }),
        }),
      );
    });

    it('recreates feature branch on retry after previous failed attempt', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete: vi.fn() },
      });

      const gitCalls: string[][] = [];
      let checkoutNewBranchAttempt = 0;
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout' && args[1] === '-b') {
          checkoutNewBranchAttempt++;
          if (checkoutNewBranchAttempt === 1) {
            throw new Error('branch already exists');
          }
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args.includes('--no-ff') && args.includes('experiment/t1')) return '';
        if (args[0] === 'merge' && args.includes('--no-ff') && args.includes('plan/feature')) return '';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout' && args[1] === '-b') {
          checkoutNewBranchAttempt++;
          if (checkoutNewBranchAttempt === 1) {
            throw new Error('branch already exists');
          }
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args.includes('--no-ff') && args.includes('experiment/t1')) return '';
        if (args[0] === 'merge' && args.includes('--no-ff') && args.includes('plan/feature')) return '';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      const deleteCall = gitCalls.find(c => c[0] === 'branch' && c[1] === '-D' && c[2] === 'plan/feature');
      expect(deleteCall).toBeDefined();

      // Default mergeMode is 'manual', so setTaskReviewReady is called with metadata
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ branch: 'plan/feature', workspacePath: '/tmp/mock-wt' }),
      }), expect.objectContaining({ generation: 0 }));
    });
  });

  describe('rebaseTaskBranches', () => {
    it('rebases all managed workflow task and attempt branches onto baseBranch', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
        makeTask({ id: 't2', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t2-current' } }),
        makeTask({ id: 't3', config: { workflowId: 'wf-1' }, status: 'pending', execution: { branch: 'experiment/t3' } }),
        makeTask({ id: 't4', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'feature/user-branch' } }),
        makeTask({ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true }, status: 'failed' }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
      };
      const loadAttempts = vi.fn((taskId: string) => {
        if (taskId === 't1') {
          return [
            { id: 't1-a1', nodeId: 't1', branch: 'experiment/t1-old' },
            { id: 't1-a2', nodeId: 't1', branch: 'feature/not-managed' },
          ];
        }
        if (taskId === 't2') {
          return [
            { id: 't2-a1', nodeId: 't2', branch: 'experiment/t2-old' },
            { id: 't2-a2', nodeId: 't2', branch: 'experiment/t2-current' },
          ];
        }
        if (taskId === 't3') return [{ id: 't3-a1', nodeId: 't3', branch: 'invoker/t3-old' }];
        if (taskId === 't4') return [{ id: 't4-a1', nodeId: 't4', branch: 'invoker/t4-old' }];
        return [];
      });
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadAttempts } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const result = await executor.rebaseTaskBranches('wf-1', 'master');

      expect(result.success).toBe(true);
      expect(result.rebasedBranches).toEqual([
        'experiment/t1',
        'experiment/t1-old',
        'experiment/t2-current',
        'experiment/t2-old',
        'experiment/t3',
        'invoker/t3-old',
        'invoker/t4-old',
      ]);
      expect(result.errors).toEqual([]);
      expect(loadAttempts).toHaveBeenCalledTimes(4);
      expect(loadAttempts).toHaveBeenNthCalledWith(1, 't1');
      expect(loadAttempts).toHaveBeenNthCalledWith(2, 't2');
      expect(loadAttempts).toHaveBeenNthCalledWith(3, 't3');
      expect(loadAttempts).toHaveBeenNthCalledWith(4, 't4');

      const rebaseCalls = gitCalls.filter(c => c[0] === 'rebase');
      expect(rebaseCalls).toHaveLength(7);
      expect(rebaseCalls.every(c => c[1] === 'master')).toBe(true);
    });

    it('reports errors for branches that fail to rebase', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
        makeTask({ id: 't2', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t2' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rebase' && gitCalls.filter(c => c[0] === 'checkout' && c[1] === 'experiment/t2').length > 0) {
          throw new Error('CONFLICT in file.txt');
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rebase' && gitCalls.filter(c => c[0] === 'checkout' && c[1] === 'experiment/t2').length > 0) {
          throw new Error('CONFLICT in file.txt');
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const result = await executor.rebaseTaskBranches('wf-1', 'master');

      expect(result.success).toBe(false);
      expect(result.rebasedBranches).toEqual(['experiment/t1']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('experiment/t2');
      expect(result.errors[0]).toContain('CONFLICT');

      const abortCalls = gitCalls.filter(c => c[0] === 'rebase' && c[1] === '--abort');
      expect(abortCalls).toHaveLength(1);
    });

    it('rebases task branches in worktree', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'my-feature';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'my-feature';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.rebaseTaskBranches('wf-1', 'master');

      const rebaseCalls = gitCalls.filter(c => c[0] === 'rebase');
      expect(rebaseCalls.length).toBeGreaterThan(0);
    });

    it('skips merge nodes and unmanaged duplicate branches', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
        makeTask({ id: 't2', config: { workflowId: 'wf-1' }, status: 'failed', execution: { branch: 'feature/t2' } }),
        makeTask({ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true }, status: 'failed', execution: { branch: 'plan/feature' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadAttempts: () => [{ id: 'attempt-1', nodeId: 't1', branch: 'experiment/t1' }] } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const result = await executor.rebaseTaskBranches('wf-1', 'master');

      expect(result.rebasedBranches).toEqual(['experiment/t1']);
      const checkoutCalls = gitCalls.filter(c => c[0] === 'checkout' && c[1] !== 'master');
      expect(checkoutCalls).toHaveLength(1);
      expect(checkoutCalls[0][1]).toBe('experiment/t1');
    });

    it('uses persisted attempt branches with current completed task branches in the repro order', async () => {
      const allTasks = [
        makeTask({
          id: 'wf-1/t1',
          config: { workflowId: 'wf-1' },
          status: 'completed',
          execution: { branch: 'experiment/wf-1-t1/g23.t28.a-current-cccccccc' },
        }),
        makeTask({
          id: 'wf-1/t2',
          config: { workflowId: 'wf-1' },
          status: 'pending',
        }),
      ];
      const loadAttempts = vi.fn((taskId: string) => taskId === 'wf-1/t1'
        ? [
          { id: 'old', nodeId: taskId, branch: 'experiment/wf-1-t1/g0.t1.a-old-aaaaaaaa' },
          { id: 'current', nodeId: taskId, branch: 'experiment/wf-1-t1/g23.t28.a-current-cccccccc' },
        ]
        : []);
      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
        } as any,
        persistence: { loadAttempts } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitIn = async (args: string[]) => {
        gitCalls.push(args);
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const result = await executor.rebaseTaskBranches('wf-1', 'origin/master');

      expect(result.rebasedBranches).toEqual([
        'experiment/wf-1-t1/g23.t28.a-current-cccccccc',
        'experiment/wf-1-t1/g0.t1.a-old-aaaaaaaa',
      ]);
      expect(loadAttempts).toHaveBeenCalledWith('wf-1/t1');
      expect(loadAttempts).toHaveBeenCalledWith('wf-1/t2');
      expect(gitCalls.filter(c => c[0] === 'checkout').map(c => c[1])).toEqual(result.rebasedBranches);
    });
  });

  describe('preparePoolForRebaseRetry', () => {
    it('removes historical managed attempt branches from the pool mirror', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1-current' } }),
        makeTask({ id: 't2', config: { workflowId: 'wf-1' }, status: 'failed', execution: { branch: 'feature/t2' } }),
        makeTask({ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true }, status: 'completed', execution: { branch: 'experiment/merge' } }),
      ];
      const pool = {
        refreshMirrorForRebase: vi.fn().mockResolvedValue(undefined),
        resolveBaseCommit: vi.fn().mockResolvedValue('abc123'),
        removeManagedBranchesInMirror: vi.fn().mockResolvedValue(undefined),
      };
      const worktreeExecutor = new WorktreeExecutor({
        cacheDir: mkdtempSync(join(tmpdir(), 'invoker-task-runner-cache-')),
      });
      vi.spyOn(worktreeExecutor, 'getRepoPool').mockReturnValue(pool as any);
      const loadAttempts = vi.fn((taskId: string) => {
        if (taskId === 't1') {
          return [
            { id: 't1-old', nodeId: 't1', branch: 'experiment/t1-old' },
            { id: 't1-dup', nodeId: 't1', branch: 'experiment/t1-current' },
          ];
        }
        if (taskId === 't2') {
          return [
            { id: 't2-old', nodeId: 't2', branch: 'invoker/t2-old' },
            { id: 't2-feature', nodeId: 't2', branch: 'feature/t2-old' },
          ];
        }
        return [{ id: 'merge-old', nodeId: taskId, branch: 'experiment/merge-old' }];
      });
      const executor = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
        } as any,
        persistence: { loadAttempts } as any,
        executorRegistry: { get: (kind: string) => kind === 'worktree' ? worktreeExecutor : null } as any,
        cwd: '/tmp',
      });

      const result = await executor.preparePoolForRebaseRetry('wf-1', 'git@example.com/repo.git', 'master');

      expect(result).toEqual({ branch: 'master', commit: 'abc123' });
      expect(pool.removeManagedBranchesInMirror).toHaveBeenCalledWith(
        'git@example.com/repo.git',
        ['experiment/t1-current', 'experiment/t1-old', 'invoker/t2-old'],
        undefined,
      );
      expect(loadAttempts).toHaveBeenCalledTimes(2);
      expect(loadAttempts).toHaveBeenCalledWith('t1');
      expect(loadAttempts).toHaveBeenCalledWith('t2');
    });
  });

  describe('manual merge mode', () => {
    it('executeMergeNode skips final merge when mergeMode=manual', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'manual',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should consolidate task branches into featureBranch
      const consolidateMerge = gitCalls.find(c => c[0] === 'merge' && c.includes('experiment/t1'));
      expect(consolidateMerge).toBeDefined();

      // Should NOT rebase or squash-merge featureBranch into baseBranch (manual only consolidates)
      const rebaseCall = gitCalls.find(c => c[0] === 'rebase');
      expect(rebaseCall).toBeUndefined();
      const squashCall = gitCalls.find(c => c[0] === 'merge' && c.includes('--squash'));
      expect(squashCall).toBeUndefined();

      // Should call setTaskReviewReady with metadata instead of handleWorkerResponse
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ branch: 'plan/feature', workspacePath: '/tmp/mock-wt' }),
      }), expect.objectContaining({ generation: 0 }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({ status: 'review_ready' }),
      );
    });

    it('executeMergeNode performs full merge when mergeMode=automatic', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'automatic',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete: vi.fn() },
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        // diff --cached --quiet exits non-zero when there are staged changes
        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
          throw new Error('exit code 1');
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        // diff --cached --quiet exits non-zero when there are staged changes
        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
          throw new Error('exit code 1');
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should squash merge featureBranch into baseBranch using detached HEAD pattern (no rebase)
      const rebaseCall = gitCalls.find(c => c[0] === 'rebase');
      expect(rebaseCall).toBeUndefined();
      const detachCall = gitCalls.find(c => c[0] === 'checkout' && c[1] === '--detach' && c[2] === 'master');
      expect(detachCall).toBeDefined();
      const squashCall = gitCalls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/feature'));
      expect(squashCall).toBeDefined();
      const commitCall = gitCalls.find(c => c[0] === 'commit' && c.includes('-m'));
      expect(commitCall).toBeDefined();
      // Squash commit pushed directly to origin from the clone
      const pushCall = gitCalls.find(c => c[0] === 'push' && c.includes('--force') && c.includes('origin') && c.some(a => a.startsWith('HEAD:refs/heads/')));
      expect(pushCall).toBeDefined();

      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('executeMergeNode skips squash-merge and creates PR when mergeMode=external_review', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/42',
          identifier: 'owner/repo#42',
        }),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
        mergeGateProvider: mergeGateProvider as any,
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should consolidate task branches into featureBranch
      const consolidateMerge = gitCalls.find(c => c[0] === 'merge' && c.includes('experiment/t1'));
      expect(consolidateMerge).toBeDefined();

      // Should NOT squash-merge featureBranch into baseBranch
      const squashCall = gitCalls.find(c => c[0] === 'merge' && c.includes('--squash'));
      expect(squashCall).toBeUndefined();
      const commitCall = gitCalls.find(c => c[0] === 'commit');
      expect(commitCall).toBeUndefined();

      // Should route through shared PR-authoring helper
      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        cwd: '/tmp/mock-wt',
      }));

      // Should create a PR via mergeGateProvider with authored body
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          title: 'Test Workflow',
          cwd: '/tmp/mock-wt',
          body: '## Summary\n\nAuthored body',
        }),
      );

      // Should set task review-ready with PR metadata (not handleWorkerResponse)
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/42',
          reviewId: 'owner/repo#42',
          reviewStatus: 'Awaiting review',
          reviewGate: expect.objectContaining({
            activeGeneration: 0,
            completion: { required: 'all', status: 'approved' },
            artifacts: [expect.objectContaining({
              id: 'owner/repo#42',
              title: 'Test Workflow',
              url: 'https://github.com/owner/repo/pull/42',
              providerId: 'owner/repo#42',
              branch: 'plan/feature',
              baseBranch: 'master',
              required: true,
              status: 'open',
              generation: 0,
            })],
          }),
        }),
      }), expect.objectContaining({ generation: 0 }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({ status: 'review_ready' }),
      );
    });

    it('external_review checks out the fetched feature branch in the gate workspace', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/example',
          name: 'Review Gate Checkout',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/42',
          identifier: 'owner/repo#42',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp/host',
        callbacks: { onComplete: vi.fn() },
        mergeGateProvider: mergeGateProvider as any,
      });

      const gateWorkspace = '/tmp/gate-wt';
      const consolidateWorkspace = '/tmp/consolidate-wt';
      const currentBranchByDir = new Map<string, string | undefined>([
        [gateWorkspace, undefined],
        [consolidateWorkspace, 'plan/example'],
      ]);
      const gitCalls: Array<{ args: string[]; dir: string }> = [];
      (executor as any).execGitReadonly = async () => '';
      (executor as any).execGitIn = async (args: string[], dir: string) => {
        gitCalls.push({ args: [...args], dir });
        if (args[0] === 'checkout' && args[1] === 'plan/example') {
          currentBranchByDir.set(dir, 'plan/example');
        }
        if (args[0] === 'checkout' && args[1] === '--detach') {
          currentBranchByDir.set(dir, undefined);
        }
        if (args[0] === 'checkout' && args[1] === '-b' && args[2]) {
          currentBranchByDir.set(dir, args[2]);
        }
        if (args[0] === 'branch' && args[1] === '--show-current') {
          return currentBranchByDir.get(dir) ?? '';
        }
        return '';
      };
      (executor as any).createMergeWorktree = vi.fn()
        .mockResolvedValueOnce(gateWorkspace)
        .mockResolvedValueOnce(consolidateWorkspace);
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      const gateGitCalls = gitCalls.filter(c => c.dir === gateWorkspace).map(c => c.args);
      const fetchIndex = gateGitCalls.findIndex(args =>
        args[0] === 'fetch' &&
        args[1] === 'origin' &&
        args[2] === '+refs/heads/plan/example:refs/heads/plan/example',
      );
      const checkoutIndex = gateGitCalls.findIndex(args =>
        args[0] === 'checkout' &&
        args[1] === 'plan/example',
      );
      expect(fetchIndex).toBeGreaterThanOrEqual(0);
      expect(checkoutIndex).toBeGreaterThan(fetchIndex);
      expect(currentBranchByDir.get(gateWorkspace)).toBe('plan/example');
      expect(persistence.updateTask).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        execution: expect.objectContaining({
          workspacePath: gateWorkspace,
          branch: 'plan/example',
        }),
      }));
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        execution: expect.objectContaining({
          workspacePath: gateWorkspace,
          branch: 'plan/example',
        }),
      }), expect.objectContaining({ generation: 0 }));
    });

    it('reproduces wf-1778431030512-12 visual-proof markdown in the merge-gate PR body', async () => {
      const cwd = createTempWorkspace();
      mkdirSync(join(cwd, 'scripts'), { recursive: true });
      mkdirSync(join(cwd, 'mock-wt'), { recursive: true });
      writeFileSync(join(cwd, 'scripts', 'ui-visual-proof.sh'), `#!/usr/bin/env bash
set -euo pipefail
label=""
output_dir=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --label) label="$2"; shift 2 ;;
    --output-dir) output_dir="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 64 ;;
  esac
done
if [[ -z "$label" || -z "$output_dir" ]]; then
  echo "missing visual proof args" >&2
  exit 64
fi
mkdir -p "$output_dir/$label"
printf 'png' > "$output_dir/$label/merge-gate-no-inline-approve.png"
printf 'png' > "$output_dir/$label/task-panel.png"
printf 'video' > "$output_dir/$label/walkthrough.webm"
echo "$output_dir/$label"
`);
      writeFileSync(join(cwd, 'scripts', 'upload-pr-images.mjs'), `const out = {};
for (const file of process.argv.slice(2)) {
  const name = file.split('/').pop();
  out[name] = 'https://img.example.test/' + name;
}
console.log(JSON.stringify(out));
`);

      const workflowId = 'wf-1778431030512-12';
      const taskId = 'fix-visual-proof-pr-summary-repro';
      const mergeTaskId = `__merge__${workflowId}`;
      const allTasks = [
        makeTask({
          id: taskId,
          description: 'Add regression repro for failed visual-proof PR summary path',
          status: 'completed',
          config: { workflowId },
          execution: { branch: 'experiment-wf-1778431030512-12-fix-visual-proof-pr-summary-repro' },
        }),
      ];
      const mergeTask = makeTask({
        id: mergeTaskId,
        status: 'running',
        dependencies: [taskId],
        config: { isMergeNode: true, workflowId },
      });
      const orchestrator = {
        getTask: (id: string) => id === mergeTaskId ? mergeTask : allTasks.find(t => t.id === id),
        getAllTasks: () => [...allTasks, mergeTask],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: workflowId,
          name: 'Fix visual-proof PR summary repro',
          description: 'Regression workflow for PR #276 missing visual-proof markdown',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'experiment/wf-1778431030512-12-visual-proof-pr-summary',
          visualProof: true,
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/invoker/invoker/pull/276',
          identifier: 'invoker/invoker#276',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd,
        callbacks: { onComplete: vi.fn() },
        mergeGateProvider: mergeGateProvider as any,
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123';
        if (args[0] === 'rev-parse') return 'feature-sha';
        // A successful push means the branch is retrievable on origin at the
        // pushed tip. Model that so the post-push retrievability check passes.
        if (args[0] === 'ls-remote') return `feature-sha\trefs/heads/${args[args.length - 1]}`;
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') throw new Error('not ancestor');
        return '';
      };
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = vi.fn().mockResolvedValue(join(cwd, 'mock-wt'));
      (executor as any).removeMergeWorktree = vi.fn();
      (executor as any).gitDiffStat = vi.fn().mockResolvedValue(' packages/execution-engine/src/task-runner.ts | 20 +++++');
      (executor as any).authorPrBodyWithSkill = vi.fn().mockImplementation(async (args: any) => ({
        body: `## Summary\n\n${args.workflowSummary}\n\n${args.structuredContext?.visualProofMarkdown ?? ''}`,
        sessionId: 'sess-wf-1778431030512-12',
        agentName: 'codex',
      }));

      await (executor as any).executeMergeNode(mergeTask);

      expect(gitCalls.some(c => c[0] === 'push')).toBe(true);
      expect(mergeGateProvider.createReview).toHaveBeenCalledTimes(1);
      const providerBody = mergeGateProvider.createReview.mock.calls[0][0].body;
      expect(providerBody).toContain('## Visual Proof');
      expect(providerBody).toContain('merge-gate-no-inline-approve.png');
      expect(providerBody).toContain('![before](https://img.example.test/before--merge-gate-no-inline-approve.png)');
      expect(providerBody).toContain('![after](https://img.example.test/after--merge-gate-no-inline-approve.png)');
    });

    it('executeMergeNode goes to review_ready when mergeMode=manual and onFinish=none', async () => {
      const orchestrator = {
        getTask: () => null,
        getAllTasks: () => [],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'none',
          mergeMode: 'manual',
          baseBranch: 'master',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: [],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // No featureBranch set → gateWorkspacePath is undefined
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ workspacePath: undefined }),
      }), expect.objectContaining({ generation: 0 }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('executeMergeNode auto-completes when mergeMode=automatic and onFinish=none', async () => {
      const orchestrator = {
        getTask: () => null,
        getAllTasks: () => [],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'none',
          mergeMode: 'automatic',
          baseBranch: 'master',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: [],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
      expect(orchestrator.setTaskAwaitingApproval).not.toHaveBeenCalled();
    });

    it('executeMergeNode creates PR when mergeMode=external_review and onFinish=none', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'none',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/55',
          identifier: 'owner/repo#55',
        }),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext2',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should route through shared PR-authoring helper
      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalled();

      // Should create a PR via mergeGateProvider
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          title: 'Test Workflow',
        }),
      );

      // Should pass PR metadata through setTaskReviewReady
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/55',
          reviewId: 'owner/repo#55',
          reviewStatus: 'Awaiting review',
          reviewGate: expect.objectContaining({
            activeGeneration: 0,
            completion: { required: 'all', status: 'approved' },
            artifacts: [expect.objectContaining({
              id: 'owner/repo#55',
              title: 'Test Workflow',
              url: 'https://github.com/owner/repo/pull/55',
              providerId: 'owner/repo#55',
              branch: 'plan/feature',
              baseBranch: 'master',
              required: true,
              status: 'open',
              generation: 0,
            })],
          }),
        }),
      }), expect.objectContaining({ generation: 0 }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('executeMergeNode anchors external_review gate worktrees on the origin-backed base branch', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'none',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/55',
          identifier: 'owner/repo#55',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async () => '';
      const createMergeWorktreeSpy = vi.fn().mockResolvedValue('/tmp/mock-wt');
      (executor as any).createMergeWorktree = createMergeWorktreeSpy;
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext3',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(createMergeWorktreeSpy).toHaveBeenCalledWith(
        'master',
        expect.stringContaining('gate-__merge__wf-1'),
        undefined,
      );
    });

    it('executeMergeNode handles persisted mergeMode=external_review', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'none',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/55',
          identifier: 'owner/repo#55',
        }),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext4',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(mergeGateProvider.createReview).toHaveBeenCalled();
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalled();
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('executeMergeNode goes to review_ready when mergeMode=manual and no featureBranch', async () => {
      const orchestrator = {
        getTask: () => null,
        getAllTasks: () => [],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'manual',
          baseBranch: 'master',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: [],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // No featureBranch set → gateWorkspacePath is undefined
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ workspacePath: undefined }),
      }), expect.objectContaining({ generation: 0 }));
    });

    it('approveMerge performs the final merge step', async () => {
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
        getWorkspacePath: () => null,
      };
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.approveMerge('wf-1');

      // Should squash merge in worktree (no rebase, no checkout since worktree is created at baseBranch)
      const rebaseCall = gitCalls.find(c => c[0] === 'rebase');
      expect(rebaseCall).toBeUndefined();
      const squashCall = gitCalls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/feature'));
      expect(squashCall).toBeDefined();
      const commitCall = gitCalls.find(c => c[0] === 'commit' && c.includes('-m'));
      expect(commitCall).toBeDefined();
      // Squash commit pushed directly to origin from the clone
      const pushCall = gitCalls.find(c => c[0] === 'push' && c.includes('--force') && c.includes('origin') && c.some(a => a.startsWith('HEAD:refs/heads/')));
      expect(pushCall).toBeDefined();
    });

    it('approveMerge throws when workflow has no merge configured', async () => {
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'none',
          baseBranch: 'master',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.approveMerge('wf-1')).rejects.toThrow('no merge configured');
    });

    it('external_review merge path logs PR URL to console', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/99',
          identifier: '99',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext5',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      const logSpy = vi.spyOn(console, 'log');

      await (executor as any).executeMergeNode(mergeTask);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/owner/repo/pull/99'),
      );

      logSpy.mockRestore();
    });

    it('external_review merge path calls consolidateAndMerge exactly once', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/42',
          identifier: '42',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-ext6',
        agentName: 'codex',
      });

      const consolidateSpy = vi.spyOn(executor as any, 'consolidateAndMerge');

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(consolidateSpy).toHaveBeenCalledTimes(1);
      expect(consolidateSpy).toHaveBeenCalledWith(
        'none',
        'master',
        'plan/feature',
        'wf-1',
        'Test Workflow',
        undefined,
        expect.any(String),
        false,
        expect.any(String),
        '__merge__wf-1',
      );

      consolidateSpy.mockRestore();
    });

    it('executeMergeNode with onFinish=pull_request parks in review_ready with a typed review gate', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'pull_request',
          mergeMode: 'manual',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        name: 'github',
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/55',
          identifier: 'owner/repo#55',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
        callbacks: { onComplete: vi.fn() },
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored body',
        sessionId: 'sess-pr-1',
        agentName: 'codex',
      });
      (executor as any).execPr = vi.fn();

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        cwd: '/tmp/mock-wt',
      }));
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(expect.objectContaining({
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        title: 'Test Workflow',
        cwd: '/tmp/mock-wt',
        body: '## Summary\n\nAuthored body',
      }));
      expect((executor as any).execPr).not.toHaveBeenCalled();
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          execution: expect.objectContaining({
            reviewUrl: 'https://github.com/owner/repo/pull/55',
            reviewId: 'owner/repo#55',
            reviewStatus: 'Awaiting review',
            reviewGate: expect.objectContaining({
              activeGeneration: 0,
              artifacts: [expect.objectContaining({
                providerId: 'owner/repo#55',
                status: 'open',
                generation: 0,
              })],
            }),
          }),
        }),
        expect.objectContaining({ generation: 0 }),
      );
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });


    it('automatic merge with onFinish=pull_request reuses typed review publication instead of execPr', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'pull_request',
          mergeMode: 'automatic',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        name: 'github',
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/77',
          identifier: 'owner/repo#77',
        }),
      };
      const onComplete = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
        callbacks: { onComplete },
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuto authored body',
        sessionId: 'sess-pr-2',
        agentName: 'codex',
      });
      (executor as any).execPr = vi.fn();

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ body: '## Summary\n\nAuto authored body' }),
      );
      expect((executor as any).execPr).not.toHaveBeenCalled();
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          execution: expect.objectContaining({
            reviewUrl: 'https://github.com/owner/repo/pull/77',
            reviewGate: expect.objectContaining({
              artifacts: [expect.objectContaining({ providerId: 'owner/repo#77' })],
            }),
          }),
        }),
        expect.objectContaining({ generation: 0 }),
      );

      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });


    it('executeMergeNode passes authored body to createReview in external_review mode', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/42',
          identifier: '42',
        }),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('## Summary\nTest summary');
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored PR body from summary',
        sessionId: 'sess-pr-ext7',
        agentName: 'codex',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should route through shared PR-authoring helper with the summary as input
      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowSummary: '## Summary\nTest summary',
          cwd: '/tmp/mock-wt',
        }),
      );

      // createReview receives the authored body, not the raw summary
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ body: '## Summary\n\nAuthored PR body from summary' }),
      );
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: expect.objectContaining({ summary: '## Summary\nTest summary' }),
        }),
        expect.objectContaining({ generation: 0 }),
      );
    });

    it('executeMergeNode persists summary on merge task in manual mode', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'manual',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete: vi.fn() },
      });

      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('## Summary\nManual summary');

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: expect.objectContaining({ summary: '## Summary\nManual summary' }),
        }),
        expect.objectContaining({ generation: 0 }),
      );
    });

    it('approveMerge with onFinish=pull_request does not publish a second review', async () => {
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'pull_request',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
        getWorkspacePath: () => null,
      };
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      (executor as any).createMergeWorktree = vi.fn();
      (executor as any).authorPrBodyWithSkill = vi.fn();
      (executor as any).execPr = vi.fn();

      await executor.approveMerge('wf-1');

      expect((executor as any).createMergeWorktree).not.toHaveBeenCalled();
      expect((executor as any).authorPrBodyWithSkill).not.toHaveBeenCalled();
      expect((executor as any).execPr).not.toHaveBeenCalled();
      expect(persistence.updateTask).not.toHaveBeenCalled();
    });
  });

  // ── checkPrApprovalNow ─────────────────────────────────

  describe('checkPrApprovalNow', () => {
    it('updates PR status when poller is active', async () => {
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'awaiting_approval',
          execution: { reviewId: 'owner/repo#42' },
        })),
        approve: vi.fn(),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn().mockResolvedValue({
          lifecycle: 'open',
          rejected: false,
          statusText: 'Awaiting review',
          url: 'https://github.com/owner/repo/pull/42',
        }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      await executor.checkPrApprovalNow('task-1');

      expect(orchestrator.getTask).toHaveBeenCalledWith('task-1');
      expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
        identifier: 'owner/repo#42',
        cwd: '/tmp',
      });
      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Awaiting review' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();
    });

    it('merged PR auto-completes a review_ready merge gate', async () => {
      const downstream = makeTask({
        id: 'downstream-after-manual-check',
        status: 'running',
      });
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'review_ready',
          execution: { reviewId: 'owner/repo#42' },
        })),
        approve: vi.fn().mockResolvedValue([downstream]),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn().mockResolvedValue({
          lifecycle: 'merged',
          rejected: false,
          statusText: 'Merged',
          url: 'https://github.com/owner/repo/pull/42',
        }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });
      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      await executor.checkPrApprovalNow('task-1');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Merged' },
      });
      expect(orchestrator.approve).toHaveBeenCalledWith('task-1');
      expect(executeTasks).toHaveBeenCalledWith([downstream]);
    });

    it('approved-but-open PR updates persistence without completing the gate', async () => {
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'review_ready',
          execution: { reviewId: 'owner/repo#42' },
        })),
        approve: vi.fn(),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn().mockResolvedValue({
          lifecycle: 'open',
          rejected: false,
          statusText: 'Approved, awaiting merge',
          url: 'https://github.com/owner/repo/pull/42',
        }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      await executor.checkPrApprovalNow('task-1');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Approved, awaiting merge' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();
    });

    it('rejected PR stops polling without completing the gate', async () => {
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'review_ready',
          execution: { reviewId: 'owner/repo#42' },
        })),
        approve: vi.fn(),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn().mockResolvedValue({
          lifecycle: 'open',
          rejected: true,
          statusText: 'Changes requested',
          url: 'https://github.com/owner/repo/pull/42',
        }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });
      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      await executor.checkPrApprovalNow('task-1');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Changes requested' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();
      expect(executeTasks).not.toHaveBeenCalled();
    });

    it('closed PR marks the gate closed without approving on manual check', async () => {
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'review_ready',
          execution: { reviewId: 'owner/repo#43' },
        })),
        approve: vi.fn(),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn().mockResolvedValue({
          lifecycle: 'closed',
          rejected: false,
          statusText: 'Closed',
          url: 'https://github.com/owner/repo/pull/43',
        }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });
      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      await executor.checkPrApprovalNow('task-closed');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-closed', {
        status: 'closed',
        execution: { reviewStatus: 'Closed' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();
      expect(executeTasks).not.toHaveBeenCalled();
    });

    it('merged PR completes the gate even when no poller is active (e.g. after process restart)', async () => {
      const downstream = makeTask({
        id: 'downstream-after-restart',
        status: 'running',
      });
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'review_ready',
          execution: { reviewId: 'owner/repo#42' },
        })),
        approve: vi.fn().mockResolvedValue([downstream]),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn().mockResolvedValue({
          lifecycle: 'merged',
          rejected: false,
          statusText: 'Merged',
          url: 'https://github.com/owner/repo/pull/42',
        }),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      // No active poller is registered — simulates a fresh process after restart
      await executor.checkPrApprovalNow('task-with-no-poller');

      expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
        identifier: 'owner/repo#42',
        cwd: '/tmp',
      });
      expect(orchestrator.approve).toHaveBeenCalledWith('task-with-no-poller');
      expect(executeTasks).toHaveBeenCalledWith([downstream]);
    });

    it('is no-op when task has no reviewId', async () => {
      const orchestrator = {
        getTask: vi.fn((id: string) => ({
          id,
          status: 'review_ready',
          execution: {},
        })),
        approve: vi.fn(),
      };
      const persistence = {
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        checkApproval: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      await executor.checkPrApprovalNow('task-without-review-id');

      expect(mergeGateProvider.checkApproval).not.toHaveBeenCalled();
      expect(persistence.updateTask).not.toHaveBeenCalled();
      expect(orchestrator.approve).not.toHaveBeenCalled();
    });

    it('is no-op when no mergeGateProvider', async () => {
      const orchestrator = {
        getTask: vi.fn(),
        approve: vi.fn(),
      };
      const persistence = {
        updateTask: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await executor.checkPrApprovalNow('task-1');

      expect(orchestrator.getTask).not.toHaveBeenCalled();
      expect(persistence.updateTask).not.toHaveBeenCalled();
    });
  });

  // ── merge-gate checkApproval cwd resolution ────────────

  describe('merge-gate checkApproval uses workspacePath as cwd', () => {
    describe('checkPrApprovalNow', () => {
      it('uses task workspacePath as cwd when present', async () => {
        const orchestrator = {
          getTask: vi.fn((id: string) => ({
            id,
            status: 'review_ready',
            execution: {
              reviewId: 'owner/repo#99',
              workspacePath: '/workspace/merge-worktree',
            },
          })),
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Pending',
            url: 'https://github.com/owner/repo/pull/99',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkPrApprovalNow('task-ws');

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#99',
          cwd: '/workspace/merge-worktree',
        });
      });

      it('falls back to runner cwd when workspacePath is undefined', async () => {
        const orchestrator = {
          getTask: vi.fn((id: string) => ({
            id,
            status: 'review_ready',
            execution: { reviewId: 'owner/repo#100' },
          })),
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Pending',
            url: 'https://github.com/owner/repo/pull/100',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkPrApprovalNow('task-no-ws');

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#100',
          cwd: '/runner-base-cwd',
        });
      });

      it('merged PR with workspacePath triggers orchestrator.approve', async () => {
        const downstream = makeTask({
          id: 'downstream-after-check-now',
          status: 'running',
        });
        const orchestrator = {
          getTask: vi.fn((id: string) => ({
            id,
            status: 'review_ready',
            execution: {
              reviewId: 'owner/repo#101',
              workspacePath: '/workspace/approved-worktree',
            },
          })),
          approve: vi.fn().mockResolvedValue([downstream]),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'merged',
            rejected: false,
            statusText: 'Merged',
            url: 'https://github.com/owner/repo/pull/101',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkPrApprovalNow('task-approved');

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#101',
          cwd: '/workspace/approved-worktree',
        });
        expect(persistence.updateTask).toHaveBeenCalledWith('task-approved', {
          execution: { reviewStatus: 'Merged' },
        });
        expect(orchestrator.approve).toHaveBeenCalledWith('task-approved');
        expect(executeTasks).toHaveBeenCalledWith([downstream]);
      });
    });

    describe('checkMergeGateStatuses', () => {
      it('closes the workflow merge-gate review using the gate workspace', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-close',
            status: 'review_ready',
            config: { workflowId: 'wf-close', isMergeNode: true },
            execution: {
              reviewId: '205',
              workspacePath: '/workspace/close-gate',
            },
          }),
        ];
        const orchestrator = {
          getAllTasks: () => allTasks,
        };
        const mergeGateProvider = {
          closeReview: vi.fn().mockResolvedValue(undefined),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: { updateTask: vi.fn() } as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.closeWorkflowReview('wf-close');

        expect(mergeGateProvider.closeReview).toHaveBeenCalledWith({
          identifier: '205',
          cwd: '/workspace/close-gate',
        });
      });

      it('uses task workspacePath as cwd when present', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-ws',
            status: 'review_ready',
            config: { isMergeNode: true },
            execution: {
              reviewId: 'owner/repo#200',
              workspacePath: '/workspace/gate-worktree',
            },
          }),
        ];
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Pending',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#200',
          cwd: '/workspace/gate-worktree',
        });
      });

      it('falls back to runner cwd when workspacePath is undefined', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-no-ws',
            status: 'awaiting_approval',
            config: { isMergeNode: true },
            execution: { reviewId: 'owner/repo#201' },
          }),
        ];

        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Pending',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#201',
          cwd: '/runner-base-cwd',
        });
      });

      it('records a task heartbeat when polling an awaiting_approval review-gate task', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-heartbeat',
            status: 'awaiting_approval',
            config: { isMergeNode: true },
            execution: {
              reviewId: 'owner/repo#301',
              workspacePath: '/workspace/heartbeat-gate',
            },
          }),
        ];

        const orchestrator = {
          getTask: (id: string) => allTasks.find((t) => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn(),
          recordTaskHeartbeat: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Pending',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledTimes(1);
        expect(orchestrator.recordTaskHeartbeat).toHaveBeenCalledTimes(1);
        expect(orchestrator.recordTaskHeartbeat).toHaveBeenCalledWith(
          'merge-heartbeat',
          expect.objectContaining({ source: 'executor', at: expect.any(Date) }),
        );
      });

      it('records a task heartbeat when checkPrApprovalNow polls a review-gate task manually', async () => {
        const task = makeTask({
          id: 'manual-heartbeat',
          status: 'awaiting_approval',
          config: { isMergeNode: true },
          execution: {
            reviewId: 'owner/repo#302',
            workspacePath: '/workspace/manual-heartbeat-gate',
          },
        });

        const orchestrator = {
          getTask: (id: string) => (id === task.id ? task : undefined),
          getAllTasks: () => [task],
          approve: vi.fn(),
          recordTaskHeartbeat: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Pending review',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkPrApprovalNow('manual-heartbeat');

        expect(orchestrator.recordTaskHeartbeat).toHaveBeenCalledTimes(1);
        expect(orchestrator.recordTaskHeartbeat).toHaveBeenCalledWith(
          'manual-heartbeat',
          expect.objectContaining({ source: 'executor' }),
        );
      });

      it('polls all current reviewGate artifacts and approves only after every required artifact is approved', async () => {
        const downstream = makeTask({ id: 'downstream-after-stack', status: 'running' });
        const reviewGate = {
          activeGeneration: 4,
          completion: { required: 'all' as const, status: 'approved' as const },
          artifacts: [
            { id: 'contracts', providerId: 'pr-1', required: true, status: 'open' as const, generation: 4 },
            { id: 'runtime', providerId: 'pr-2', required: true, status: 'open' as const, generation: 4, dependsOn: ['contracts'] },
          ],
        };
        const task = makeTask({
          id: 'merge-stack',
          status: 'review_ready',
          config: { isMergeNode: true },
          execution: {
            generation: 4,
            selectedAttemptId: 'attempt-1',
            reviewGate,
            workspacePath: '/workspace/stack-gate',
          },
        });
        const orchestrator = {
          getTask: (id: string) => (id === task.id ? task : undefined),
          getAllTasks: () => [task],
          approve: vi.fn().mockResolvedValue([downstream]),
        };
        const persistence = {
          updateTask: vi.fn((id: string, changes: any) => {
            if (id === task.id && changes.execution?.reviewGate) {
              (task as any).execution = { ...task.execution, ...changes.execution };
            }
          }),
        };
        const mergeGateProvider = {
          checkApproval: vi.fn()
            .mockResolvedValueOnce({ lifecycle: 'merged', rejected: false, statusText: 'Approved one', headSha: 'head-1' })
            .mockResolvedValueOnce({ lifecycle: 'open', rejected: false, statusText: 'Pending second', headSha: 'head-2' })
            .mockResolvedValueOnce({ lifecycle: 'merged', rejected: false, statusText: 'Still approved' })
            .mockResolvedValueOnce({ lifecycle: 'merged', rejected: false, statusText: 'Approved both' })
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenNthCalledWith(1, {
          identifier: 'pr-1',
          cwd: '/workspace/stack-gate',
        });
        expect(mergeGateProvider.checkApproval).toHaveBeenNthCalledWith(2, {
          identifier: 'pr-2',
          cwd: '/workspace/stack-gate',
        });
        expect(orchestrator.approve).not.toHaveBeenCalled();
        expect(task.execution.reviewGate?.artifacts).toEqual([
          expect.objectContaining({ id: 'contracts', status: 'approved', headSha: 'head-1' }),
          expect.objectContaining({ id: 'runtime', status: 'open', rawStatus: 'Pending second', headSha: 'head-2' }),
        ]);

        await executor.checkMergeGateStatuses();

        expect(orchestrator.approve).toHaveBeenCalledTimes(1);
        expect(orchestrator.approve).toHaveBeenCalledWith('merge-stack');
        expect(executeTasks).toHaveBeenCalledWith([downstream]);
        expect(task.execution.reviewGate?.artifacts).toEqual([
          expect.objectContaining({ id: 'contracts', status: 'approved' }),
          expect.objectContaining({ id: 'runtime', status: 'approved' }),
        ]);
      });

      it('marks a structured reviewGate task closed when a required artifact PR is closed', async () => {
        const reviewGate = {
          activeGeneration: 4,
          completion: { required: 'all' as const, status: 'approved' as const },
          artifacts: [
            { id: 'contracts', providerId: 'pr-1', required: true, status: 'open' as const, generation: 4 },
          ],
        };
        const task = makeTask({
          id: 'merge-stack-closed',
          status: 'review_ready',
          config: { isMergeNode: true },
          execution: {
            generation: 4,
            selectedAttemptId: 'attempt-1',
            reviewGate,
            workspacePath: '/workspace/stack-closed',
          },
        });
        const orchestrator = {
          getTask: (id: string) => (id === task.id ? task : undefined),
          getAllTasks: () => [task],
          approve: vi.fn(),
        };
        const persistence = {
          updateTask: vi.fn((id: string, changes: any) => {
            if (id === task.id) {
              (task as any).status = changes.status ?? task.status;
              if (changes.execution) {
                (task as any).execution = { ...task.execution, ...changes.execution };
              }
            }
          }),
        };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({ lifecycle: 'closed', rejected: false, statusText: 'Closed' }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();

        expect(persistence.updateTask).toHaveBeenCalledWith('merge-stack-closed', expect.objectContaining({
          status: 'closed',
        }));
        expect(orchestrator.approve).not.toHaveBeenCalled();
      });

      it('skips stale reviewGate poll results when the task generation changes before applying them', async () => {
        const initialTask = makeTask({
          id: 'merge-stale-stack',
          status: 'review_ready',
          config: { isMergeNode: true },
          execution: {
            generation: 4,
            selectedAttemptId: 'attempt-1',
            reviewGate: {
              activeGeneration: 4,
              completion: { required: 'all' as const, status: 'approved' as const },
              artifacts: [
                { id: 'contracts', providerId: 'pr-1', required: true, status: 'open' as const, generation: 4 },
              ],
            },
          },
        });
        const newerTask = makeTask({
          id: 'merge-stale-stack',
          status: 'review_ready',
          config: { isMergeNode: true },
          execution: {
            ...initialTask.execution,
            generation: 5,
            reviewGate: {
              activeGeneration: 5,
              completion: { required: 'all' as const, status: 'approved' as const },
              artifacts: [
                { id: 'contracts-v2', providerId: 'pr-2', required: true, status: 'open' as const, generation: 5 },
              ],
            },
          },
        });
        const orchestrator = {
          getTask: vi.fn(() => newerTask),
          getAllTasks: () => [initialTask],
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'merged',
            rejected: false,
            statusText: 'Approved stale',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'pr-1',
          cwd: '/runner-base-cwd',
        });
        expect(persistence.updateTask).not.toHaveBeenCalled();
        expect(orchestrator.approve).not.toHaveBeenCalled();
      });


      it('merged status with workspacePath triggers orchestrator.approve', async () => {
        const downstream = makeTask({
          id: 'downstream-after-refresh',
          status: 'running',
        });
        const allTasks = [
          makeTask({
            id: 'merge-approved',
            status: 'review_ready',
            config: { isMergeNode: true },
            execution: {
              reviewId: 'owner/repo#202',
              workspacePath: '/workspace/approved-gate',
            },
          }),
        ];
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn().mockResolvedValue([downstream]),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'merged',
            rejected: false,
            statusText: 'Merged',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#202',
          cwd: '/workspace/approved-gate',
        });
        expect(persistence.updateTask).toHaveBeenCalledWith('merge-approved', {
          execution: { reviewStatus: 'Merged' },
        });
        expect(orchestrator.approve).toHaveBeenCalledWith('merge-approved');
        expect(executeTasks).toHaveBeenCalledWith([downstream]);
      });

      it('approved-but-open PR updates persistence without completing the gate', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-open-approved',
            status: 'review_ready',
            config: { isMergeNode: true },
            execution: {
              reviewId: 'owner/repo#203',
              workspacePath: '/workspace/open-approved-gate',
            },
          }),
        ];
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: false,
            statusText: 'Approved, awaiting merge',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#203',
          cwd: '/workspace/open-approved-gate',
        });
        expect(persistence.updateTask).toHaveBeenCalledWith('merge-open-approved', {
          execution: { reviewStatus: 'Approved, awaiting merge' },
        });
        expect(orchestrator.approve).not.toHaveBeenCalled();
      });

      it('rejected PR stops polling without completing the gate', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-rejected',
            status: 'review_ready',
            config: { isMergeNode: true },
            execution: {
              reviewId: 'owner/repo#204',
              workspacePath: '/workspace/rejected-gate',
            },
          }),
        ];
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'open',
            rejected: true,
            statusText: 'Changes requested',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#204',
          cwd: '/workspace/rejected-gate',
        });
        expect(persistence.updateTask).toHaveBeenCalledWith('merge-rejected', {
          execution: { reviewStatus: 'Changes requested' },
        });
        expect(orchestrator.approve).not.toHaveBeenCalled();
        expect(executeTasks).not.toHaveBeenCalled();
      });

      it('closed PR marks the gate closed on refresh without completing it', async () => {
        const allTasks = [
          makeTask({
            id: 'merge-closed',
            status: 'review_ready',
            config: { isMergeNode: true },
            execution: {
              reviewId: 'owner/repo#205',
              workspacePath: '/workspace/closed-gate',
            },
          }),
        ];
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'closed',
            rejected: false,
            statusText: 'Closed',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#205',
          cwd: '/workspace/closed-gate',
        });
        expect(persistence.updateTask).toHaveBeenCalledWith('merge-closed', {
          status: 'closed',
          execution: { reviewStatus: 'Closed' },
        });
        expect(orchestrator.approve).not.toHaveBeenCalled();
        expect(executeTasks).not.toHaveBeenCalled();
      });

      it('closed PR transitions an awaiting_approval gate to closed on refresh', async () => {
        const closingTask = makeTask({
          id: 'merge-awaiting-closed',
          status: 'awaiting_approval',
          config: { isMergeNode: true },
          execution: {
            reviewId: 'owner/repo#206',
            workspacePath: '/workspace/awaiting-closed-gate',
          },
        });
        const orchestrator = {
          getTask: (id: string) => (id === closingTask.id ? closingTask : undefined),
          getAllTasks: () => [closingTask],
          approve: vi.fn(),
        };
        const persistence = { updateTask: vi.fn() };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'closed',
            rejected: false,
            statusText: 'Closed',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();

        expect(persistence.updateTask).toHaveBeenCalledWith('merge-awaiting-closed', {
          status: 'closed',
          execution: { reviewStatus: 'Closed' },
        });
        expect(orchestrator.approve).not.toHaveBeenCalled();
        expect(executeTasks).not.toHaveBeenCalled();
      });

      it('stops polling a closed merge gate on subsequent refresh passes', async () => {
        const task = makeTask({
          id: 'merge-closed-stops-polling',
          status: 'review_ready',
          config: { isMergeNode: true },
          execution: {
            reviewId: 'owner/repo#207',
            workspacePath: '/workspace/closed-stop-poll',
          },
        });
        const orchestrator = {
          getTask: (id: string) => (id === task.id ? task : undefined),
          getAllTasks: () => [task],
          approve: vi.fn(),
        };
        const persistence = {
          updateTask: vi.fn((id: string, changes: any) => {
            if (id === task.id && changes.status) {
              (task as any).status = changes.status;
            }
          }),
        };
        const mergeGateProvider = {
          checkApproval: vi.fn().mockResolvedValue({
            lifecycle: 'closed',
            rejected: false,
            statusText: 'Closed',
          }),
        };

        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: persistence as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/runner-base-cwd',
          mergeGateProvider: mergeGateProvider as any,
        });
        vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

        await executor.checkMergeGateStatuses();
        expect(mergeGateProvider.checkApproval).toHaveBeenCalledTimes(1);
        expect(task.status).toBe('closed');

        await executor.checkMergeGateStatuses();
        // Closed status falls outside the (review_ready || awaiting_approval) polling filter,
        // so no additional provider call should happen on the second refresh pass.
        expect(mergeGateProvider.checkApproval).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── buildMergeSummary ─────────────────────────────────

  describe('buildMergeSummary', () => {
    function createExecutorForSummary(
      allTasks: TaskState[],
      workflowMeta?: { name?: string; description?: string; visualProof?: boolean },
    ) {
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
      };
      const persistence = {
        loadWorkflow: () => workflowMeta ? { id: 'wf-1', name: workflowMeta.name ?? 'Test Workflow', ...workflowMeta } : undefined,
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      return { executor, persistence };
    }

    it('produces concise output with git diff --stat without raw prompts', async () => {
      const tasks = [
        makeTask({
          id: 'impl-1',
          description: 'Add feature X',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/impl-1' },
        }),
        makeTask({
          id: 'test-1',
          description: 'Run tests',
          status: 'completed',
          config: { workflowId: 'wf-1', command: 'pnpm test' },
          execution: { branch: 'experiment/test-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'My Feature' });
      (executor as any).gitDiffStat = vi.fn()
        .mockResolvedValueOnce(' src/foo.ts | 5 ++---')
        .mockResolvedValueOnce(' tests/foo.test.ts | 3 +++');

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('## Summary');
      expect(result).toContain('My Feature');
      expect(result).toContain('2 tasks completed');
      expect(result).toContain('impl-1');
      expect(result).toContain('test-1');
      expect(result).toContain('(passed)');
      expect(result).toContain('src/foo.ts');
      expect(result).toContain('tests/foo.test.ts');
      expect(result).toContain('<details>');
      expect(result).toContain('File changes per task');
      expect(result).not.toContain('Prompt:');
      expect(result).not.toContain('Command:');
    });

    it('handles gitDiffStat failures gracefully', async () => {
      const tasks = [
        makeTask({
          id: 'task-1',
          description: 'Add feature',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/task-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Feature' });
      (executor as any).gitDiffStat = vi.fn().mockRejectedValue(new Error('git diff --stat failed'));

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('Add feature');
    });

    it('identifies Claude-resolved reconciliation tasks', async () => {
      const tasks = [
        makeTask({
          id: 'recon-task',
          description: 'Reconcile conflicts',
          status: 'completed',
          config: { isReconciliation: true, workflowId: 'wf-1' },
          execution: { branch: 'experiment/recon-task' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('## Conflict Resolutions');
      expect(result).toContain('recon-task');
    });

    it('does NOT treat agentSessionId tasks as conflict resolutions', async () => {
      const tasks = [
        makeTask({
          id: 'claude-task',
          description: 'Fix with Claude',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { agentSessionId: 'session-123', branch: 'experiment/claude-task' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      // Bug fix: agentSessionId alone does NOT make a task a conflict resolution
      expect(result).not.toContain('## Conflict Resolutions');
      expect(result).toContain('claude-task');
    });

    it('reports failed tasks', async () => {
      const tasks = [
        makeTask({
          id: 'fail-task',
          description: 'Build step',
          status: 'failed',
          config: { workflowId: 'wf-1' },
          execution: { error: 'Build failed' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('## Failed Tasks');
      expect(result).toContain('Build failed');
    });

    it('reports skipped tasks', async () => {
      const tasks = [
        makeTask({
          id: 'skip-task',
          description: 'Pending step',
          status: 'pending',
          config: { workflowId: 'wf-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('## Skipped Tasks');
      expect(result).toContain('Pending step');
    });

    it('reports closed tasks separately from skipped tasks', async () => {
      const tasks = [
        makeTask({
          id: 'closed-gate',
          description: 'Closed review gate',
          status: 'closed',
          config: { workflowId: 'wf-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('0 failed, 1 closed, 0 skipped');
      expect(result).toContain('## Closed Tasks');
      expect(result).toContain('Closed review gate');
      expect(result).not.toContain('## Skipped Tasks');
    });

    it('omits empty sections', async () => {
      const tasks = [
        makeTask({
          id: 'task-1',
          description: 'Task one',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/task-1' },
        }),
        makeTask({
          id: 'task-2',
          description: 'Task two',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/task-2' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).not.toContain('## Failed Tasks');
      expect(result).not.toContain('## Skipped Tasks');
      expect(result).not.toContain('## Conflict Resolutions');
    });

    it('filters tasks to the given workflowId', async () => {
      const tasks = [
        makeTask({
          id: 'wf1-task',
          description: 'Workflow 1 task',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/wf1-task' },
        }),
        makeTask({
          id: 'wf2-task',
          description: 'Workflow 2 task',
          status: 'completed',
          config: { workflowId: 'wf-2' },
          execution: { branch: 'experiment/wf2-task' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('Workflow 1 task');
      expect(result).not.toContain('Workflow 2 task');
    });

    it('includes workflow description with horizontal rule when present', async () => {
      const tasks = [
        makeTask({
          id: 'task-1',
          description: 'Task one',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/task-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, {
        name: 'Feature Workflow',
        description: 'This workflow adds a new feature.\n\nIt includes multiple steps.',
      });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('## Summary');
      expect(result).toContain('This workflow adds a new feature.');
      expect(result).toContain('It includes multiple steps.');
      expect(result).toContain('---');
      expect(result).toContain('Feature Workflow — 1 tasks completed');
    });

    it('omits description and horizontal rule when description is empty', async () => {
      const tasks = [
        makeTask({
          id: 'task-1',
          description: 'Task one',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/task-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, {
        name: 'Feature Workflow',
        description: '',
      });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('## Summary');
      const lines = result.split('\n');
      const summaryIdx = lines.indexOf('## Summary');
      expect(lines[summaryIdx + 1]).toContain('Feature Workflow — 1 tasks completed');
      expect(lines[summaryIdx + 1]).not.toContain('---');
      expect(result).not.toMatch(/\n---\n/);
    });

    it('includes task breakdown table with all tasks', async () => {
      const tasks = [
        makeTask({
          id: 'impl-1',
          description: 'Implement feature',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/impl-1' },
        }),
        makeTask({
          id: 'test-1',
          description: 'Run tests',
          status: 'completed',
          config: { workflowId: 'wf-1', command: 'pnpm test' },
          execution: { branch: 'experiment/test-1' },
        }),
        makeTask({
          id: 'fail-1',
          description: 'Failed command',
          status: 'failed',
          config: { workflowId: 'wf-1', command: 'pnpm build' },
          execution: { error: 'Build error' },
        }),
        makeTask({
          id: 'pending-1',
          description: 'Pending task',
          status: 'pending',
          config: { workflowId: 'wf-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });
      (executor as any).gitDiffStat = vi.fn();

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('<summary>Task breakdown</summary>');
      expect(result).toContain('| Task | Description | Status |');
      expect(result).toContain('| impl-1 | Implement feature | completed |');
      expect(result).toContain('| test-1 | Run tests | completed (passed) |');
      expect(result).toContain('| fail-1 | Failed command | failed (failed) |');
      expect(result).toContain('| pending-1 | Pending task | pending |');
    });

    it('wraps file changes in collapsible details', async () => {
      const tasks = [
        makeTask({
          id: 'impl-1',
          description: 'Add feature X',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'experiment/impl-1' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, { name: 'Workflow' });
      (executor as any).gitDiffStat = vi.fn().mockResolvedValue(' src/foo.ts | 5 ++---');

      const result = await executor.buildMergeSummary('wf-1');

      expect(result).toContain('<summary>File changes per task</summary>');
      expect(result).toContain('### impl-1 — Add feature X');
      expect(result).toContain('src/foo.ts');
    });

    it('PROOF: logs full summary with description for visual inspection', async () => {
      const tasks = [
        makeTask({
          id: 'scheduler-methods',
          description: 'Add getQueuedJobs, removeJob, getRunningJobs methods to TaskScheduler',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'task/scheduler-methods' },
        }),
        makeTask({
          id: 'orchestrator-cancel',
          description: 'Add cancelTask and getQueueStatus methods to Orchestrator',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'task/orchestrator-cancel' },
        }),
        makeTask({
          id: 'verify-core-tests',
          description: 'Run core package tests to verify scheduler and cancel implementations',
          status: 'completed',
          config: { workflowId: 'wf-1', command: 'cd packages/core && pnpm test' },
          execution: { branch: 'task/verify-core' },
        }),
        makeTask({
          id: 'ui-queue-view',
          description: 'Add QueueView component with utilization bar and cancel buttons',
          status: 'completed',
          config: { workflowId: 'wf-1' },
          execution: { branch: 'task/ui-queue-view', agentSessionId: 'session-abc' },
        }),
        makeTask({
          id: 'flaky-build',
          description: 'Build UI package to verify compilation',
          status: 'failed',
          config: { workflowId: 'wf-1', command: 'cd packages/ui && pnpm build' },
          execution: { error: 'TS2345: Type mismatch in QueueView.tsx' },
        }),
      ];
      const { executor } = createExecutorForSummary(tasks, {
        name: 'Queue visibility and task cancellation with DAG cascade',
        description: [
          'Adds the ability to view queued tasks and cancel running tasks with automatic',
          'cascade through the task DAG.',
          '',
          'Architecture: TaskScheduler gains three introspection methods (getQueuedJobs,',
          'removeJob, getRunningJobs) for low-level queue management. Orchestrator wraps',
          'these with DAG-aware cancelTask semantics — cancelling a task also cancels all',
          'downstream dependents. The UI surfaces this through a QueueView panel and a',
          'Cancel Task option in the existing context menu.',
          '',
          'Tradeoffs: Cancel sends SIGTERM immediately rather than waiting for graceful',
          'shutdown. The queue view polls on an interval rather than subscribing to events.',
        ].join('\n'),
      });
      (executor as any).gitDiffStat = vi.fn()
        .mockResolvedValueOnce(' packages/core/src/scheduler.ts | 23 +++\n 1 file changed, 23 insertions(+)')
        .mockResolvedValueOnce(' packages/core/src/orchestrator.ts | 91 ++++++\n 1 file changed, 91 insertions(+)')
        .mockResolvedValueOnce(' (empty)')
        .mockResolvedValueOnce(' packages/ui/src/components/QueueView.tsx | 218 +++++++++\n 1 file changed, 218 insertions(+)');

      const result = await executor.buildMergeSummary('wf-1');

      console.log('\n========== PROOF: NEW PR SUMMARY FORMAT ==========');
      console.log(result);
      console.log('========== END PROOF ==========\n');

      expect(result).toContain('Adds the ability to view queued tasks');
      expect(result).toContain('Architecture: TaskScheduler');
      expect(result).toContain('Tradeoffs: Cancel sends SIGTERM');
      expect(result).toContain('4 tasks completed, 1 failed');
      expect(result).toContain('<details>');
      expect(result).not.toContain('## Conflict Resolutions');
      expect(result).toContain('## Failed Tasks');
    });
  });

  // ── mergeExperimentBranches ─────────────────────────────

  describe('mergeExperimentBranches', () => {
    it('merges multiple experiment branches into a reconciliation branch', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('pivot-exp-v1', makeTask({
        id: 'pivot-exp-v1',
        status: 'completed',
        execution: { branch: 'experiment/pivot-exp-v1-hash1', commit: 'commit1' },
      }));
      tasks.set('pivot-exp-v2', makeTask({
        id: 'pivot-exp-v2',
        status: 'completed',
        execution: { branch: 'experiment/pivot-exp-v2-hash2', commit: 'commit2' },
      }));
      tasks.set('pivot-reconciliation', makeTask({
        id: 'pivot-reconciliation',
        config: { isReconciliation: true, parentTask: 'pivot' },
      }));
      tasks.set('pivot', makeTask({
        id: 'pivot',
        status: 'completed',
        execution: { branch: 'experiment/pivot-base' },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged-commit-hash';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged-commit-hash';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      const result = await executor.mergeExperimentBranches('pivot-reconciliation', ['pivot-exp-v1', 'pivot-exp-v2']);

      expect(result.branch).toBe('reconciliation/pivot-reconciliation');
      expect(result.commit).toBe('merged-commit-hash');

      // Verify git operations
      expect(gitCalls).toContainEqual(['checkout', '-b', 'reconciliation/pivot-reconciliation', 'experiment/pivot-base']);
      expect(gitCalls).toContainEqual(expect.arrayContaining(['merge', '--no-ff', '-m', expect.stringContaining('experiment/pivot-exp-v1-hash1')]));
      expect(gitCalls).toContainEqual(expect.arrayContaining(['merge', '--no-ff', '-m', expect.stringContaining('experiment/pivot-exp-v2-hash2')]));
    });

    it('merge conflict aborts and throws', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('pivot-exp-v1', makeTask({
        id: 'pivot-exp-v1',
        status: 'completed',
        execution: { branch: 'experiment/pivot-exp-v1-hash1' },
      }));
      tasks.set('pivot-exp-v2', makeTask({
        id: 'pivot-exp-v2',
        status: 'completed',
        execution: { branch: 'experiment/pivot-exp-v2-hash2' },
      }));
      tasks.set('pivot-reconciliation', makeTask({
        id: 'pivot-reconciliation',
        config: { isReconciliation: true, parentTask: 'pivot' },
      }));
      tasks.set('pivot', makeTask({
        id: 'pivot',
        status: 'completed',
        execution: { branch: 'experiment/pivot-base' },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      let mergeCount = 0;
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT (content)');
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT (content)');
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await expect(
        executor.mergeExperimentBranches('pivot-reconciliation', ['pivot-exp-v1', 'pivot-exp-v2']),
      ).rejects.toThrow('CONFLICT');
    });

    it('single experiment returns its branch directly', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('pivot-exp-v1', makeTask({
        id: 'pivot-exp-v1',
        status: 'completed',
        execution: { branch: 'experiment/pivot-exp-v1-hash1', commit: 'single-commit' },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const result = await executor.mergeExperimentBranches('pivot-reconciliation', ['pivot-exp-v1']);

      expect(result.branch).toBe('experiment/pivot-exp-v1-hash1');
      expect(result.commit).toBe('single-commit');
    });
  });

  describe('consolidateAndMerge', () => {
    it('does not fail when branch -D reports feature branch missing during recreate', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('A', makeTask({
        id: 'A',
        status: 'completed',
        config: { workflowId: 'wf-1' },
        execution: { branch: 'invoker/A' },
      }));
      tasks.set('__merge__wf-1', makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['A'],
        config: { workflowId: 'wf-1', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const mockExecutor = createAutoCompleteExecutor();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'none', mergeMode: 'manual', baseBranch: 'master', featureBranch: 'feature/wf-1', name: 'Test' }), updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => mockExecutor, get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      let checkoutCreateCalls = 0;
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'checkout' && args[1] === '-b') {
          checkoutCreateCalls += 1;
          if (checkoutCreateCalls === 1) {
            throw new Error('git checkout -b feature/wf-1 master failed (code 1): simulated create failure');
          }
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') {
          throw new Error("git branch -D feature/wf-1 failed (code 1): error: branch 'feature/wf-1' not found");
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await expect(executor.executeTask(tasks.get('__merge__wf-1')!)).resolves.toBeUndefined();
    });

    it('merges only direct dependency branches when merge gate depends on the tip task', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('A', makeTask({ id: 'A', status: 'completed', config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/A' } }));
      tasks.set('B', makeTask({ id: 'B', status: 'completed', dependencies: ['A'], config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/B' } }));
      tasks.set('C', makeTask({ id: 'C', status: 'completed', dependencies: ['B'], config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/C' } }));
      tasks.set('D', makeTask({ id: 'D', status: 'completed', dependencies: ['C'], config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/D' } }));
      tasks.set('__merge__wf-1', makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['D'],
        config: { workflowId: 'wf-1', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const mockExecutor = createAutoCompleteExecutor();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-1', name: 'Test' }), updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => mockExecutor, get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergedBranches: string[] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.executeTask(tasks.get('__merge__wf-1')!);

      expect(mergedBranches.sort()).toEqual(['invoker/D']);
    });

    it('does not include sibling leaves omitted from merge.dependencies', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('verify-ui-tests', makeTask({
        id: 'verify-ui-tests',
        status: 'completed',
        config: { workflowId: 'wf-par' },
        execution: { branch: 'experiment/verify-par' },
      }));
      tasks.set('distinguish', makeTask({
        id: 'distinguish',
        status: 'completed',
        config: { workflowId: 'wf-par' },
        execution: { branch: 'experiment/distinguish-par' },
      }));
      tasks.set('__merge__wf-par', makeTask({
        id: '__merge__wf-par',
        status: 'running',
        dependencies: ['distinguish'],
        config: { workflowId: 'wf-par', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const mockExecutor = createAutoCompleteExecutor();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {
          loadWorkflow: () => ({
            onFinish: 'merge',
            mergeMode: 'automatic',
            baseBranch: 'master',
            featureBranch: 'feature/wf-par',
            name: 'Test',
          }),
          updateTask: vi.fn(),
        } as any,
        executorRegistry: { getDefault: () => mockExecutor, get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergedBranches: string[] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.executeTask(tasks.get('__merge__wf-par')!);

      expect(mergedBranches.sort()).toEqual(['experiment/distinguish-par']);
    });

    it('does not merge transitive upstream branches when merge gate depends on final leaf', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('verify-ui-tests', makeTask({
        id: 'verify-ui-tests',
        status: 'completed',
        config: { workflowId: 'wf-chain' },
        execution: { branch: 'experiment/verify-ce05' },
      }));
      tasks.set('distinguish', makeTask({
        id: 'distinguish',
        status: 'completed',
        dependencies: ['verify-ui-tests'],
        config: { workflowId: 'wf-chain' },
        execution: { branch: 'experiment/distinguish-aa' },
      }));
      tasks.set('__merge__wf-chain', makeTask({
        id: '__merge__wf-chain',
        status: 'running',
        dependencies: ['distinguish'],
        config: { workflowId: 'wf-chain', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const mockExecutor = createAutoCompleteExecutor();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {
          loadWorkflow: () => ({
            onFinish: 'merge',
            mergeMode: 'automatic',
            baseBranch: 'master',
            featureBranch: 'feature/wf-chain',
            name: 'Test',
          }),
          updateTask: vi.fn(),
        } as any,
        executorRegistry: { getDefault: () => mockExecutor, get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergedBranches: string[] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.executeTask(tasks.get('__merge__wf-chain')!);

      expect(mergedBranches).toContain('experiment/distinguish-aa');
      expect(mergedBranches).not.toContain('experiment/verify-ce05');
    });

    it('forked graph: merges only direct merge gate dependencies', async () => {
      const tasks = new Map<string, TaskState>();
      // A -> B -> D, A -> C -> E. Merge gate depends on [D, E]
      tasks.set('A', makeTask({ id: 'A', status: 'completed', config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/A' } }));
      tasks.set('B', makeTask({ id: 'B', status: 'completed', dependencies: ['A'], config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/B' } }));
      tasks.set('C', makeTask({ id: 'C', status: 'completed', dependencies: ['A'], config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/C' } }));
      tasks.set('D', makeTask({ id: 'D', status: 'completed', dependencies: ['B'], config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/D' } }));
      tasks.set('E', makeTask({ id: 'E', status: 'completed', dependencies: ['C'], config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/E' } }));
      tasks.set('__merge__wf-2', makeTask({
        id: '__merge__wf-2',
        status: 'running',
        dependencies: ['D', 'E'],
        config: { workflowId: 'wf-2', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-2', name: 'Test' }), updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => createAutoCompleteExecutor(), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergedBranches: string[] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.executeTask(tasks.get('__merge__wf-2')!);

      expect(mergedBranches.sort()).toEqual([
        'invoker/D',
        'invoker/E',
      ]);
    });

    it('merges branches in sorted order for determinism', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('z-task', makeTask({ id: 'z-task', status: 'completed', config: { workflowId: 'wf-3' }, execution: { branch: 'invoker/z-task' } }));
      tasks.set('a-task', makeTask({ id: 'a-task', status: 'completed', config: { workflowId: 'wf-3' }, execution: { branch: 'invoker/a-task' } }));
      tasks.set('m-task', makeTask({ id: 'm-task', status: 'completed', config: { workflowId: 'wf-3' }, execution: { branch: 'invoker/m-task' } }));
      tasks.set('__merge__wf-3', makeTask({
        id: '__merge__wf-3',
        status: 'running',
        dependencies: ['z-task', 'a-task', 'm-task'],
        config: { workflowId: 'wf-3', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-3', name: 'Test' }), updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => createAutoCompleteExecutor(), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergeOrder: string[] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const branch = args[args.length - 1];
          // Only capture task branch merges (invoker/...), not the final feature branch merge
          if (branch.startsWith('invoker/')) mergeOrder.push(branch);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const branch = args[args.length - 1];
          // Only capture task branch merges (invoker/...), not the final feature branch merge
          if (branch.startsWith('invoker/')) mergeOrder.push(branch);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.executeTask(tasks.get('__merge__wf-3')!);

      // Branches should be merged in sorted order
      expect(mergeOrder).toEqual(['invoker/a-task', 'invoker/m-task', 'invoker/z-task']);
    });

    it('approveMerge aborts and restores branch on merge failure', async () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => undefined, getAllTasks: () => [] } as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', baseBranch: 'master', featureBranch: 'feature/test', name: 'Test' }), updateTask: vi.fn(), getWorkspacePath: () => null } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const calls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        calls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'original-branch';
        if (args[0] === 'merge' && args.includes('--squash')) throw new Error('CONFLICT');
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        calls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'original-branch';
        if (args[0] === 'merge' && args.includes('--squash')) throw new Error('CONFLICT');
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await expect(executor.approveMerge('wf-test')).rejects.toThrow('CONFLICT');

      // Should have attempted merge --abort (no rebase)
      const rebaseAbort = calls.find(c => c[0] === 'rebase' && c[1] === '--abort');
      const mergeAbort = calls.find(c => c[0] === 'merge' && c[1] === '--abort');
      expect(rebaseAbort).toBeUndefined();
      expect(mergeAbort).toBeDefined();
    });

    it('leaves pull_request visual proof capture to the caller instead of consolidateAndMerge', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('t1', makeTask({
        id: 't1', status: 'completed',
        config: { workflowId: 'wf-1' },
        execution: { branch: 'experiment/t1' },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-1', name: 'Test', visualProof: true }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).runVisualProofCapture = vi.fn().mockResolvedValue('## Visual Proof\n| Before | After |');
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored consolidate body',
        sessionId: 'sess-pr-5',
        agentName: 'codex',
      });

      await executor.consolidateAndMerge(
        'pull_request', 'master', 'plan/test', 'wf-1', 'Test', ['t1'],
        'original body', true,
      );

      expect((executor as any).runVisualProofCapture).not.toHaveBeenCalled();
      expect((executor as any).authorPrBodyWithSkill).not.toHaveBeenCalled();
    });


    it('still succeeds when pull_request visual proof is delegated to the caller', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('t1', makeTask({
        id: 't1', status: 'completed',
        config: { workflowId: 'wf-1' },
        execution: { branch: 'experiment/t1' },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-1', name: 'Test', visualProof: true }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).runVisualProofCapture = vi.fn().mockResolvedValue(undefined);
      (executor as any).authorPrBodyWithSkill = vi.fn();

      await executor.consolidateAndMerge(
        'pull_request', 'master', 'plan/test', 'wf-1', 'Test', ['t1'],
        'original body', true,
      );

      expect((executor as any).runVisualProofCapture).not.toHaveBeenCalled();
      expect((executor as any).authorPrBodyWithSkill).not.toHaveBeenCalled();
    });

    it('skips visual proof when visualProof is false', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('t1', makeTask({
        id: 't1', status: 'completed',
        config: { workflowId: 'wf-1' },
        execution: { branch: 'experiment/t1' },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-1', name: 'Test' }),
        updateTask: vi.fn(),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).runVisualProofCapture = vi.fn();

      await executor.consolidateAndMerge(
        'none', 'master', 'plan/test', 'wf-1', 'Test', ['t1'],
        'original body', false,
      );

      expect((executor as any).runVisualProofCapture).not.toHaveBeenCalled();
    });
  });

});
