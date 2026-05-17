import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { collectDirectNonMergeTaskIds } from '../merge-runner.js';
import { SshExecutor } from '../ssh-executor.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse, Logger } from '@invoker/contracts';
import { EventEmitter } from 'events';
import { buildCanonicalPrBody, validateCanonicalPrBody } from '../pr-authoring.js';
import type { PrAuthoringContext } from '../pr-authoring.js';

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

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
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

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
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

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
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

      const runner = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { updateTask } as any,
        executorRegistry: registry as any,
        cwd: '/tmp',
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
        expect(heartbeats).toEqual(['slow-start']);
        await vi.advanceTimersByTimeAsync(35_000);
        await done;
        expect(heartbeats).toEqual(['slow-start', 'slow-start']);
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

      // Default mergeMode is 'manual', so setTaskAwaitingApproval is called with metadata
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ branch: 'plan/feature', workspacePath: '/tmp/mock-wt' }),
      }));
    });
  });

  describe('rebaseTaskBranches', () => {
    it('rebases all completed task branches onto baseBranch', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
        makeTask({ id: 't2', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t2' } }),
        makeTask({ id: 't3', config: { workflowId: 'wf-1' }, status: 'pending', execution: { branch: 'experiment/t3' } }),
        makeTask({ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true }, status: 'failed' }),
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
      expect(result.rebasedBranches).toEqual(['experiment/t1', 'experiment/t2']);
      expect(result.errors).toEqual([]);

      const rebaseCalls = gitCalls.filter(c => c[0] === 'rebase');
      expect(rebaseCalls).toHaveLength(2);
      expect(rebaseCalls[0]).toEqual(['rebase', 'master']);
      expect(rebaseCalls[1]).toEqual(['rebase', 'master']);
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

    it('skips merge nodes and non-completed tasks', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
        makeTask({ id: 't2', config: { workflowId: 'wf-1' }, status: 'failed', execution: { branch: 'experiment/t2' } }),
        makeTask({ id: '__merge__wf-1', config: { workflowId: 'wf-1', isMergeNode: true }, status: 'failed', execution: { branch: 'plan/feature' } }),
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

      // Should call setTaskAwaitingApproval with metadata instead of handleWorkerResponse
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ branch: 'plan/feature', workspacePath: '/tmp/mock-wt' }),
      }));
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

      // Prevent setInterval leak from startPrPolling
      (executor as any).startPrPolling = vi.fn();

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

      // Should set task awaiting approval with PR metadata (not handleWorkerResponse)
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/42',
          reviewId: 'owner/repo#42',
          reviewStatus: 'Awaiting review',
        }),
      }));
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
      (executor as any).startPrPolling = vi.fn();
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
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        execution: expect.objectContaining({
          workspacePath: gateWorkspace,
          branch: 'plan/example',
        }),
      }));
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
      (executor as any).startPrPolling = vi.fn();
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

    it('executeMergeNode goes to awaiting_approval when mergeMode=manual and onFinish=none', async () => {
      const orchestrator = {
        getTask: () => null,
        getAllTasks: () => [],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
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
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ workspacePath: undefined }),
      }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('executeMergeNode auto-completes when mergeMode=automatic and onFinish=none', async () => {
      const orchestrator = {
        getTask: () => null,
        getAllTasks: () => [],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
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
      (executor as any).startPrPolling = vi.fn();
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

      // Should pass PR metadata through setTaskAwaitingApproval
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/55',
          reviewId: 'owner/repo#55',
          reviewStatus: 'Awaiting review',
        }),
      }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();

      // Should start polling
      expect((executor as any).startPrPolling).toHaveBeenCalledWith('__merge__wf-1', 'owner/repo#55', 'wf-1');
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
      (executor as any).startPrPolling = vi.fn();
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
      (executor as any).startPrPolling = vi.fn();
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
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalled();
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('executeMergeNode goes to awaiting_approval when mergeMode=manual and no featureBranch', async () => {
      const orchestrator = {
        getTask: () => null,
        getAllTasks: () => [],
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
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
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ workspacePath: undefined }),
      }));
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
      (executor as any).startPrPolling = vi.fn();
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
      (executor as any).startPrPolling = vi.fn();
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

    it('approveMerge with onFinish=pull_request persists PR URL', async () => {
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
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/55');

      const logSpy = vi.spyOn(console, 'log');

      await executor.approveMerge('wf-1');

      // Should push + create PR (with clone dir as cwd)
      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        cwd: '/tmp/mock-wt',
      }));
      expect((executor as any).execPr).toHaveBeenCalledWith('master', 'plan/feature', 'Test Workflow', '## Summary\n\nAuthored body', '/tmp/mock-wt');

      // Should persist the PR URL on the merge task
      expect(persistence.updateTask).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: expect.objectContaining({ summary: expect.any(String) }),
          execution: { reviewUrl: 'https://github.com/owner/repo/pull/55' },
        }),
      );

      // Should log the PR URL
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('https://github.com/owner/repo/pull/55'),
      );

      logSpy.mockRestore();
    });

    it('automatic merge with onFinish=pull_request persists PR URL', async () => {
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
          onFinish: 'pull_request',
          mergeMode: 'automatic',
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
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/77');

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should persist the PR URL via the final updateTask call
      expect(persistence.updateTask).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          execution: expect.objectContaining({
            reviewUrl: 'https://github.com/owner/repo/pull/77',
          }),
        }),
      );

      // Should complete successfully
      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
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
      (executor as any).startPrPolling = vi.fn();
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
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: expect.objectContaining({ summary: '## Summary\nTest summary' }),
        }),
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

      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: expect.objectContaining({ summary: '## Summary\nManual summary' }),
        }),
      );
    });

    it('approveMerge passes summary body to execPr for pull_request onFinish', async () => {
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
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('## Summary\nApprove summary');
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nApprove authored body',
        sessionId: 'sess-pr-3',
        agentName: 'codex',
      });
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/88');

      await executor.approveMerge('wf-1');

      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        workflowSummary: '## Summary\nApprove summary',
      }));
      expect((executor as any).execPr).toHaveBeenCalledWith(
        'master', 'plan/feature', 'Test Workflow', '## Summary\n\nApprove authored body', '/tmp/mock-wt',
      );
      expect(persistence.updateTask).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: expect.objectContaining({ summary: '## Summary\nApprove summary' }),
        }),
      );
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
          approved: false,
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

      // Simulate active poller by adding to activePrPollers map
      (executor as any).activePrPollers.set('task-1', setInterval(() => {}, 1000));

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

      // Clean up interval
      clearInterval((executor as any).activePrPollers.get('task-1'));
      (executor as any).activePrPollers.delete('task-1');
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
          approved: true,
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

      // Simulate active poller
      const interval = setInterval(() => {}, 1000);
      (executor as any).activePrPollers.set('task-1', interval);
      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      await executor.checkPrApprovalNow('task-1');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Merged' },
      });
      expect(orchestrator.approve).toHaveBeenCalledWith('task-1');
      expect(executeTasks).toHaveBeenCalledWith([downstream]);

      // Should stop polling after approval
      expect((executor as any).activePrPollers.has('task-1')).toBe(false);
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
          approved: false,
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

      // Simulate active poller
      const interval = setInterval(() => {}, 1000);
      (executor as any).activePrPollers.set('task-1', interval);

      await executor.checkPrApprovalNow('task-1');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Approved, awaiting merge' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();

      // Should continue polling since PR is still open
      expect((executor as any).activePrPollers.has('task-1')).toBe(true);

      // Clean up interval
      clearInterval((executor as any).activePrPollers.get('task-1'));
      (executor as any).activePrPollers.delete('task-1');
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
          approved: false,
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

      const interval = setInterval(() => {}, 1000);
      (executor as any).activePrPollers.set('task-1', interval);
      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      await executor.checkPrApprovalNow('task-1');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-1', {
        execution: { reviewStatus: 'Changes requested' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();
      expect(executeTasks).not.toHaveBeenCalled();
      // Polling should stop on rejection so the user can retry without an
      // orphaned interval firing in the background.
      expect((executor as any).activePrPollers.has('task-1')).toBe(false);
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
          approved: false,
          rejected: true,
          closed: true,
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

      const interval = setInterval(() => {}, 1000);
      (executor as any).activePrPollers.set('task-closed', interval);
      const executeTasks = vi.spyOn(executor, 'executeTasks').mockResolvedValue(undefined);

      await executor.checkPrApprovalNow('task-closed');

      expect(persistence.updateTask).toHaveBeenCalledWith('task-closed', {
        status: 'closed',
        execution: { reviewStatus: 'Closed' },
      });
      expect(orchestrator.approve).not.toHaveBeenCalled();
      expect(executeTasks).not.toHaveBeenCalled();
      expect((executor as any).activePrPollers.has('task-closed')).toBe(false);
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
          approved: true,
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

      // Simulate active poller
      (executor as any).activePrPollers.set('task-1', setInterval(() => {}, 1000));

      await executor.checkPrApprovalNow('task-1');

      expect(orchestrator.getTask).not.toHaveBeenCalled();
      expect(persistence.updateTask).not.toHaveBeenCalled();

      // Clean up
      clearInterval((executor as any).activePrPollers.get('task-1'));
      (executor as any).activePrPollers.delete('task-1');
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
            approved: false,
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

        (executor as any).activePrPollers.set('task-ws', setInterval(() => {}, 1000));

        await executor.checkPrApprovalNow('task-ws');

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#99',
          cwd: '/workspace/merge-worktree',
        });

        clearInterval((executor as any).activePrPollers.get('task-ws'));
        (executor as any).activePrPollers.delete('task-ws');
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
            approved: false,
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

        (executor as any).activePrPollers.set('task-no-ws', setInterval(() => {}, 1000));

        await executor.checkPrApprovalNow('task-no-ws');

        expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
          identifier: 'owner/repo#100',
          cwd: '/runner-base-cwd',
        });

        clearInterval((executor as any).activePrPollers.get('task-no-ws'));
        (executor as any).activePrPollers.delete('task-no-ws');
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
            approved: true,
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

        const interval = setInterval(() => {}, 1000);
        (executor as any).activePrPollers.set('task-approved', interval);
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
        expect((executor as any).activePrPollers.has('task-approved')).toBe(false);
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
        const interval = setInterval(() => {}, 1000);
        (executor as any).activePrPollers.set('merge-close', interval);

        await executor.closeWorkflowReview('wf-close');

        expect(mergeGateProvider.closeReview).toHaveBeenCalledWith({
          identifier: '205',
          cwd: '/workspace/close-gate',
        });
        expect((executor as any).activePrPollers.has('merge-close')).toBe(false);
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
            approved: false,
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
            approved: false,
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
            approved: true,
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
            approved: false,
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
            approved: false,
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

        const interval = setInterval(() => {}, 1000);
        (executor as any).activePrPollers.set('merge-rejected', interval);
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
        expect((executor as any).activePrPollers.has('merge-rejected')).toBe(false);
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
            approved: false,
            rejected: true,
            closed: true,
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

        const interval = setInterval(() => {}, 1000);
        (executor as any).activePrPollers.set('merge-closed', interval);
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
        expect((executor as any).activePrPollers.has('merge-closed')).toBe(false);
      });
    });

    describe('startPrPolling', () => {
      it('poll uses task workspacePath as cwd when present', async () => {
        vi.useFakeTimers();
        try {
          const orchestrator = {
            getTask: vi.fn((id: string) => ({
              id,
              status: 'review_ready',
              execution: {
                reviewId: 'owner/repo#300',
                workspacePath: '/workspace/poll-worktree',
              },
            })),
            approve: vi.fn(),
          };
          const persistence = { updateTask: vi.fn() };
          const mergeGateProvider = {
            checkApproval: vi.fn().mockResolvedValue({
              approved: false,
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

          (executor as any).startPrPolling('poll-task', 'owner/repo#300', 'wf-1');

          await vi.advanceTimersByTimeAsync(30_000);

          expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
            identifier: 'owner/repo#300',
            cwd: '/workspace/poll-worktree',
          });

          // Cleanup
          (executor as any).stopPrPolling('poll-task');
        } finally {
          vi.useRealTimers();
        }
      });

      it('poll falls back to runner cwd when workspacePath is undefined', async () => {
        vi.useFakeTimers();
        try {
          const orchestrator = {
            getTask: vi.fn((id: string) => ({
              id,
              status: 'review_ready',
              execution: { reviewId: 'owner/repo#301' },
            })),
            approve: vi.fn(),
          };
          const persistence = { updateTask: vi.fn() };
          const mergeGateProvider = {
            checkApproval: vi.fn().mockResolvedValue({
              approved: false,
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

          (executor as any).startPrPolling('poll-task-no-ws', 'owner/repo#301', 'wf-1');

          await vi.advanceTimersByTimeAsync(30_000);

          expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
            identifier: 'owner/repo#301',
            cwd: '/runner-base-cwd',
          });

          // Cleanup
          (executor as any).stopPrPolling('poll-task-no-ws');
        } finally {
          vi.useRealTimers();
        }
      });

      it('poll with workspacePath triggers orchestrator.approve on merged PR', async () => {
        vi.useFakeTimers();
        try {
          const downstream = makeTask({
            id: 'downstream-after-poll',
            status: 'running',
          });
          const orchestrator = {
            getTask: vi.fn((id: string) => ({
              id,
              status: 'review_ready',
              execution: {
                reviewId: 'owner/repo#302',
                workspacePath: '/workspace/poll-approved',
              },
            })),
            approve: vi.fn().mockResolvedValue([downstream]),
          };
          const persistence = { updateTask: vi.fn() };
          const mergeGateProvider = {
            checkApproval: vi.fn().mockResolvedValue({
              approved: true,
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

          (executor as any).startPrPolling('poll-approved', 'owner/repo#302', 'wf-1');

          await vi.advanceTimersByTimeAsync(30_000);

          expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
            identifier: 'owner/repo#302',
            cwd: '/workspace/poll-approved',
          });
          expect(persistence.updateTask).toHaveBeenCalledWith('poll-approved', {
            execution: { reviewStatus: 'Merged' },
          });
          expect(orchestrator.approve).toHaveBeenCalledWith('poll-approved');
          expect(executeTasks).toHaveBeenCalledWith([downstream]);
          expect((executor as any).activePrPollers.has('poll-approved')).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('poll with approved-but-open PR updates persistence without completing gate', async () => {
        vi.useFakeTimers();
        try {
          const orchestrator = {
            getTask: vi.fn((id: string) => ({
              id,
              status: 'review_ready',
              execution: {
                reviewId: 'owner/repo#303',
                workspacePath: '/workspace/poll-open-approved',
              },
            })),
            approve: vi.fn(),
          };
          const persistence = { updateTask: vi.fn() };
          const mergeGateProvider = {
            checkApproval: vi.fn().mockResolvedValue({
              approved: false,
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

          (executor as any).startPrPolling('poll-open-approved', 'owner/repo#303', 'wf-1');

          await vi.advanceTimersByTimeAsync(30_000);

          expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
            identifier: 'owner/repo#303',
            cwd: '/workspace/poll-open-approved',
          });
          expect(persistence.updateTask).toHaveBeenCalledWith('poll-open-approved', {
            execution: { reviewStatus: 'Approved, awaiting merge' },
          });
          expect(orchestrator.approve).not.toHaveBeenCalled();
          // Should continue polling
          expect((executor as any).activePrPollers.has('poll-open-approved')).toBe(true);

          // Cleanup
          (executor as any).stopPrPolling('poll-open-approved');
        } finally {
          vi.useRealTimers();
        }
      });

      it('poll with rejected PR stops polling without completing the gate', async () => {
        vi.useFakeTimers();
        try {
          const orchestrator = {
            getTask: vi.fn((id: string) => ({
              id,
              status: 'review_ready',
              execution: {
                reviewId: 'owner/repo#304',
                workspacePath: '/workspace/poll-rejected',
              },
            })),
            approve: vi.fn(),
          };
          const persistence = { updateTask: vi.fn() };
          const mergeGateProvider = {
            checkApproval: vi.fn().mockResolvedValue({
              approved: false,
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

          (executor as any).startPrPolling('poll-rejected', 'owner/repo#304', 'wf-1');

          await vi.advanceTimersByTimeAsync(30_000);

          expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
            identifier: 'owner/repo#304',
            cwd: '/workspace/poll-rejected',
          });
          expect(persistence.updateTask).toHaveBeenCalledWith('poll-rejected', {
            execution: { reviewStatus: 'Changes requested' },
          });
          expect(orchestrator.approve).not.toHaveBeenCalled();
          expect(executeTasks).not.toHaveBeenCalled();
          // Rejection should stop the poller (no further intervals scheduled).
          expect((executor as any).activePrPollers.has('poll-rejected')).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('poll with closed PR marks the gate closed and stops polling', async () => {
        vi.useFakeTimers();
        try {
          const orchestrator = {
            getTask: vi.fn((id: string) => ({
              id,
              status: 'review_ready',
              execution: {
                reviewId: 'owner/repo#305',
                workspacePath: '/workspace/poll-closed',
              },
            })),
            approve: vi.fn(),
          };
          const persistence = { updateTask: vi.fn() };
          const mergeGateProvider = {
            checkApproval: vi.fn().mockResolvedValue({
              approved: false,
              rejected: true,
              closed: true,
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

          (executor as any).startPrPolling('poll-closed', 'owner/repo#305', 'wf-1');

          await vi.advanceTimersByTimeAsync(30_000);

          expect(mergeGateProvider.checkApproval).toHaveBeenCalledWith({
            identifier: 'owner/repo#305',
            cwd: '/workspace/poll-closed',
          });
          expect(persistence.updateTask).toHaveBeenCalledWith('poll-closed', {
            status: 'closed',
            execution: { reviewStatus: 'Closed' },
          });
          expect(orchestrator.approve).not.toHaveBeenCalled();
          expect(executeTasks).not.toHaveBeenCalled();
          expect((executor as any).activePrPollers.has('poll-closed')).toBe(false);
        } finally {
          vi.useRealTimers();
        }
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

    it('appends visual proof markdown when runVisualProofCapture returns content', async () => {
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
      (executor as any).execPr = vi.fn().mockResolvedValue('https://example.com/pr');

      await executor.consolidateAndMerge(
        'pull_request', 'master', 'plan/test', 'wf-1', 'Test', ['t1'],
        'original body', true,
      );

      expect((executor as any).runVisualProofCapture).toHaveBeenCalledWith(
        'master', 'plan/test', expect.any(String), undefined,
      );
    });

    it('proceeds normally when runVisualProofCapture returns undefined', async () => {
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
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nAuthored consolidate body',
        sessionId: 'sess-pr-6',
        agentName: 'codex',
      });
      (executor as any).execPr = vi.fn().mockResolvedValue('https://example.com/pr');

      // Should not throw
      await executor.consolidateAndMerge(
        'pull_request', 'master', 'plan/test', 'wf-1', 'Test', ['t1'],
        'original body', true,
      );

      expect((executor as any).runVisualProofCapture).toHaveBeenCalled();
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

  describe('mergeExperimentBranches conflict handling', () => {
    it('conflict between 2 experiments aborts cleanly', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('exp-1', makeTask({ id: 'exp-1', status: 'completed', execution: { branch: 'experiment/exp-1' } }));
      tasks.set('exp-2', makeTask({ id: 'exp-2', status: 'completed', execution: { branch: 'experiment/exp-2' } }));
      tasks.set('recon', makeTask({ id: 'recon', config: { isReconciliation: true, parentTask: 'parent' } }));
      tasks.set('parent', makeTask({ id: 'parent', status: 'completed', execution: { branch: 'experiment/parent' } }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const calls: string[][] = [];
      let mergeCount = 0;
      (executor as any).execGitReadonly = async (args: string[], _cwd?: string) => {
        calls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT (content)');
        }
        if (args[0] === 'rev-parse') return 'abc123';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        calls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT (content)');
        }
        if (args[0] === 'rev-parse') return 'abc123';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await expect(executor.mergeExperimentBranches('recon', ['exp-1', 'exp-2'])).rejects.toThrow('CONFLICT');

      const abortCall = calls.find(c => c[0] === 'merge' && c[1] === '--abort');
      expect(abortCall).toBeDefined();
    });

    it('3 experiments: conflict at 2nd identifies which failed', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('exp-a', makeTask({ id: 'exp-a', status: 'completed', execution: { branch: 'experiment/exp-a' } }));
      tasks.set('exp-b', makeTask({ id: 'exp-b', status: 'completed', execution: { branch: 'experiment/exp-b' } }));
      tasks.set('exp-c', makeTask({ id: 'exp-c', status: 'completed', execution: { branch: 'experiment/exp-c' } }));
      tasks.set('recon', makeTask({ id: 'recon', config: { isReconciliation: true, parentTask: 'parent' } }));
      tasks.set('parent', makeTask({ id: 'parent', status: 'completed', execution: { branch: 'experiment/parent' } }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      let mergeCount = 0;
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT merging exp-b branch');
        }
        if (args[0] === 'rev-parse') return 'abc123';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT merging exp-b branch');
        }
        if (args[0] === 'rev-parse') return 'abc123';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      // The first merge (exp-a) succeeds, second (exp-b) fails, third (exp-c) is never attempted
      await expect(executor.mergeExperimentBranches('recon', ['exp-a', 'exp-b', 'exp-c'])).rejects.toThrow('CONFLICT');
      // exp-c's merge should not have been attempted
      expect(mergeCount).toBe(2);
    });
  });

  describe('resolveConflict', () => {
    it('throws for non-failed task', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('running-task', makeTask({
        id: 'running-task',
        status: 'running',
      }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflict('running-task'))
        .rejects.toThrow('no error information');
    });

    it('throws for task without merge conflict info', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('failed-task', makeTask({
        id: 'failed-task',
        status: 'failed',
        execution: { error: 'Some generic error' },
      }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflict('failed-task'))
        .rejects.toThrow('does not have merge conflict information');
    });

    it('throws for nonexistent task', async () => {
      const orchestrator = { getTask: () => undefined };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflict('nonexistent'))
        .rejects.toThrow('not found');
    });

    it('re-creates merge state and runs git operations', async () => {
      const workspacePath = createTempWorkspace();
      const conflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'invoker/dep-task',
        conflictFiles: ['shared.ts'],
      });

      const tasks = new Map<string, TaskState>();
      tasks.set('conflict-task', makeTask({
        id: 'conflict-task',
        status: 'failed',
        execution: {
          error: conflictError,
          branch: 'invoker/conflict-task',
          workspacePath,
        },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
      };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      const gitCwds: (string | undefined)[] = [];
      (executor as any).execGitReadonly = async (args: string[], cwd?: string) => {
        gitCalls.push([...args]);
        gitCwds.push(cwd);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push([...args]);
        gitCwds.push(_dir);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.resolveConflict('conflict-task');

      // Should have checked out the task branch
      const checkoutCall = gitCalls.find(c => c[0] === 'checkout' && c[1] === 'invoker/conflict-task');
      expect(checkoutCall).toBeDefined();

      // Should have attempted to merge the conflicting branch
      const mergeCall = gitCalls.find(c => c[0] === 'merge' && c.includes('invoker/dep-task'));
      expect(mergeCall).toBeDefined();

      // All git calls should use the task's workspacePath
      expect(gitCwds.every(c => c === workspacePath)).toBe(true);
    });
  });

  describe('fixWithAgent', () => {
    it('throws for nonexistent task', async () => {
      const orchestrator = { getTask: () => undefined };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      await expect(executor.fixWithAgent('nonexistent', 'output')).rejects.toThrow('not found');
    });

    it('throws for non-failed/non-running task', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('pending-task', makeTask({
        id: 'pending-task',
        status: 'pending',
        config: { command: 'npm test' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      await expect(executor.fixWithAgent('pending-task', 'output')).rejects.toThrow('not in a fixable state');
    });

    it('appends Claude output to task output', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('fix-task', makeTask({
        id: 'fix-task',
        status: 'failed',
        config: { command: 'npm test' },
        execution: { branch: 'invoker/fix-task', workspacePath: '/tmp' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const appendTaskOutput = vi.fn();
      const updateTask = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput, updateTask } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      (executor as any).spawnAgentFix = async () => ({ stdout: 'Fixed the import', sessionId: 'test-session-123' });
      await executor.fixWithAgent('fix-task', 'error output here');
      expect(appendTaskOutput).toHaveBeenCalledWith('fix-task', expect.stringContaining('Fixed the import'));
    });

    it('persists agentSessionId after fix', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('fix-task', makeTask({
        id: 'fix-task',
        status: 'failed',
        config: { command: 'npm test' },
        execution: { branch: 'invoker/fix-task', workspacePath: '/tmp' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const appendTaskOutput = vi.fn();
      const updateTask = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput, updateTask } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      (executor as any).spawnAgentFix = async () => ({ stdout: 'Fixed it', sessionId: 'sess-abc-123' });
      await executor.fixWithAgent('fix-task', 'error output');
      expect(updateTask).toHaveBeenCalledWith('fix-task', {
        execution: {
          agentSessionId: 'sess-abc-123',
          lastAgentSessionId: 'sess-abc-123',
          agentName: 'claude',
          lastAgentName: 'claude',
        },
      });
    });

    it('does not perform any git checkout', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('fix-task', makeTask({
        id: 'fix-task',
        status: 'failed',
        config: { command: 'npm test' },
        execution: { branch: 'invoker/fix-task', workspacePath: '/tmp' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const appendTaskOutput = vi.fn();
      const updateTask = vi.fn();
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput, updateTask } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp/repo',
      });
      const gitCalls: string[][] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        gitCalls.push([...args]);
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCalls.push([...args]);
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).spawnAgentFix = async () => ({ stdout: '', sessionId: 'sess-xyz' });
      await executor.fixWithAgent('fix-task', 'error output');
      expect(gitCalls.find(c => c[0] === 'checkout')).toBeUndefined();
    });
  });

  describe('executeMergeNode heartbeat lease', () => {
    it('renews selected attempt heartbeat while merge consolidation is still running', async () => {
      vi.useFakeTimers();
      try {
        const mergeTask = makeTask({
          id: '__merge__wf-1',
          status: 'running',
          dependencies: ['t1'],
          config: { isMergeNode: true, workflowId: 'wf-1' },
          execution: {
            selectedAttemptId: 'merge-attempt-1',
            generation: 7,
          },
        });
        const allTasks = [
          makeTask({
            id: 't1',
            status: 'completed',
            config: { workflowId: 'wf-1' },
            execution: { branch: 'experiment/t1' },
          }),
          mergeTask,
        ];
        const setTaskReviewReady = vi.fn();
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          setTaskReviewReady,
          startExecution: vi.fn(() => []),
        };
        const updateAttempt = vi.fn();
        const onHeartbeat = vi.fn();
        const onComplete = vi.fn();
        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: {
            loadWorkflow: () => ({
              id: 'wf-1',
              onFinish: 'merge',
              mergeMode: 'manual',
              baseBranch: 'master',
              featureBranch: 'plan/feature',
              name: 'Workflow',
            }),
            updateAttempt,
            updateTask: vi.fn(),
          } as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/tmp',
          callbacks: { onHeartbeat, onComplete },
        });

        (executor as any).buildMergeSummary = async () => 'summary';
        (executor as any).createMergeWorktree = async () => '/tmp/mock-merge-wt';
        (executor as any).removeMergeWorktree = async () => {};
        (executor as any).consolidateAndMerge = () => new Promise<string | undefined>((resolve) => {
          setTimeout(() => resolve(undefined), 60_000);
        });

        const pending = (executor as any).executeMergeNode(mergeTask);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(updateAttempt).toHaveBeenCalledWith(
          'merge-attempt-1',
          expect.objectContaining({
            lastHeartbeatAt: expect.any(Date),
            leaseExpiresAt: expect.any(Date),
          }),
        );
        expect(onHeartbeat).toHaveBeenCalled();
        expect(onComplete).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(30_000);
        await pending;

        expect(setTaskReviewReady).toHaveBeenCalledWith(
          '__merge__wf-1',
          expect.objectContaining({
            execution: expect.objectContaining({
              branch: 'plan/feature',
              workspacePath: '/tmp/mock-merge-wt',
            }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('renews selected attempt heartbeat before a long-running merge failure', async () => {
      vi.useFakeTimers();
      try {
        const mergeTask = makeTask({
          id: '__merge__wf-1',
          status: 'running',
          dependencies: ['t1'],
          config: { isMergeNode: true, workflowId: 'wf-1' },
          execution: {
            selectedAttemptId: 'merge-attempt-2',
            generation: 8,
          },
        });
        const allTasks = [
          makeTask({
            id: 't1',
            status: 'completed',
            config: { workflowId: 'wf-1' },
            execution: { branch: 'experiment/t1' },
          }),
          mergeTask,
        ];
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          handleWorkerResponse: vi.fn(() => []),
          startExecution: vi.fn(() => []),
        };
        const updateAttempt = vi.fn();
        const onHeartbeat = vi.fn();
        const onComplete = vi.fn();
        const executor = new TaskRunner({
          orchestrator: orchestrator as any,
          persistence: {
            loadWorkflow: () => ({
              id: 'wf-1',
              onFinish: 'merge',
              mergeMode: 'automatic',
              baseBranch: 'master',
              featureBranch: 'plan/feature',
              name: 'Workflow',
            }),
            updateAttempt,
            updateTask: vi.fn(),
          } as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          cwd: '/tmp',
          callbacks: { onHeartbeat, onComplete },
        });

        (executor as any).buildMergeSummary = async () => 'summary';
        (executor as any).createMergeWorktree = async () => '/tmp/mock-merge-wt';
        (executor as any).removeMergeWorktree = async () => {};
        (executor as any).consolidateAndMerge = () => new Promise<string | undefined>((_resolve, reject) => {
          setTimeout(() => reject(new Error('merge blew up')), 60_000);
        });

        const pending = (executor as any).executeMergeNode(mergeTask);
        await vi.advanceTimersByTimeAsync(30_000);

        expect(updateAttempt).toHaveBeenCalledWith(
          'merge-attempt-2',
          expect.objectContaining({
            lastHeartbeatAt: expect.any(Date),
            leaseExpiresAt: expect.any(Date),
          }),
        );
        expect(onHeartbeat).toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(30_000);
        await pending;

        expect(onComplete).toHaveBeenCalledWith(
          '__merge__wf-1',
          expect.objectContaining({
            status: 'failed',
            outputs: expect.objectContaining({
              error: expect.stringContaining('merge blew up'),
            }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('publishApprovedFix', () => {
    it('commits and pushes approved non-merge fixes in a local worktree', async () => {
      const bareDir = createTempWorkspace();
      const repoDir = createTempWorkspace();
      execSync('git init --bare', { cwd: bareDir });
      execSync(`git clone ${JSON.stringify(bareDir)} ${JSON.stringify(repoDir)}`);
      execSync('git config user.email "test@example.com"', { cwd: repoDir });
      execSync('git config user.name "Test Runner"', { cwd: repoDir });
      writeFileSync(join(repoDir, 'fix-target.txt'), 'BROKEN\n');
      writeFileSync(join(repoDir, 'package.json'), '{"name":"publish-approved-fix","private":true}\n');
      execSync('git add -A', { cwd: repoDir });
      execSync('git commit -m "seed"', { cwd: repoDir });
      execSync('git push origin HEAD', { cwd: repoDir });
      execSync('git checkout -b experiment/fix-gap', { cwd: repoDir });
      execSync('git push -u origin experiment/fix-gap', { cwd: repoDir });
      writeFileSync(join(repoDir, 'fix-target.txt'), 'FIXED\n');

      const task = makeTask({
        id: 'fix-task',
        description: 'Apply approved fix',
        config: { runnerKind: 'worktree', command: 'bash -lc false' },
        execution: {
          workspacePath: repoDir,
          branch: 'experiment/fix-gap',
          selectedAttemptId: 'attempt-1',
        },
      });
      const tasks = new Map<string, TaskState>([['fix-task', task]]);
      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const persistence = { updateTask, updateAttempt };
      const registryMap = new Map<string, any>();
      const executorRegistry = {
        getDefault: () => {
          throw new Error('unexpected getDefault');
        },
        get: (name: string) => registryMap.get(name) ?? null,
        register: (name: string, executor: any) => {
          registryMap.set(name, executor);
        },
        getAll: () => [...registryMap.values()],
      };
      const runner = new TaskRunner({
        orchestrator: { getTask: (id: string) => tasks.get(id) } as any,
        persistence: persistence as any,
        executorRegistry: executorRegistry as any,
        cwd: repoDir,
      });

      await runner.publishApprovedFix(task);

      const headSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
      const headValue = execSync('git show HEAD:fix-target.txt', { cwd: repoDir, encoding: 'utf8' }).trim();
      const remoteValue = execSync('git show origin/experiment/fix-gap:fix-target.txt', { cwd: repoDir, encoding: 'utf8' }).trim();
      expect(headValue).toBe('FIXED');
      expect(remoteValue).toBe('FIXED');
      expect(() => execSync('git diff --quiet', { cwd: repoDir })).not.toThrow();
      expect(updateTask).toHaveBeenCalledWith('fix-task', {
        execution: { commit: headSha },
      });
      expect(updateAttempt).toHaveBeenCalledWith('attempt-1', {
        branch: 'experiment/fix-gap',
        commit: headSha,
      });
    });

    it('routes SSH approved-fix publish through SshExecutor and persists the returned hash', async () => {
      const publishSpy = vi.spyOn(SshExecutor.prototype, 'publishApprovedFix').mockResolvedValue({
        commitHash: 'abc1234',
      });

      const task = makeTask({
        id: 'ssh-fix-task',
        description: 'Apply approved fix over ssh',
        config: {
          runnerKind: 'ssh',
          poolMemberId: 'remote-1',
          command: 'bash -lc false',
        },
        execution: {
          workspacePath: '/remote/worktree',
          branch: 'experiment/ssh-fix-gap',
          selectedAttemptId: 'attempt-ssh-1',
        },
      });
      const tasks = new Map<string, TaskState>([['ssh-fix-task', task]]);
      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const executorRegistry = {
        getDefault: () => ({ type: 'worktree' }),
        get: () => null,
        register: () => {},
        getAll: () => [],
      };
      const runner = new TaskRunner({
        orchestrator: { getTask: (id: string) => tasks.get(id) } as any,
        persistence: { updateTask, updateAttempt } as any,
        executorRegistry: executorRegistry as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => ({
          'remote-1': {
            host: 'example.com',
            user: 'invoker',
            sshKeyPath: '/tmp/test-key',
          },
        }),
      });

      await runner.publishApprovedFix(task);

      expect(publishSpy).toHaveBeenCalledWith(
        '/remote/worktree',
        expect.objectContaining({
          actionId: 'ssh-fix-task',
        }),
        'experiment/ssh-fix-gap',
      );
      expect(updateTask).toHaveBeenCalledWith('ssh-fix-task', {
        execution: { commit: 'abc1234' },
      });
      expect(updateAttempt).toHaveBeenCalledWith('attempt-ssh-1', {
        branch: 'experiment/ssh-fix-gap',
        commit: 'abc1234',
      });
    });

    it('commits approved merge-gate fixes locally and records a fixed integration anchor', async () => {
      const repoDir = createTempWorkspace();
      execSync('git init', { cwd: repoDir });
      execSync('git config user.email "test@example.com"', { cwd: repoDir });
      execSync('git config user.name "Test Runner"', { cwd: repoDir });
      writeFileSync(join(repoDir, 'gate.txt'), 'BASE\n');
      execSync('git add -A', { cwd: repoDir });
      execSync('git commit -m "seed"', { cwd: repoDir });
      writeFileSync(join(repoDir, 'gate.txt'), 'FIXED\n');

      const task = makeTask({
        id: '__merge__wf-1',
        description: 'Merge gate',
        config: { isMergeNode: true, workflowId: 'wf-1', runnerKind: 'worktree' },
        execution: {
          workspacePath: repoDir,
          selectedAttemptId: 'attempt-merge-1',
        },
      });
      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const runner = new TaskRunner({
        orchestrator: { getTask: () => task } as any,
        persistence: { updateTask, updateAttempt } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: repoDir,
      });

      await runner.commitApprovedFix(task);

      const headSha = execSync('git rev-parse HEAD', { cwd: repoDir, encoding: 'utf8' }).trim();
      const headValue = execSync('git show HEAD:gate.txt', { cwd: repoDir, encoding: 'utf8' }).trim();
      expect(headValue).toBe('FIXED');
      expect(updateTask).toHaveBeenCalledWith('__merge__wf-1', {
        execution: expect.objectContaining({
          fixedIntegrationSha: headSha,
          fixedIntegrationSource: 'approved_fix',
        }),
      });
      expect(updateAttempt).not.toHaveBeenCalled();
    });
  });

  describe('merge commit messages include task descriptions', () => {
    it('consolidateAndMerge includes task description in merge -m', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('task-a', makeTask({
        id: 'task-a',
        description: 'Add user authentication',
        status: 'completed',
        config: { workflowId: 'wf-msg' },
        execution: { branch: 'invoker/task-a' },
      }));
      tasks.set('__merge__wf-msg', makeTask({
        id: '__merge__wf-msg',
        status: 'running',
        dependencies: ['task-a'],
        config: { workflowId: 'wf-msg', isMergeNode: true },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-msg', name: 'Test' }), updateTask: vi.fn() } as any,
        executorRegistry: { getDefault: () => createAutoCompleteExecutor(), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergeMsgs: string[] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.executeTask(tasks.get('__merge__wf-msg')!);

      const taskMergeMsg = mergeMsgs.find(m => m.includes('invoker/task-a'));
      expect(taskMergeMsg).toBeDefined();
      expect(taskMergeMsg).toContain('Add user authentication');
    });

    it('mergeExperimentBranches includes experiment description in merge -m', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('exp-v1', makeTask({
        id: 'exp-v1',
        description: 'Use Redis for caching',
        status: 'completed',
        execution: { branch: 'experiment/exp-v1-abc', commit: 'c1' },
      }));
      tasks.set('exp-v2', makeTask({
        id: 'exp-v2',
        description: 'Use Memcached for caching',
        status: 'completed',
        execution: { branch: 'experiment/exp-v2-def', commit: 'c2' },
      }));
      tasks.set('recon', makeTask({
        id: 'recon',
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
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const mergeMsgs: string[] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged-hash';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged-hash';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.mergeExperimentBranches('recon', ['exp-v1', 'exp-v2']);

      expect(mergeMsgs).toHaveLength(2);
      expect(mergeMsgs[0]).toContain('experiment/exp-v1-abc');
      expect(mergeMsgs[0]).toContain('Use Redis for caching');
      expect(mergeMsgs[1]).toContain('experiment/exp-v2-def');
      expect(mergeMsgs[1]).toContain('Use Memcached for caching');
    });

    it('execPr reuses existing open PR instead of creating new one', async () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const ghCalls: string[][] = [];
      (executor as any).execGh = async (args: string[]) => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') {
          return JSON.stringify([{ url: 'https://github.com/owner/repo/pull/42', number: 42 }]);
        }
        if (args[0] === 'pr' && args[1] === 'edit') {
          return '';
        }
        return '';
      };

      const url = await (executor as any).execPr('main', 'feature/test', 'My Workflow');
      expect(url).toBe('https://github.com/owner/repo/pull/42');

      // Should have called gh pr list with correct args
      const listCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'list');
      expect(listCall).toBeDefined();
      expect(listCall).toContain('feature/test');
      expect(listCall).toContain('main');

      // Should have called gh pr edit to update title
      const editCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'edit');
      expect(editCall).toBeDefined();
      expect(editCall).toContain('42');
      expect(editCall).toContain('My Workflow');

      // Should NOT have called gh pr create
      const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
      expect(createCall).toBeUndefined();
    });

    it('execPr creates new PR when no open PR exists', async () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const ghCalls: string[][] = [];
      (executor as any).execGh = async (args: string[]) => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') {
          return '[]';
        }
        if (args[0] === 'pr' && args[1] === 'create') {
          return 'https://github.com/owner/repo/pull/99';
        }
        return '';
      };

      const url = await (executor as any).execPr('main', 'feature/new', 'New Workflow');
      expect(url).toBe('https://github.com/owner/repo/pull/99');

      // Should have called gh pr list
      const listCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'list');
      expect(listCall).toBeDefined();

      // Should have called gh pr create with correct args
      const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
      expect(createCall).toBeDefined();
      expect(createCall).toContain('main');
      expect(createCall).toContain('feature/new');
      expect(createCall).toContain('New Workflow');

      // Should NOT have called gh pr edit
      const editCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'edit');
      expect(editCall).toBeUndefined();
    });

    it('execPr passes normalized branch names to gh when base uses origin/ remote-tracking form', async () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const ghCalls: string[][] = [];
      (executor as any).execGh = async (args: string[]) => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') return '[]';
        if (args[0] === 'pr' && args[1] === 'create') return 'https://github.com/owner/repo/pull/200';
        return '';
      };

      await (executor as any).execPr(
        'origin/fix/my-work',
        'origin/plan/experiment',
        'Title',
        'Body',
      );

      const listCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'list');
      expect(listCall?.indexOf('--base')).toBeGreaterThan(-1);
      expect(listCall?.[listCall.indexOf('--base') + 1]).toBe('fix/my-work');
      expect(listCall?.[listCall.indexOf('--head') + 1]).toBe('plan/experiment');

      const createCall = ghCalls.find(c => c[0] === 'pr' && c[1] === 'create');
      expect(createCall?.indexOf('--base')).toBeGreaterThan(-1);
      expect(createCall?.[createCall.indexOf('--base') + 1]).toBe('fix/my-work');
      expect(createCall?.[createCall.indexOf('--head') + 1]).toBe('plan/experiment');
    });

    it('authorPrBodyWithSkill uses the configured workflow agent when available', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore',
          linuxTerminalTail: 'exec_bash',
          bundledSkillRoot: join(tempHome, '.codex', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.stdout.write("## Summary\\n\\nAuthored\\n\\n## Test Plan\\n\\n- [x] `pnpm test`\\n\\n## Revert Plan\\n\\n- Safe to revert? Yes\\n- Revert command: `git revert <sha>`\\n- Post-revert steps: None\\n- Data migration? No\\n")'],
            sessionId: 'sess-pr-body',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'codex' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => name === 'codex' ? codexAgent : undefined,
            getOrThrow: vi.fn().mockReturnValue(codexAgent),
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([codexAgent]),
          } as any,
          cwd: '/tmp',
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Test Workflow',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          workflowSummary: '## Summary\nSource summary',
          cwd: '/tmp',
        });

        expect(result.agentName).toBe('codex');
        expect(result.body).toContain('## Summary');
        expect(result.body).toContain('## Test Plan');
        expect(result.body).toContain('## Revert Plan');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill falls back to canonical body when authored body is invalid and no other agents available', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore',
          linuxTerminalTail: 'exec_bash',
          bundledSkillRoot: join(tempHome, '.codex', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.stdout.write("## Summary\\n\\nOnly summary")'],
            sessionId: 'sess-invalid-pr',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'codex' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => name === 'codex' ? codexAgent : undefined,
            getOrThrow: vi.fn().mockReturnValue(codexAgent),
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([codexAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        // With fallback, invalid AI body triggers canonical fallback instead of throwing
        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Test Workflow',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          workflowSummary: '## Summary\nSource summary',
          cwd: '/tmp',
        });

        expect(result.agentName).toBe('canonical');
        expect(result.sessionId).toBe('canonical-fallback');
        expect(result.body).toContain('## Summary');
        expect(result.body).toContain('## Test Plan');
        expect(result.body).toContain('## Revert Plan');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill falls back to second agent when first fails', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;

      // Only set up codex skill (not claude) — so claude fails skill resolution
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore',
          bundledSkillRoot: join(tempHome, '.claude', 'skills'), // no SKILL.md here
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.exit(1)'],
            sessionId: 'sess-claude-fail',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore',
          bundledSkillRoot: join(tempHome, '.codex', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.stdout.write("## Summary\\n\\nFallback body\\n\\n## Test Plan\\n\\n- [x] `pnpm test`\\n\\n## Revert Plan\\n\\n- Safe to revert? Yes\\n- Revert command: `git revert <sha>`\\n- Post-revert steps: None\\n- Data migration? No\\n")'],
            sessionId: 'sess-codex-ok',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };

        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => name === 'claude' ? claudeAgent : name === 'codex' ? codexAgent : undefined,
            getOrThrow: (name: string) => {
              if (name === 'claude') return claudeAgent;
              if (name === 'codex') return codexAgent;
              throw new Error(`Unknown agent: ${name}`);
            },
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([claudeAgent, codexAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Fallback Test',
          baseBranch: 'master',
          featureBranch: 'plan/fallback',
          workflowSummary: '## Summary\nFallback test',
          cwd: '/tmp',
        });

        expect(result.agentName).toBe('codex');
        expect(result.body).toContain('## Summary');
        expect(result.body).toContain('## Test Plan');
        expect(result.body).toContain('## Revert Plan');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill emits canonical body when all agents fail', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;

      // No skill directories at all
      try {
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore',
          bundledSkills: ['make-pr'],
          buildCommand: () => ({ cmd: 'node', args: ['-e', 'process.exit(1)'], sessionId: 'x' }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };

        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => name === 'claude' ? claudeAgent : undefined,
            getOrThrow: vi.fn().mockReturnValue(claudeAgent),
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([claudeAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Canonical Test',
          baseBranch: 'master',
          featureBranch: 'plan/canonical',
          workflowSummary: 'Canonical summary content.',
          structuredContext: {
            tasks: [
              { taskId: 't1', description: 'Run tests', status: 'completed', command: 'pnpm test' },
            ],
            visualProofMarkdown: '## Visual Proof\nscreenshots here',
          },
          cwd: '/tmp',
        });

        expect(result.agentName).toBe('canonical');
        expect(result.sessionId).toBe('canonical-fallback');
        expect(result.body).toContain('## Summary');
        expect(result.body).toContain('## Test Plan');
        expect(result.body).toContain('## Revert Plan');
        expect(result.body).toContain('pnpm test');
        expect(result.body).toContain('## Visual Proof');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill emits canonical body when no execution agent registry is configured', async () => {
      const logger = createMockLogger();
      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => null,
          getAllTasks: () => [],
        } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        logger,
      });

      const result = await (executor as any).authorPrBodyWithSkill({
        workflowId: 'wf-1',
        title: 'Canonical Test',
        baseBranch: 'master',
        featureBranch: 'plan/canonical',
        workflowSummary: 'Canonical summary content.',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Run tests', status: 'completed', command: 'pnpm test' },
          ],
        },
        cwd: '/tmp',
      });

      expect(result.agentName).toBe('canonical');
      expect(result.sessionId).toBe('canonical-fallback');
      expect(result.body).toContain('## Summary');
      expect(result.body).toContain('## Test Plan');
      expect(result.body).toContain('## Revert Plan');
      expect(result.body).toContain('pnpm test');
      expect(logger.warn).toHaveBeenCalledWith(
        '[pr-authoring] executionAgentRegistry missing, using canonical fallback PR body.',
      );
    });

    it('authorPrBodyWithSkill deduplicates preferred agent in fallback chain', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore',
          bundledSkillRoot: join(tempHome, '.claude', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.stdout.write("## Summary\\n\\nOK\\n\\n## Test Plan\\n\\n- [x] `pnpm test`\\n\\n## Revert Plan\\n\\n- Safe to revert? Yes\\n- Revert command: `git revert <sha>`\\n- Post-revert steps: None\\n- Data migration? No\\n")'],
            sessionId: 'sess-dedup',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };

        const getOrThrow = vi.fn().mockReturnValue(claudeAgent);

        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: () => claudeAgent,
            getOrThrow,
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([claudeAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Dedup Test',
          baseBranch: 'master',
          featureBranch: 'plan/dedup',
          workflowSummary: '## Summary\nDedup test',
          cwd: '/tmp',
        });

        // Claude should succeed on first try — no duplicate attempts
        expect(result.agentName).toBe('claude');
        expect(result.body).toContain('## Summary');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill tries preferred agent first, then falls back in registration order across 3 agents', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;

      // Only set up gemini skill — claude and codex will fail skill resolution
      mkdirSync(join(tempHome, '.gemini', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.gemini', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore' as const,
          bundledSkillRoot: join(tempHome, '.claude', 'skills'), // no SKILL.md
          bundledSkills: ['make-pr'],
          buildCommand: () => ({ cmd: 'node', args: ['-e', 'process.exit(1)'], sessionId: 'sess-claude' }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore' as const,
          bundledSkillRoot: join(tempHome, '.codex', 'skills'), // no SKILL.md
          bundledSkills: ['make-pr'],
          buildCommand: () => ({ cmd: 'node', args: ['-e', 'process.exit(1)'], sessionId: 'sess-codex' }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const geminiAgent = {
          name: 'gemini',
          stdinMode: 'ignore' as const,
          bundledSkillRoot: join(tempHome, '.gemini', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.stdout.write("## Summary\\n\\nGemini authored\\n\\n## Test Plan\\n\\n- [x] `pnpm test`\\n\\n## Revert Plan\\n\\n- Safe to revert? Yes\\n- Revert command: `git revert <sha>`\\n- Post-revert steps: None\\n- Data migration? No\\n")'],
            sessionId: 'sess-gemini',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };

        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => ({ claude: claudeAgent, codex: codexAgent, gemini: geminiAgent }[name]),
            getOrThrow: (name: string) => {
              const a = ({ claude: claudeAgent, codex: codexAgent, gemini: geminiAgent } as any)[name];
              if (!a) throw new Error(`Unknown agent: ${name}`);
              return a;
            },
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([claudeAgent, codexAgent, geminiAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Three-Agent Fallback',
          baseBranch: 'master',
          featureBranch: 'plan/three-agent',
          workflowSummary: 'Three-agent test',
          cwd: '/tmp',
        });

        // Preferred agent (claude) fails skill resolution, codex also fails,
        // gemini succeeds as the third agent in the chain
        expect(result.agentName).toBe('gemini');
        expect(result.body).toContain('## Summary');
        expect(result.body).toContain('Gemini authored');
        expect(result.body).toContain('## Test Plan');
        expect(result.body).toContain('## Revert Plan');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill emits canonical body when zero agents have make-pr capability', async () => {
      const logger = createMockLogger();
      const noCapsAgent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        // No bundledSkills — not PR-capable
        buildCommand: () => ({ cmd: 'node', args: ['-e', ''], sessionId: 'x' }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => null,
          getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
        } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: () => noCapsAgent,
          getOrThrow: vi.fn().mockReturnValue(noCapsAgent),
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([]), // no PR-capable agents
        } as any,
        cwd: '/tmp',
        logger,
      });

      const result = await (executor as any).authorPrBodyWithSkill({
        workflowId: 'wf-1',
        title: 'No Capable Agents',
        baseBranch: 'master',
        featureBranch: 'plan/no-capable',
        workflowSummary: 'Summary for no-capable test.',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Build check', status: 'completed', command: 'pnpm run build' },
          ],
        },
        cwd: '/tmp',
      });

      expect(result.agentName).toBe('canonical');
      expect(result.sessionId).toBe('canonical-fallback');
      expect(result.body).toContain('## Summary');
      expect(result.body).toContain('## Test Plan');
      expect(result.body).toContain('## Revert Plan');
      expect(result.body).toContain('pnpm run build');
    });

    it('external_review propagates authored PR body to createReview, not raw summary', async () => {
      const completedTask = makeTask({
        id: 't1',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/t1' },
        description: 'Implement feature',
      });

      const mergeTaskId = '__merge__wf-pub';
      const mergeTask = makeTask({
        id: mergeTaskId,
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-pub' },
        execution: { pendingFixError: undefined },
      });

      const allTasks = [mergeTask, completedTask];

      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/42',
          identifier: 'owner/repo#42',
        }),
      };

      const orchestrator = {
        getTask: (id: string) => allTasks.find((t) => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-pub',
          onFinish: 'none',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/ext-review',
          name: 'External Review Workflow',
        }),
        updateTask: vi.fn(),
        getWorkspacePath: () => '/tmp/gate-ws',
      };

      const gitCalls: { args: string[]; dir: string }[] = [];
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp/host',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], dir: string) => {
        gitCalls.push({ args: [...args], dir });
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'deadbeef';
        if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') throw new Error('not ancestor');
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).startPrPolling = vi.fn();
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('Raw summary text only');

      const authoredBody = '## Summary\n\nRich authored body with details\n\n## Test Plan\n\n- [x] `pnpm test`\n\n## Revert Plan\n\n- Safe to revert? Yes';
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: authoredBody,
        sessionId: 'sess-ext',
        agentName: 'claude',
      });
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/42');

      await executor.publishAfterFix(mergeTask);

      // createReview must receive the authored body, NOT the raw summary
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: authoredBody,
        }),
      );
      // Verify the raw summary was NOT passed as the body
      const createReviewCall = mergeGateProvider.createReview.mock.calls[0][0];
      expect(createReviewCall.body).not.toBe('Raw summary text only');
    });

    it('canonical body retains executed UI verification commands in Test Plan', () => {
      // Import buildCanonicalPrBody inline to test directly
      // buildCanonicalPrBody already imported at top of file

      const body = buildCanonicalPrBody({
        title: 'UI Feature',
        workflowSummary: 'Added dark mode toggle',
        structuredContext: {
          workflowDescription: 'Implement dark mode toggle with visual verification',
          tasks: [
            { taskId: 't1', description: 'Run unit tests', status: 'completed', command: 'pnpm test' },
            { taskId: 't2', description: 'Capture screenshot of toggle', status: 'completed', command: 'node scripts/capture-screenshot.js --component=toggle' },
            { taskId: 't3', description: 'Verify accessibility contrast', status: 'completed', command: 'pnpm run a11y:check' },
            { taskId: 't4', description: 'Build failed task', status: 'failed', command: 'pnpm run build:broken' },
            { taskId: 't5', description: 'Manual review', status: 'completed' }, // no command
          ],
        },
      });

      // All completed command tasks must appear in the Test Plan
      expect(body).toContain('`pnpm test` — Run unit tests');
      expect(body).toContain('`node scripts/capture-screenshot.js --component=toggle` — Capture screenshot of toggle');
      expect(body).toContain('`pnpm run a11y:check` — Verify accessibility contrast');

      // Failed tasks must NOT appear (only completed commands)
      expect(body).not.toContain('pnpm run build:broken');

      // Tasks without commands must NOT appear as checklist items
      expect(body).not.toContain('Manual review');

      // Must NOT contain "Manual verification required" since we have completed commands
      expect(body).not.toContain('Manual verification required');
    });

    it('canonical body preserves visual-proof markdown verbatim when capture content exists', () => {
      // buildCanonicalPrBody already imported at top of file

      const visualProof = [
        '## Visual Proof',
        '',
        '<details>',
        '<summary>State transitions</summary>',
        '',
        '| Before | After |',
        '|--------|-------|',
        '| ![before](./screenshots/before.png) | ![after](./screenshots/after.png) |',
        '',
        '</details>',
        '',
        '<details>',
        '<summary>Video walkthrough</summary>',
        '',
        '![walkthrough](./recordings/demo.mp4)',
        '',
        '</details>',
      ].join('\n');

      const body = buildCanonicalPrBody({
        title: 'Visual Change',
        workflowSummary: 'Updated button styles',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Run tests', status: 'completed', command: 'pnpm test' },
          ],
          visualProofMarkdown: visualProof,
        },
      });

      // Visual proof must be preserved verbatim
      expect(body).toContain('## Visual Proof');
      expect(body).toContain('<details>');
      expect(body).toContain('State transitions');
      expect(body).toContain('![before](./screenshots/before.png)');
      expect(body).toContain('![after](./screenshots/after.png)');
      expect(body).toContain('Video walkthrough');
      expect(body).toContain('![walkthrough](./recordings/demo.mp4)');
      expect(body).toContain('</details>');
    });

    it('canonical body drops visual-proof section when no capture content exists', () => {
      // buildCanonicalPrBody already imported at top of file

      const body = buildCanonicalPrBody({
        title: 'No Visual',
        workflowSummary: 'Backend-only change',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Run tests', status: 'completed', command: 'pnpm test' },
          ],
          // No visualProofMarkdown
        },
      });

      // Required sections present
      expect(body).toContain('## Summary');
      expect(body).toContain('## Test Plan');
      expect(body).toContain('## Revert Plan');

      // Visual proof must NOT appear
      expect(body).not.toContain('## Visual Proof');
      expect(body).not.toContain('Visual Proof');
    });

    it('canonical body shows manual verification when no completed command tasks exist', () => {
      // buildCanonicalPrBody already imported at top of file

      const body = buildCanonicalPrBody({
        title: 'No Commands',
        workflowSummary: 'Documentation update',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Write docs', status: 'completed' }, // no command
            { taskId: 't2', description: 'Build failed', status: 'failed', command: 'pnpm run build' },
          ],
        },
      });

      // No completed command tasks → must show manual verification
      expect(body).toContain('Manual verification required');
      // Failed command task must NOT appear
      expect(body).not.toContain('pnpm run build');
    });

    it('canonical body uses workflowDescription over workflowSummary in Summary section', () => {
      // buildCanonicalPrBody already imported at top of file

      const body = buildCanonicalPrBody({
        title: 'Description Priority',
        workflowSummary: 'This is the raw summary',
        structuredContext: {
          workflowDescription: 'This is the structured description from the plan YAML.',
          tasks: [],
        },
      });

      expect(body).toContain('This is the structured description from the plan YAML.');
      expect(body).not.toContain('This is the raw summary');
    });

    it('resolveConflict includes dep description in merge -m', async () => {
      const workspacePath = createTempWorkspace();
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-task', makeTask({
        id: 'dep-task',
        description: 'Add typing indicator support',
        status: 'completed',
        execution: { branch: 'invoker/dep-task' },
      }));

      const conflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'invoker/dep-task',
        conflictFiles: ['src/handler.ts'],
      });
      tasks.set('conflict-task', makeTask({
        id: 'conflict-task',
        description: 'Update handler',
        status: 'failed',
        execution: {
          error: conflictError,
          branch: 'invoker/conflict-task',
          workspacePath,
        },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergeMsgs: string[] = [];
      const gitCwds: (string | undefined)[] = [];
      (executor as any).execGitReadonly = async (args: string[]) => {
        gitCwds.push(undefined);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };
      (executor as any).execGitIn = async (args: string[], _dir: string) => {
        gitCwds.push(_dir);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};

      await executor.resolveConflict('conflict-task');

      expect(mergeMsgs).toHaveLength(1);
      expect(mergeMsgs[0]).toContain('invoker/dep-task');
      expect(mergeMsgs[0]).toContain('Add typing indicator support');

      // All git calls should use the task's workspacePath
      expect(gitCwds.every(c => c === workspacePath)).toBe(true);
    });

    it('resolveConflict throws when workspacePath is undefined', async () => {
      // Create a task without workspacePath
      const conflictError = JSON.stringify({
        type: 'merge_conflict',
        failedBranch: 'invoker/dep-task',
        conflictFiles: ['shared.ts'],
      });

      const tasks = new Map<string, TaskState>();
      tasks.set('conflict-task', makeTask({
        id: 'conflict-task',
        status: 'failed',
        execution: {
          error: conflictError,
          branch: 'invoker/conflict-task',
          // No workspacePath — should throw error
        },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
      };

      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflict('conflict-task'))
        .rejects.toThrow('no workspacePath');
    });
  });

  describe('remoteTargetsProvider', () => {
    it('reads remote targets lazily from the provider on each selectExecutor call', () => {
      const provider = vi.fn()
        .mockReturnValueOnce({
          'do-droplet': { host: '1.2.3.4', user: 'root', sshKeyPath: '/old/key' },
        })
        .mockReturnValueOnce({
          'do-droplet': { host: '1.2.3.4', user: 'root', sshKeyPath: '/new/key' },
        });

      const executor = new TaskRunner({
        orchestrator: { getTask: () => undefined } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: provider,
      });

      const task = makeTask({
        id: 'ssh-task',
        config: { runnerKind: 'ssh', poolMemberId: 'do-droplet' },
      });

      const executor1 = executor.selectExecutor(task);
      expect(executor1.type).toBe('ssh');
      expect((executor1 as any).sshKeyPath).toBe('/old/key');

      const executor2 = executor.selectExecutor(task);
      expect((executor2 as any).sshKeyPath).toBe('/new/key');

      expect(provider).toHaveBeenCalledTimes(2);
    });

    it('throws when provider returns no entry for the target ID', () => {
      const provider = vi.fn().mockReturnValue({});
      const executor = new TaskRunner({
        orchestrator: { getTask: () => undefined } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: provider,
      });

      const task = makeTask({
        id: 'ssh-task',
        config: { runnerKind: 'ssh', poolMemberId: 'missing-target' },
      });

      expect(() => executor.selectExecutor(task)).toThrow('no matching');
    });
  });

  describe('publishAfterFix', () => {
    function setupPublishAfterFix(opts: {
      mergeMode?: string;
      onFinish?: string;
      featureBranch?: string;
      gateWorkspacePath?: string | null;
      taskBranches?: TaskState[];
    }) {
      const mergeTaskId = '__merge__wf-pub';
      const workflowId = 'wf-pub';

      const mergeTask = makeTask({
        id: mergeTaskId,
        status: 'running',
        dependencies: (opts.taskBranches ?? []).map((t) => t.id),
        config: { isMergeNode: true, workflowId },
        execution: { pendingFixError: undefined },
      });

      const allTasks = [mergeTask, ...(opts.taskBranches ?? [])];

      const orchestrator = {
        getTask: (id: string) => allTasks.find((t) => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(),
        setTaskAwaitingApproval: vi.fn(),
      };

      const persistence = {
        loadWorkflow: () => ({
          id: workflowId,
          onFinish: opts.onFinish ?? 'none',
          mergeMode: opts.mergeMode ?? 'manual',
          baseBranch: 'master',
          featureBranch: opts.featureBranch,
          name: 'Test Workflow',
        }),
        updateTask: vi.fn(),
        getWorkspacePath: () => opts.gateWorkspacePath ?? null,
      };

      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({
          url: 'https://github.com/owner/repo/pull/99',
          identifier: 'owner/repo#99',
        }),
      };

      const gitCalls: { args: string[]; dir: string }[] = [];
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp/host',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async (args: string[], dir: string) => {
        gitCalls.push({ args: [...args], dir });
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123deadbeef';
        if (args[0] === 'rev-parse' && args[1] === '--verify') return '';
        // merge-base --is-ancestor exits non-zero when branch is NOT an ancestor of HEAD
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') throw new Error('not ancestor');
        return '';
      };
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).startPrPolling = vi.fn();
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('## Summary');
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nPublished body',
        sessionId: 'sess-pr-4',
        agentName: 'codex',
      });
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/100');

      return { executor, mergeTask, orchestrator, persistence, mergeGateProvider, gitCalls };
    }

    it('external_review mode: detaches HEAD, fetches, consolidates, creates PR', async () => {
      const completedTask = makeTask({
        id: 't1',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/t1' },
        description: 'Task 1',
      });

      const { executor, mergeTask, orchestrator, mergeGateProvider, gitCalls } = setupPublishAfterFix({
        mergeMode: 'external_review',
        featureBranch: 'plan/feature',
        gateWorkspacePath: '/tmp/gate-clone',
        taskBranches: [completedTask],
      });

      await executor.publishAfterFix(mergeTask);

      // Verify detach HEAD sequence in gate clone (regression test for checked-out branch bug)
      const gateGitCalls = gitCalls.filter((c) => c.dir === '/tmp/gate-clone');
      expect(gateGitCalls.length).toBeGreaterThanOrEqual(3);
      expect(gateGitCalls[0].args).toEqual(['rev-parse', 'HEAD']);
      expect(gateGitCalls[1].args).toEqual(['checkout', '--detach', 'abc123deadbeef']);
      expect(gateGitCalls[2].args).toEqual(['fetch', 'origin', '+refs/heads/*:refs/heads/*']);

      // Feature branch created from detached HEAD
      const checkoutBranch = gateGitCalls.find((c) => c.args[0] === 'checkout' && c.args[1] === '-b');
      expect(checkoutBranch).toBeDefined();
      expect(checkoutBranch!.args[2]).toBe('plan/feature');

      // Task branch merged
      const mergeCall = gateGitCalls.find((c) => c.args[0] === 'merge' && c.args.includes('invoker/t1'));
      expect(mergeCall).toBeDefined();

      // Feature branch pushed directly from gate clone to origin
      const gatePush = gateGitCalls.find((c) => c.args[0] === 'push' && c.args.includes('origin') && c.args.includes('plan/feature'));
      expect(gatePush).toBeDefined();

      // No git operations in host.cwd
      const hostCalls = gitCalls.filter((c) => c.dir === '/tmp/host');
      expect(hostCalls).toHaveLength(0);

      // Should route through shared PR-authoring helper
      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        cwd: '/tmp/gate-clone',
      }));

      // PR created via mergeGateProvider with authored body (not raw summary)
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          title: 'Test Workflow',
          cwd: '/tmp/gate-clone',
          body: '## Summary\n\nPublished body',
        }),
      );

      // Task set to awaiting_approval with PR metadata
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/99',
          reviewId: 'owner/repo#99',
          reviewStatus: 'Awaiting review',
        }),
      }));

      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('pull_request mode: calls execPr and persists reviewUrl', async () => {
      const completedTask = makeTask({
        id: 't1',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/t1' },
      });

      const { executor, mergeTask, orchestrator, persistence } = setupPublishAfterFix({
        mergeMode: 'manual',
        onFinish: 'pull_request',
        featureBranch: 'plan/feature',
        gateWorkspacePath: '/tmp/gate-clone',
        taskBranches: [completedTask],
      });

      await executor.publishAfterFix(mergeTask);

      expect((executor as any).authorPrBodyWithSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        workflowSummary: '## Summary',
        cwd: '/tmp/gate-clone',
      }));
      expect((executor as any).execPr).toHaveBeenCalledWith('master', 'plan/feature', 'Test Workflow', '## Summary\n\nPublished body', '/tmp/gate-clone');
      expect(persistence.updateTask).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        execution: expect.objectContaining({ reviewUrl: 'https://github.com/owner/repo/pull/100' }),
      }));
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalled();
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('no featureBranch: early exit with setTaskAwaitingApproval', async () => {
      const { executor, mergeTask, orchestrator, gitCalls } = setupPublishAfterFix({
        featureBranch: undefined,
        gateWorkspacePath: '/tmp/gate-clone',
      });

      await executor.publishAfterFix(mergeTask);

      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ workspacePath: '/tmp/gate-clone' }),
      }));

      // No git merge operations should have been attempted
      const mergeOps = gitCalls.filter((c) => c.args[0] === 'merge');
      expect(mergeOps).toHaveLength(0);
      const checkoutOps = gitCalls.filter((c) => c.args[0] === 'checkout');
      expect(checkoutOps).toHaveLength(0);
    });

    it('merge conflict: calls handleWorkerResponse with failed status', async () => {
      const completedTask = makeTask({
        id: 't1',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/t1' },
      });

      const { executor, mergeTask, orchestrator, gitCalls: _gitCalls } = setupPublishAfterFix({
        mergeMode: 'external_review',
        featureBranch: 'plan/feature',
        gateWorkspacePath: '/tmp/gate-clone',
        taskBranches: [completedTask],
      });

      // Override execGitIn to fail on merge
      (executor as any).execGitIn = async (args: string[], dir: string) => {
        _gitCalls.push({ args: [...args], dir });
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123deadbeef';
        if (args[0] === 'merge-base' && args[1] === '--is-ancestor') throw new Error('not ancestor');
        if (args[0] === 'merge') throw new Error('CONFLICT (content): Merge conflict in shared.ts');
        return '';
      };

      await executor.publishAfterFix(mergeTask);

      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        outputs: expect.objectContaining({
          error: JSON.stringify({
            type: 'merge_conflict',
            failedBranch: 'invoker/t1',
            conflictFiles: ['shared.ts'],
          }),
        }),
      }));
      expect(orchestrator.setTaskAwaitingApproval).not.toHaveBeenCalled();
    });

    it('detach-HEAD sequence: exact order regression test', async () => {
      const { executor, mergeTask, gitCalls } = setupPublishAfterFix({
        mergeMode: 'manual',
        featureBranch: 'plan/feature',
        gateWorkspacePath: '/tmp/gate-clone',
        taskBranches: [],
      });

      await executor.publishAfterFix(mergeTask);

      // Extract only the gate clone calls in order
      const gateCalls = gitCalls
        .filter((c) => c.dir === '/tmp/gate-clone')
        .map((c) => c.args);

      // The first three calls must be the detach-HEAD-then-fetch sequence
      expect(gateCalls[0]).toEqual(['rev-parse', 'HEAD']);
      expect(gateCalls[1]).toEqual(['checkout', '--detach', 'abc123deadbeef']);
      expect(gateCalls[2]).toEqual(['fetch', 'origin', '+refs/heads/*:refs/heads/*']);

      // Capture pre-pushed feature tip (if any), then create the feature branch
      expect(gateCalls[3]).toEqual(['rev-parse', '--verify', 'plan/feature']);
      expect(gateCalls[4]).toEqual(['checkout', '-b', 'plan/feature']);
    });

    it('without gateWorkspacePath: throws requiring a managed clone', async () => {
      const completedTask = makeTask({
        id: 't1',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/t1' },
      });

      const { executor, mergeTask, orchestrator } = setupPublishAfterFix({
        mergeMode: 'manual',
        featureBranch: 'plan/feature',
        gateWorkspacePath: null,
        taskBranches: [completedTask],
      });

      await executor.publishAfterFix(mergeTask);

      // publishAfterFixImpl now requires gateWorkspacePath; without it the error
      // is caught and forwarded as a failed WorkResponse
      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(expect.objectContaining({
        status: 'failed',
        outputs: expect.objectContaining({
          error: expect.stringContaining('requires a gate workspace'),
        }),
      }));
    });
  });

  describe('SSH Executor Caching', () => {
    it('caches SSH executors by poolMemberId and reuses them', () => {
      const remoteTargets = {
        'remote-a': {
          host: 'dev.example.com',
          user: 'deployer',
          sshKeyPath: '/home/user/.ssh/id_rsa',
          managedWorkspaces: true,
        },
        'remote-b': {
          host: 'staging.example.com',
          user: 'deployer',
          sshKeyPath: '/home/user/.ssh/id_rsa',
          managedWorkspaces: true,
        },
      };

      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => remoteTargets,
      });

      const task1 = makeTask({
        id: 'task-1',
        config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
      });
      const task2 = makeTask({
        id: 'task-2',
        config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
      });
      const task3 = makeTask({
        id: 'task-3',
        config: { runnerKind: 'ssh', poolMemberId: 'remote-b' },
      });

      const executor1 = executor.selectExecutor(task1);
      const executor2 = executor.selectExecutor(task2);
      const executor3 = executor.selectExecutor(task3);

      // task1 and task2 share the same poolMemberId → same executor instance
      expect(executor1).toBe(executor2);
      // task3 has a different poolMemberId → different executor instance
      expect(executor1).not.toBe(executor3);
      expect(executor2).not.toBe(executor3);
    });

    it('does not cache non-SSH executors', () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: {
          getDefault: () => ({ type: 'worktree' }),
          get: (type: string) => type === 'worktree' ? null : null,
          getAll: () => [],
          register: vi.fn(),
        } as any,
        cwd: '/tmp',
      });

      const task1 = makeTask({
        id: 'task-1',
        config: { runnerKind: 'worktree' },
      });
      const task2 = makeTask({
        id: 'task-2',
        config: { runnerKind: 'worktree' },
      });

      const executor1 = executor.selectExecutor(task1);
      const executor2 = executor.selectExecutor(task2);

      // Worktree executors are created fresh each time (lazy registration creates new instances)
      // Both should be worktree type but may be different instances
      expect(executor1.type).toBe('worktree');
      expect(executor2.type).toBe('worktree');
    });

    it('clearSshExecutorCache removes all cached SSH executors', async () => {
      const remoteTargets = {
        'remote-a': {
          host: 'dev.example.com',
          user: 'deployer',
          sshKeyPath: '/home/user/.ssh/id_rsa',
          managedWorkspaces: true,
        },
      };

      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => remoteTargets,
      });

      const task1 = makeTask({
        id: 'task-1',
        config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
      });
      const task2 = makeTask({
        id: 'task-2',
        config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
      });

      const executor1 = executor.selectExecutor(task1);
      await executor.clearSshExecutorCache();
      const executor2 = executor.selectExecutor(task2);

      // After clearing cache, a new executor instance should be created
      expect(executor1).not.toBe(executor2);
    });

    it('throws when SSH task has no poolMemberId', () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => ({}),
      });

      const task = makeTask({
        id: 'task-missing-target',
        config: { runnerKind: 'ssh' },
      });

      expect(() => executor.selectExecutor(task)).toThrow('has runnerKind=ssh but no poolMemberId');
    });

    it('throws when poolMemberId does not exist in config', () => {
      const remoteTargets = {
        'remote-a': {
          host: 'dev.example.com',
          user: 'deployer',
          sshKeyPath: '/home/user/.ssh/id_rsa',
        },
      };

      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => remoteTargets,
      });

      const task = makeTask({
        id: 'task-unknown-target',
        config: { runnerKind: 'ssh', poolMemberId: 'remote-unknown' },
      });

      expect(() => executor.selectExecutor(task)).toThrow('no matching entry exists in remoteTargets config');
    });
  });

  describe('metadata persistence hardening', () => {
    function createCompletingExecutor(type: string, handle: Record<string, unknown>) {
      return {
        type,
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          ...handle,
        })),
        onComplete: vi.fn((_handle, cb) => {
          setTimeout(() => cb({
            requestId: 'req-1',
            actionId: (_handle as any).taskId,
            status: 'completed',
            outputs: { exitCode: 0 },
          }), 0);
        }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
    }

    it('logs pool-routed SSH executor selection with remote target display fields', async () => {
      const sshExecutor = createCompletingExecutor('ssh', {
        workspacePath: '/remote/worktrees/task-1',
        branch: 'experiment/task-1',
      });
      const logEvent = vi.fn();
      const updateTask = vi.fn();
      const task = makeTask({
        id: 'task-1',
        status: 'pending',
        config: { command: 'pnpm test', runnerKind: 'ssh', poolId: 'ci-pool' },
        execution: { selectedAttemptId: 'attempt-1' },
      });

      const runner = new TaskRunner({
        orchestrator: { getTask: () => task, getAllTasks: () => [task], handleWorkerResponse: vi.fn() } as any,
        persistence: { updateTask, updateAttempt: vi.fn(), logEvent } as any,
        executorRegistry: {
          getDefault: () => sshExecutor,
          get: (type: string) => type === 'ssh' ? sshExecutor : null,
          getAll: () => [sshExecutor],
        } as any,
        cwd: '/tmp',
        executionPoolsProvider: () => ({
          'ci-pool': {
            selectionStrategy: 'leastLoaded',
            members: [{ type: 'ssh', id: 'remote-a' }],
          },
        }),
        remoteTargetsProvider: () => ({
          'remote-a': {
            host: 'ci.example.com',
            user: 'runner',
            sshKeyPath: '/secret/key',
            port: 2222,
          },
        }),
      });

      await runner.executeTask(task);

      expect(logEvent).toHaveBeenCalledWith('task-1', 'task.executor.selected', {
        runnerKind: 'ssh',
        reason: {
          type: 'poolId',
          poolId: 'ci-pool',
          selectionStrategy: 'leastLoaded',
          poolMemberId: 'remote-a',
        },
        attemptId: 'attempt-1',
        workspacePath: '/remote/worktrees/task-1',
        branch: 'experiment/task-1',
        poolMemberId: 'remote-a',
        remoteHost: 'ci.example.com',
        remoteUser: 'runner',
        port: 2222,
      });
      const selectedPayload = logEvent.mock.calls.find((call) => call[1] === 'task.executor.selected')?.[2];
      expect(JSON.stringify(selectedPayload)).not.toContain('sshKeyPath');
      expect(JSON.stringify(selectedPayload)).not.toContain('/secret/key');
      expect(updateTask).toHaveBeenCalledWith('task-1', {
        config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
        execution: expect.objectContaining({
          workspacePath: '/remote/worktrees/task-1',
          branch: 'experiment/task-1',
        }),
      });
    });

    it('logs explicit SSH executor selection as explicitPoolMemberId', async () => {
      const sshExecutor = createCompletingExecutor('ssh', {
        workspacePath: '/remote/worktrees/task-explicit',
        branch: 'experiment/task-explicit',
      });
      const logEvent = vi.fn();
      const task = makeTask({
        id: 'task-explicit',
        status: 'pending',
        config: { command: 'echo hi', runnerKind: 'ssh', poolMemberId: 'remote-b' },
      });

      const runner = new TaskRunner({
        orchestrator: { getTask: () => task, getAllTasks: () => [task], handleWorkerResponse: vi.fn() } as any,
        persistence: { updateTask: vi.fn(), updateAttempt: vi.fn(), logEvent } as any,
        executorRegistry: {
          getDefault: () => sshExecutor,
          get: (type: string) => type === 'ssh' ? sshExecutor : null,
          getAll: () => [sshExecutor],
        } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => ({
          'remote-b': { host: 'dev.example.com', user: 'dev', sshKeyPath: '/secret/dev-key' },
        }),
      });

      await runner.executeTask(task);

      expect(logEvent).toHaveBeenCalledWith('task-explicit', 'task.executor.selected', expect.objectContaining({
        runnerKind: 'ssh',
        reason: { type: 'explicitPoolMemberId' },
        poolMemberId: 'remote-b',
        remoteHost: 'dev.example.com',
        remoteUser: 'dev',
      }));
    });

    it('logs configured worktree executor selection reason', async () => {
      const worktreeExecutor = createCompletingExecutor('worktree', {
        workspacePath: '/tmp/worktree/task-local',
        branch: 'experiment/task-local',
      });
      const logEvent = vi.fn();
      const task = makeTask({
        id: 'task-local',
        status: 'pending',
        config: { command: 'echo local', runnerKind: 'worktree' },
      });

      const runner = new TaskRunner({
        orchestrator: { getTask: () => task, getAllTasks: () => [task], handleWorkerResponse: vi.fn() } as any,
        persistence: { updateTask: vi.fn(), updateAttempt: vi.fn(), logEvent } as any,
        executorRegistry: {
          getDefault: () => worktreeExecutor,
          get: (type: string) => type === 'worktree' ? worktreeExecutor : null,
          getAll: () => [worktreeExecutor],
        } as any,
        cwd: '/tmp',
      });

      await runner.executeTask(task);

      expect(logEvent).toHaveBeenCalledWith('task-local', 'task.executor.selected', expect.objectContaining({
        runnerKind: 'worktree',
        reason: { type: 'configuredWorktree' },
        workspacePath: '/tmp/worktree/task-local',
        branch: 'experiment/task-local',
      }));
    });

    it('logs SSH pool fallback to worktree when no pool member or remote target exists', async () => {
      const worktreeExecutor = createCompletingExecutor('worktree', {
        workspacePath: '/tmp/worktree/task-fallback',
        branch: 'experiment/task-fallback',
      });
      const logEvent = vi.fn();
      const task = makeTask({
        id: 'task-fallback',
        status: 'pending',
        config: { command: 'echo fallback', runnerKind: 'ssh', poolId: 'missing-pool' },
      });

      const runner = new TaskRunner({
        orchestrator: { getTask: () => task, getAllTasks: () => [task], handleWorkerResponse: vi.fn() } as any,
        persistence: { updateTask: vi.fn(), updateAttempt: vi.fn(), logEvent } as any,
        executorRegistry: {
          getDefault: () => worktreeExecutor,
          get: (type: string) => type === 'worktree' ? worktreeExecutor : null,
          getAll: () => [worktreeExecutor],
        } as any,
        cwd: '/tmp',
        executionPoolsProvider: () => ({}),
        remoteTargetsProvider: () => ({}),
      });

      await runner.executeTask(task);

      expect(logEvent).toHaveBeenCalledWith('task-fallback', 'task.executor.selected', expect.objectContaining({
        runnerKind: 'worktree',
        reason: { type: 'sshPoolFallbackToWorktree', poolId: 'missing-pool' },
        workspacePath: '/tmp/worktree/task-fallback',
        branch: 'experiment/task-fallback',
      }));
    });

    it('fails fast when executor returns handle without workspacePath', async () => {
      const badExecutor = {
        type: 'bad-executor',
        start: vi.fn().mockResolvedValue({
          executionId: 'exec-1',
          taskId: 'task-1',
          // Missing workspacePath!
          branch: 'experiment/task-1-abc123',
        }),
        onComplete: vi.fn(),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };

      const task = makeTask({
        id: 'task-1',
        status: 'pending',
        config: { command: 'echo test' },
      });

      const updateSpy = vi.fn();
      const handleResponseSpy = vi.fn();

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => task,
          getAllTasks: () => [task],
          handleWorkerResponse: handleResponseSpy,
        } as any,
        persistence: {
          updateTask: updateSpy,
        } as any,
        executorRegistry: {
          getDefault: () => badExecutor,
          get: () => badExecutor,
          getAll: () => [badExecutor],
        } as any,
        cwd: '/tmp',
      });

      await executor.executeTask(task);

      // Check that we failed with correct error
      expect(handleResponseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('did not provide workspacePath'),
          }),
        }),
      );
    });

    it('persists workspacePath and branch from managed SSH executor start', async () => {
      const managedSshExecutor = {
        type: 'ssh',
        start: vi.fn().mockResolvedValue({
          executionId: 'exec-ssh-1',
          taskId: 'ssh-task-1',
          workspacePath: '~/.invoker/worktrees/abc123/experiment-ssh-task-1-def456',
          branch: 'experiment/ssh-task-1-def456',
          agentSessionId: 'session-123',
        }),
        onComplete: vi.fn().mockImplementation((_handle, cb) => {
          // Auto-complete
          setTimeout(() => cb({
            requestId: 'req-1',
            actionId: 'ssh-task-1',
            status: 'completed',
            outputs: { exitCode: 0 },
          }), 0);
        }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };

      const task = makeTask({
        id: 'ssh-task-1',
        status: 'pending',
        config: {
          command: 'echo test',
          runnerKind: 'ssh',
          poolMemberId: 'remote-1',
        },
      });

      const updateSpy = vi.fn();

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => task,
          getAllTasks: () => [task],
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: {
          updateTask: updateSpy,
        } as any,
        executorRegistry: {
          getDefault: () => managedSshExecutor,
          get: () => managedSshExecutor,
          getAll: () => [managedSshExecutor],
        } as any,
        cwd: '/tmp',
      });

      await executor.executeTask(task);

      // Check that metadata was persisted immediately after start
      expect(updateSpy).toHaveBeenCalledWith('ssh-task-1', {
        config: { runnerKind: 'ssh', poolMemberId: 'remote-1' },
        execution: {
          workspacePath: '~/.invoker/worktrees/abc123/experiment-ssh-task-1-def456',
          branch: 'experiment/ssh-task-1-def456',
          agentSessionId: 'session-123',
          lastAgentSessionId: 'session-123',
          lastAgentName: undefined,
          containerId: undefined,
        },
      });
    });

    it('persists metadata on error path when executor.start throws', async () => {
      const failingExecutor = {
        type: 'ssh',
        start: vi.fn().mockRejectedValue(Object.assign(
          new Error('SSH connection failed'),
          {
            workspacePath: '~/.invoker/worktrees/abc123/task-failed-xyz',
            branch: 'experiment/task-failed-xyz',
            agentSessionId: 'session-fail-1',
          }
        )),
        onComplete: vi.fn(),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };

      const task = makeTask({
        id: 'task-failed',
        status: 'pending',
        config: { command: 'echo test', runnerKind: 'ssh' },
      });

      const updateSpy = vi.fn();
      const handleResponseSpy = vi.fn();

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => task,
          getAllTasks: () => [task],
          handleWorkerResponse: handleResponseSpy,
        } as any,
        persistence: {
          updateTask: updateSpy,
        } as any,
        executorRegistry: {
          getDefault: () => failingExecutor,
          get: () => failingExecutor,
          getAll: () => [failingExecutor],
        } as any,
        cwd: '/tmp',
      });

      await executor.executeTask(task);

      // Check that metadata was persisted despite error
      expect(updateSpy).toHaveBeenCalledWith('task-failed', {
        config: { runnerKind: 'ssh' },
        execution: {
          workspacePath: '~/.invoker/worktrees/abc123/task-failed-xyz',
          branch: 'experiment/task-failed-xyz',
          agentSessionId: 'session-fail-1',
          lastAgentSessionId: 'session-fail-1',
        },
      });

      // Check that the task ultimately failed
      expect(handleResponseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          outputs: expect.objectContaining({
            error: expect.stringContaining('Executor startup failed'),
          }),
        }),
      );
    });

    it('persists pool-routed SSH target on error path when executor.start throws', async () => {
      const failingExecutor = {
        type: 'ssh',
        start: vi.fn().mockRejectedValue(Object.assign(new Error('SSH startup failed'), {
          workspacePath: '~/.invoker/worktrees/ci/task-failed',
          branch: 'experiment/task-failed',
        })),
        onComplete: vi.fn(),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };
      const task = makeTask({
        id: 'task-failed-pool',
        status: 'pending',
        config: { command: 'echo test', runnerKind: 'ssh', poolId: 'ci-pool' },
      });
      const updateTask = vi.fn();

      const runner = new TaskRunner({
        orchestrator: {
          getTask: () => task,
          getAllTasks: () => [task],
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: { updateTask } as any,
        executorRegistry: {
          getDefault: () => failingExecutor,
          get: () => failingExecutor,
          getAll: () => [failingExecutor],
        } as any,
        cwd: '/tmp',
        executionPoolsProvider: () => ({
          'ci-pool': {
            selectionStrategy: 'leastLoaded',
            members: [{ type: 'ssh', id: 'remote-a' }],
          },
        }),
        remoteTargetsProvider: () => ({
          'remote-a': { host: 'ci.example.com', user: 'runner', sshKeyPath: '/secret/key' },
        }),
      });

      await runner.executeTask(task);

      expect(updateTask).toHaveBeenCalledWith('task-failed-pool', {
        config: { runnerKind: 'ssh', poolMemberId: 'remote-a' },
        execution: {
          workspacePath: '~/.invoker/worktrees/ci/task-failed',
          branch: 'experiment/task-failed',
        },
      });
    });

    it('persists attempt.branch via onBranchResolved when executor crashes mid-acquire', async () => {
      // Executor that resolves the branch (calls onBranchResolved) and then
      // crashes before attaching `branch` metadata to the thrown error —
      // simulating a `git worktree add` failure between branch computation
      // and worktree creation.
      let observedBranch: string | undefined;
      const failingExecutor = {
        type: 'worktree',
        start: vi.fn().mockImplementation(async (req: any) => {
          const branch = 'experiment/task-mid-acquire/g0.t0.aabc12345-deadbeef';
          observedBranch = branch;
          req.onBranchResolved?.(branch);
          // Simulate `git worktree add` failure — note: error has NO branch attached.
          throw new Error("fatal: 'experiment/...' is already used by worktree");
        }),
        onComplete: vi.fn(),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };

      const task = makeTask({
        id: 'task-mid-acquire',
        status: 'pending',
        config: { command: 'echo test', runnerKind: 'worktree' },
      });

      const updateAttemptSpy = vi.fn();
      const updateTaskSpy = vi.fn();

      const runner = new TaskRunner({
        orchestrator: {
          getTask: () => task,
          getAllTasks: () => [task],
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: {
          updateTask: updateTaskSpy,
          updateAttempt: updateAttemptSpy,
        } as any,
        executorRegistry: {
          getDefault: () => failingExecutor,
          get: () => failingExecutor,
          getAll: () => [failingExecutor],
        } as any,
        cwd: '/tmp',
      });

      await runner.executeTask(task);

      expect(observedBranch).toBeDefined();
      // The early callback must have persisted branch on the attempt row,
      // even though the error did not carry branch metadata.
      expect(updateAttemptSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ branch: observedBranch }),
      );
      // And on the task execution mirror as well.
      expect(updateTaskSpy).toHaveBeenCalledWith(
        'task-mid-acquire',
        expect.objectContaining({ execution: expect.objectContaining({ branch: observedBranch }) }),
      );
    });

    it('allows BYO mode executor with workspacePath but no branch', async () => {
      const byoExecutor = {
        type: 'ssh',
        start: vi.fn().mockResolvedValue({
          executionId: 'exec-byo-1',
          taskId: 'byo-task-1',
          workspacePath: '/remote/user-provided/workspace',
          // BYO mode: no branch field
        }),
        onComplete: vi.fn().mockImplementation((_handle, cb) => {
          setTimeout(() => cb({
            requestId: 'req-byo-1',
            actionId: 'byo-task-1',
            status: 'completed',
            outputs: { exitCode: 0 },
          }), 0);
        }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
        destroyAll: vi.fn(),
      };

      const task = makeTask({
        id: 'byo-task-1',
        status: 'pending',
        config: { command: 'pwd', runnerKind: 'ssh' },
      });

      const updateSpy = vi.fn();

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => task,
          getAllTasks: () => [task],
          handleWorkerResponse: vi.fn(),
        } as any,
        persistence: {
          updateTask: updateSpy,
        } as any,
        executorRegistry: {
          getDefault: () => byoExecutor,
          get: () => byoExecutor,
          getAll: () => [byoExecutor],
        } as any,
        cwd: '/tmp',
      });

      await executor.executeTask(task);

      // Check that metadata was persisted with workspacePath and branch=undefined
      expect(updateSpy).toHaveBeenCalledWith('byo-task-1', {
        config: { runnerKind: 'ssh' },
        execution: {
          workspacePath: '/remote/user-provided/workspace',
          branch: undefined,
          agentSessionId: undefined,
          lastAgentSessionId: undefined,
          lastAgentName: undefined,
          containerId: undefined,
        },
      });
    });
  });

  describe('entry GC supervisor', () => {
    it('entry leases expire when heartbeats stop', async () => {
      vi.useFakeTimers();
      try {
        const heartbeats: string[] = [];
        const heartbeatCallbacks: Array<(taskId: string) => void> = [];
        let completeCallback: ((response: WorkResponse) => void) | undefined;
        const handle = { executionId: 'exec-gc-1', taskId: 'gc-task-1', workspacePath: '/tmp/mock-worktree' };

        const gcExecutor = {
          type: 'worktree',
          start: vi.fn(async () => {
            return handle;
          }),
          onOutput: () => () => {},
          onComplete: vi.fn((_h: unknown, cb: (response: WorkResponse) => void) => {
            completeCallback = cb;
            return () => {};
          }),
          onHeartbeat: vi.fn((_h: unknown, cb: (taskId: string) => void) => {
            heartbeatCallbacks.push(cb);
            return () => {};
          }),
        };

        const updateTask = vi.fn();
        const executor = new TaskRunner({
          orchestrator: { getTask: () => undefined, handleWorkerResponse: vi.fn() } as any,
          persistence: { updateTask } as any,
          executorRegistry: {
            getDefault: () => gcExecutor,
            get: () => gcExecutor,
            getAll: () => [gcExecutor],
          } as any,
          cwd: '/tmp',
          callbacks: {
            onHeartbeat: (taskId: string) => { heartbeats.push(taskId); },
          },
        });

        const task = makeTask({ id: 'gc-task-1', status: 'running', config: { command: 'echo test' } });
        const done = executor.executeTask(task);

        // Wait for task to start
        await vi.runAllTimersAsync();
        expect(gcExecutor.onHeartbeat).toHaveBeenCalled();

        // Simulate heartbeats firing from BaseExecutor
        heartbeatCallbacks.forEach(cb => cb('gc-task-1'));
        expect(heartbeats.length).toBeGreaterThan(0);

        // Record initial heartbeat count
        const initialHeartbeatCount = heartbeats.length;

        // Now simulate heartbeats stopping (no more callbacks fire)
        // After some time without heartbeats, lease should be considered expired
        // The persistence layer should NOT receive heartbeat updates

        // Fast forward without triggering heartbeats
        await vi.advanceTimersByTimeAsync(60_000);

        // Verify no additional heartbeats fired
        expect(heartbeats).toHaveLength(initialHeartbeatCount);

        // In a real system, the stale detector (in main.ts) would now see
        // lastHeartbeatAt is > 5 minutes old and reclaim the entry.
        // This test verifies that when heartbeat callbacks stop firing,
        // the TaskRunner doesn't update lastHeartbeatAt in persistence.

        // Fire completion so executeTask resolves and the test doesn't hang.
        completeCallback?.({
          requestId: 'req-gc-1',
          actionId: 'gc-task-1',
          status: 'completed',
          outputs: { exitCode: 0 },
        });
        await vi.runAllTimersAsync();
        await done;
      } finally {
        vi.useRealTimers();
      }
    });

    it('active heartbeats refresh lease and prevent false reclamation', async () => {
      vi.useFakeTimers();
      try {
        const heartbeats: Array<{ taskId: string; timestamp: number }> = [];
        const heartbeatCallbacks: Array<(taskId: string) => void> = [];
        let completeCallback: ((response: WorkResponse) => void) | undefined;
        const handle = { executionId: 'exec-gc-2', taskId: 'gc-task-2', workspacePath: '/tmp/mock-worktree' };

        const gcExecutor = {
          type: 'worktree',
          start: vi.fn(async () => {
            return handle;
          }),
          onOutput: () => () => {},
          onComplete: vi.fn((_h: unknown, cb: (response: WorkResponse) => void) => {
            completeCallback = cb;
            return () => {};
          }),
          onHeartbeat: vi.fn((_h: unknown, cb: (taskId: string) => void) => {
            heartbeatCallbacks.push(cb);
            return () => {};
          }),
        };

        const updateTask = vi.fn();
        const executor = new TaskRunner({
          orchestrator: { getTask: () => undefined, handleWorkerResponse: vi.fn() } as any,
          persistence: { updateTask } as any,
          executorRegistry: {
            getDefault: () => gcExecutor,
            get: () => gcExecutor,
            getAll: () => [gcExecutor],
          } as any,
          cwd: '/tmp',
          callbacks: {
            onHeartbeat: (taskId: string) => {
              heartbeats.push({ taskId, timestamp: Date.now() });
            },
          },
        });

        const task = makeTask({ id: 'gc-task-2', status: 'running', config: { command: 'sleep 300' } });
        const done = executor.executeTask(task);

        // Wait for task to start
        await vi.runAllTimersAsync();
        expect(gcExecutor.onHeartbeat).toHaveBeenCalled();

        // Simulate continuous heartbeats over a long period
        for (let i = 0; i < 10; i++) {
          await vi.advanceTimersByTimeAsync(30_000);
          heartbeatCallbacks.forEach(cb => cb('gc-task-2'));
        }

        // Verify heartbeats were consistently fired
        expect(heartbeats.length).toBeGreaterThanOrEqual(10);

        // Verify all heartbeats are for the correct task
        expect(heartbeats.every(hb => hb.taskId === 'gc-task-2')).toBe(true);

        // Verify timestamps show progression (active refresh)
        for (let i = 1; i < heartbeats.length; i++) {
          expect(heartbeats[i].timestamp).toBeGreaterThanOrEqual(heartbeats[i - 1].timestamp);
        }

        // With active heartbeats, the entry lease is continuously refreshed,
        // preventing the stale detector from reclaiming it as an orphan.

        // Fire completion so executeTask resolves and the test doesn't hang.
        completeCallback?.({
          requestId: 'req-gc-2',
          actionId: 'gc-task-2',
          status: 'completed',
          outputs: { exitCode: 0 },
        });
        await vi.runAllTimersAsync();
        await done;
      } finally {
        vi.useRealTimers();
      }
    });

    it('TaskRunner passes heartbeat events to callbacks.onHeartbeat', async () => {
      vi.useFakeTimers();
      try {
        const receivedHeartbeats: string[] = [];
        const heartbeatCallbacks: Array<(taskId: string) => void> = [];
        let completeCallback: ((response: WorkResponse) => void) | undefined;
        const handle = { executionId: 'exec-gc-3', taskId: 'gc-task-3', workspacePath: '/tmp/mock-worktree' };

        const gcExecutor = {
          type: 'worktree',
          start: vi.fn(async () => handle),
          onOutput: () => () => {},
          onComplete: vi.fn((_h: unknown, cb: (response: WorkResponse) => void) => {
            completeCallback = cb;
            return () => {};
          }),
          onHeartbeat: vi.fn((_h: unknown, cb: (taskId: string) => void) => {
            heartbeatCallbacks.push(cb);
            return () => {};
          }),
        };

        const executor = new TaskRunner({
          orchestrator: { getTask: () => undefined, handleWorkerResponse: vi.fn() } as any,
          persistence: { updateTask: vi.fn() } as any,
          executorRegistry: {
            getDefault: () => gcExecutor,
            get: () => gcExecutor,
            getAll: () => [gcExecutor],
          } as any,
          cwd: '/tmp',
          callbacks: {
            onHeartbeat: (taskId: string) => {
              receivedHeartbeats.push(taskId);
            },
          },
        });

        const task = makeTask({ id: 'gc-task-3', status: 'running', config: { command: 'echo test' } });
        const done = executor.executeTask(task);

        await vi.runAllTimersAsync();
        expect(gcExecutor.onHeartbeat).toHaveBeenCalled();

        // Simulate heartbeat from executor
        heartbeatCallbacks.forEach(cb => cb('gc-task-3'));

        // Verify TaskRunner forwarded the heartbeat to its callback
        expect(receivedHeartbeats).toContain('gc-task-3');

        // Fire completion so executeTask resolves and the test doesn't hang.
        completeCallback?.({
          requestId: 'req-gc-3',
          actionId: 'gc-task-3',
          status: 'completed',
          outputs: { exitCode: 0 },
        });
        await vi.runAllTimersAsync();
        await done;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('completionChain serialization', () => {
    function createDeferred<T = void>() {
      let resolve!: (value: T) => void;
      let reject!: (reason?: any) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    async function flush() {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }

    it('does not run merge-node work from the completion handler', async () => {
      const log: string[] = [];
      const deferred1 = createDeferred();
      const deferred2 = createDeferred();
      let mergeCallCount = 0;

      const completeCallbacks = new Map<string, (response: WorkResponse) => void>();
      const manualExecutor = {
        type: 'worktree',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `invoker/${request.actionId}`,
        })),
        onComplete: vi.fn((handle: any, cb: any) => {
          completeCallbacks.set(handle.taskId, cb);
        }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
      };

      const runner = new TaskRunner({
        orchestrator: {
          getTask: () => undefined,
          handleWorkerResponse: vi.fn(() => []),
          getAllTasks: () => [],
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => manualExecutor,
          get: () => manualExecutor,
          getAll: () => [manualExecutor],
        } as any,
        cwd: '/tmp',
      });

      vi.spyOn(runner as any, 'executeMergeNode').mockImplementation(async () => {
        const n = ++mergeCallCount;
        log.push(`enter-${n}`);
        if (n === 1) await deferred1.promise;
        else await deferred2.promise;
        log.push(`exit-${n}`);
      });

      const task1 = makeTask({ id: 'merge-1', status: 'running', config: { isMergeNode: true, runnerKind: 'worktree' } });
      const task2 = makeTask({ id: 'merge-2', status: 'running', config: { isMergeNode: true, runnerKind: 'worktree' } });

      const done1 = runner.executeTask(task1);
      const done2 = runner.executeTask(task2);
      await flush();
      expect(completeCallbacks.size).toBe(2);

      // Fire both onComplete callbacks simultaneously
      completeCallbacks.get('merge-1')!({
        requestId: 'r1', actionId: 'merge-1', status: 'completed', outputs: { exitCode: 0 },
      });
      completeCallbacks.get('merge-2')!({
        requestId: 'r2', actionId: 'merge-2', status: 'completed', outputs: { exitCode: 0 },
      });

      await flush();
      await Promise.all([done1, done2]);
      expect(log).toEqual([]);
      expect(mergeCallCount).toBe(0);
    });

    it('a completed no-command merge worktree does not enter merge execution from onComplete', async () => {
      vi.useFakeTimers();
      try {
        const log: string[] = [];
        const deferred1 = createDeferred();
        const completeCallbacks = new Map<string, (response: WorkResponse) => void>();
        const updateAttempt = vi.fn();
        const receivedHeartbeats: string[] = [];
        const onCompleteCb = vi.fn();

        const manualExecutor = {
          type: 'worktree',
          start: vi.fn(async (request: any) => ({
            executionId: `exec-${request.actionId}`,
            taskId: request.actionId,
            workspacePath: '/tmp/mock-worktree',
            branch: `invoker/${request.actionId}`,
          })),
          onComplete: vi.fn((handle: any, cb: any) => {
            completeCallbacks.set(handle.taskId, cb);
          }),
          onOutput: vi.fn(),
          onHeartbeat: vi.fn(),
          kill: vi.fn(),
        };

        const runner = new TaskRunner({
          orchestrator: {
            getTask: (id: string) => {
              if (id === 'merge-1') {
                return makeTask({
                  id,
                  status: 'running',
                  config: { isMergeNode: true, runnerKind: 'worktree' },
                  execution: { selectedAttemptId: 'attempt-1', generation: 1 },
                });
              }
              if (id === 'merge-2') {
                return makeTask({
                  id,
                  status: 'running',
                  config: { isMergeNode: true, runnerKind: 'worktree' },
                  execution: { selectedAttemptId: 'attempt-2', generation: 1 },
                });
              }
              return undefined;
            },
            handleWorkerResponse: vi.fn(() => []),
            getAllTasks: () => [],
          } as any,
          persistence: { updateTask: vi.fn(), updateAttempt } as any,
          executorRegistry: {
            getDefault: () => manualExecutor,
            get: () => manualExecutor,
            getAll: () => [manualExecutor],
          } as any,
          cwd: '/tmp',
          callbacks: {
            onHeartbeat: (taskId: string) => { receivedHeartbeats.push(taskId); },
            onComplete: onCompleteCb,
          },
        });

        vi.spyOn(runner as any, 'executeMergeNode').mockImplementation(async (task: TaskState) => {
          log.push(`enter-${task.id}`);
          if (task.id === 'merge-1') {
            await deferred1.promise;
          }
          log.push(`exit-${task.id}`);
        });

        const task1 = makeTask({
          id: 'merge-1',
          status: 'running',
          config: { isMergeNode: true, runnerKind: 'worktree' },
          execution: { selectedAttemptId: 'attempt-1', generation: 1 },
        });
        const task2 = makeTask({
          id: 'merge-2',
          status: 'running',
          config: { isMergeNode: true, runnerKind: 'worktree' },
          execution: { selectedAttemptId: 'attempt-2', generation: 1 },
        });

        const done1 = runner.executeTask(task1);
        const done2 = runner.executeTask(task2);
        await flush();
        expect(completeCallbacks.size).toBe(2);

        completeCallbacks.get('merge-1')!({
          requestId: 'r1',
          actionId: 'merge-1',
          status: 'completed',
          outputs: { exitCode: 0 },
        });
        completeCallbacks.get('merge-2')!({
          requestId: 'r2',
          actionId: 'merge-2',
          status: 'completed',
          outputs: { exitCode: 0 },
        });

        await flush();
        await vi.advanceTimersByTimeAsync(6 * 60 * 1000);

        expect(log).toEqual([]);
        expect(receivedHeartbeats).not.toContain('merge-2');
        expect(onCompleteCb).toHaveBeenCalledWith(
          'merge-2',
          expect.objectContaining({ status: 'completed' }),
        );

        deferred1.resolve(undefined as any);
        await Promise.all([done1, done2]);
        expect(log).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('starts an independent merge gate while another merge gate is still preparing review', async () => {
      const log: string[] = [];
      const deferred1 = createDeferred();
      const completeCallbacks = new Map<string, (response: WorkResponse) => void>();

      const mergeExecutor = {
        type: 'merge',
        start: vi.fn(async (request: any) => {
          const handle = {
            executionId: `exec-${request.actionId}`,
            taskId: request.actionId,
            workspacePath: `/tmp/mock-worktree-${request.actionId}`,
            branch: `invoker/${request.actionId}`,
          };
          setImmediate(async () => {
            log.push(`enter-${request.actionId}`);
            if (request.actionId === '__merge__wf-a') {
              await deferred1.promise;
            }
            log.push(`exit-${request.actionId}`);
            completeCallbacks.get(request.actionId)?.({
              requestId: request.requestId,
              actionId: request.actionId,
              attemptId: request.attemptId,
              executionGeneration: request.executionGeneration,
              status: 'completed',
              outputs: { exitCode: 0 },
            });
          });
          return handle;
        }),
        onComplete: vi.fn((handle: any, cb: any) => {
          completeCallbacks.set(handle.taskId, cb);
        }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
      };

      const runner = new TaskRunner({
        orchestrator: {
          getTask: (id: string) => makeTask({
            id,
            status: 'running',
            config: { isMergeNode: true },
            execution: {
              selectedAttemptId: `attempt-${id}`,
              generation: 1,
            },
          }),
          handleWorkerResponse: vi.fn(() => []),
          getAllTasks: () => [],
        } as any,
        persistence: { updateTask: vi.fn(), updateAttempt: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => mergeExecutor,
          get: () => mergeExecutor,
          getAll: () => [mergeExecutor],
        } as any,
        cwd: '/tmp',
      });

      const task1 = makeTask({
        id: '__merge__wf-a',
        status: 'running',
        config: { isMergeNode: true, runnerKind: 'merge' },
        execution: { selectedAttemptId: 'attempt-__merge__wf-a', generation: 1 },
      });
      const task2 = makeTask({
        id: '__merge__wf-b',
        status: 'running',
        config: { isMergeNode: true, runnerKind: 'merge' },
        execution: { selectedAttemptId: 'attempt-__merge__wf-b', generation: 1 },
      });

      const done1 = runner.executeTask(task1);
      const done2 = runner.executeTask(task2);
      await flush();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(completeCallbacks.size).toBe(2);

      await flush();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(log).toEqual([
        'enter-__merge__wf-a',
        'enter-__merge__wf-b',
        'exit-__merge__wf-b',
      ]);

      deferred1.resolve(undefined as any);
      await Promise.all([done1, done2]);
    });

    it('error in first onComplete handler does not block the second', async () => {
      let hwrCallCount = 0;
      const handleWorkerResponse = vi.fn(() => {
        hwrCallCount++;
        if (hwrCallCount === 1) throw new Error('boom');
        return [];
      });
      const onCompleteCb = vi.fn();

      const completeCallbacks = new Map<string, (response: WorkResponse) => void>();
      const manualExecutor = {
        type: 'worktree',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-worktree',
          branch: `invoker/${request.actionId}`,
        })),
        onComplete: vi.fn((handle: any, cb: any) => {
          completeCallbacks.set(handle.taskId, cb);
        }),
        onOutput: vi.fn(),
        onHeartbeat: vi.fn(),
        kill: vi.fn(),
      };

      const runner = new TaskRunner({
        orchestrator: {
          getTask: () => undefined,
          handleWorkerResponse,
          getAllTasks: () => [],
        } as any,
        persistence: { updateTask: vi.fn() } as any,
        executorRegistry: {
          getDefault: () => manualExecutor,
          get: () => manualExecutor,
          getAll: () => [manualExecutor],
        } as any,
        cwd: '/tmp',
        callbacks: { onComplete: onCompleteCb },
      });

      const task1 = makeTask({ id: 'task-err-1', status: 'running', config: { command: 'echo hi' } });
      const task2 = makeTask({ id: 'task-err-2', status: 'running', config: { command: 'echo hi' } });

      const done1 = runner.executeTask(task1);
      const done2 = runner.executeTask(task2);
      await flush();

      // Fire both completions simultaneously
      completeCallbacks.get('task-err-1')!({
        requestId: 'r1', actionId: 'task-err-1', status: 'completed', outputs: { exitCode: 0 },
      });
      completeCallbacks.get('task-err-2')!({
        requestId: 'r2', actionId: 'task-err-2', status: 'completed', outputs: { exitCode: 0 },
      });

      await Promise.all([done1, done2]);

      // Task 1: handleWorkerResponse threw → catch block sent failed re-submission
      expect(onCompleteCb).toHaveBeenCalledWith('task-err-1', expect.objectContaining({ status: 'failed' }));
      // Task 2: completes normally despite task-1 error
      expect(onCompleteCb).toHaveBeenCalledWith('task-err-2', expect.objectContaining({ status: 'completed' }));
      // handleWorkerResponse called 3 times: 1st (throws), 2nd (catch re-submit for task-1), 3rd (task-2 normal)
      expect(handleWorkerResponse).toHaveBeenCalledTimes(3);
    });
  });

  // ── PR-authoring regression coverage ──────────────────────

  describe('PR-authoring fallback order', () => {
    it('preferred agent is tried first, then remaining PR-capable agents in registration order', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;

      // Set up skill directories for both agents
      mkdirSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const attemptOrder: string[] = [];
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore' as const,
          bundledSkillRoot: join(tempHome, '.claude', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => {
            attemptOrder.push('claude');
            return {
              cmd: 'node',
              args: ['-e', 'process.exit(1)'], // Fail so fallback continues
              sessionId: 'sess-claude',
            };
          },
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore' as const,
          bundledSkillRoot: join(tempHome, '.codex', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => {
            attemptOrder.push('codex');
            return {
              cmd: 'node',
              // Emit invalid PR body (missing Test Plan and Revert Plan) so validation fails
              args: ['-e', 'process.stdout.write("## Summary\\n\\nOnly summary, no other sections")'],
              sessionId: 'sess-codex',
            };
          },
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };

        // Tasks use codex — codex is the preferred agent
        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [
              makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'codex' } }),
            ],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => name === 'claude' ? claudeAgent : name === 'codex' ? codexAgent : undefined,
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            // Registration order: claude first, codex second
            listWithCapability: vi.fn().mockReturnValue([claudeAgent, codexAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Fallback Order Test',
          baseBranch: 'master',
          featureBranch: 'plan/order',
          workflowSummary: 'Summary text',
          cwd: '/tmp',
        });

        // Preferred agent (codex) should be tried first even though claude was registered first
        expect(attemptOrder[0]).toBe('codex');
        // Claude should be tried second as fallback (codex body failed validation)
        expect(attemptOrder[1]).toBe('claude');
        // Both agents failed, so canonical fallback
        expect(result.agentName).toBe('canonical');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('preferred agent succeeds without trying fallback agents', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;

      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const claudeAttempted = vi.fn();
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore' as const,
          bundledSkillRoot: join(tempHome, '.codex', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => ({
            cmd: 'node',
            args: ['-e', 'process.stdout.write("## Summary\\n\\nOK\\n\\n## Test Plan\\n\\n- [x] tests\\n\\n## Revert Plan\\n\\n- Safe to revert? Yes\\n- Revert command: `git revert <sha>`\\n- Post-revert steps: None\\n- Data migration? No\\n")'],
            sessionId: 'sess-codex-ok',
          }),
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore' as const,
          bundledSkills: ['make-pr'],
          buildCommand: () => { claudeAttempted(); return { cmd: 'false', args: [] }; },
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };

        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'codex' } })],
          } as any,
          persistence: {} as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => name === 'codex' ? codexAgent : name === 'claude' ? claudeAgent : undefined,
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([claudeAgent, codexAgent]),
          } as any,
          cwd: '/tmp',
          logger: createMockLogger(),
        });

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Success Test',
          baseBranch: 'master',
          featureBranch: 'plan/success',
          workflowSummary: 'Summary',
          cwd: '/tmp',
        });

        expect(result.agentName).toBe('codex');
        expect(claudeAttempted).not.toHaveBeenCalled();
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });
  });

  describe('no-capable-agent deterministic PR-body fallback', () => {
    it('canonical fallback includes all required sections', () => {
      const body = buildCanonicalPrBody({
        title: 'Test PR',
        workflowSummary: 'Implemented feature X.',
      });

      expect(body).toContain('## Summary');
      expect(body).toContain('## Test Plan');
      expect(body).toContain('## Revert Plan');
      expect(validateCanonicalPrBody(body)).toEqual([]);
    });

    it('canonical fallback uses workflowDescription over workflowSummary when available', () => {
      const body = buildCanonicalPrBody({
        title: 'Test PR',
        workflowSummary: 'Raw summary that should not appear.',
        structuredContext: {
          workflowDescription: 'Preferred description from YAML.',
          tasks: [],
        },
      });

      expect(body).toContain('Preferred description from YAML.');
      expect(body).not.toContain('Raw summary that should not appear.');
    });

    it('canonical fallback lists completed command tasks as checked items in Test Plan', () => {
      const body = buildCanonicalPrBody({
        title: 'Test PR',
        workflowSummary: 'Summary',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Run unit tests', status: 'completed', command: 'pnpm test' },
            { taskId: 't2', description: 'Run lint', status: 'completed', command: 'pnpm lint' },
            { taskId: 't3', description: 'Implement feature', status: 'completed' }, // no command
            { taskId: 't4', description: 'Deploy check', status: 'failed', command: 'pnpm deploy' },
          ],
        },
      });

      // Completed command tasks appear as checked items
      expect(body).toContain('- [x] `pnpm test` — Run unit tests');
      expect(body).toContain('- [x] `pnpm lint` — Run lint');
      // Non-command task excluded from Test Plan command list
      expect(body).not.toContain('Implement feature');
      // Failed command task excluded
      expect(body).not.toContain('pnpm deploy');
    });

    it('canonical fallback shows manual verification when no completed command tasks exist', () => {
      const body = buildCanonicalPrBody({
        title: 'Test PR',
        workflowSummary: 'Summary',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Code change', status: 'completed' }, // no command
          ],
        },
      });

      expect(body).toContain('Manual verification required');
    });

    it('authorPrBodyWithSkill returns canonical fallback when no agents have make-pr capability', async () => {
      const logger = createMockLogger();
      const bareAgent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        buildCommand: () => ({ cmd: 'false', args: [] }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => null,
          getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
        } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: () => bareAgent,
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([]), // No agents with make-pr
        } as any,
        cwd: '/tmp',
        logger,
      });

      const result = await (executor as any).authorPrBodyWithSkill({
        workflowId: 'wf-1',
        title: 'No Capable Agent',
        baseBranch: 'master',
        featureBranch: 'plan/no-capable',
        workflowSummary: 'Summary without agents.',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Run tests', status: 'completed', command: 'pnpm test' },
          ],
        },
        cwd: '/tmp',
      });

      expect(result.agentName).toBe('canonical');
      expect(result.sessionId).toBe('canonical-fallback');
      // Canonical body still contains the verification command
      expect(result.body).toContain('pnpm test');
      expect(result.body).toContain('## Test Plan');
      expect(validateCanonicalPrBody(result.body)).toEqual([]);
    });
  });

  describe('external_review propagation of authored PR body', () => {
    it('createReview receives the authored body, not the raw workflowSummary', async () => {
      const allTasks = [
        makeTask({
          id: 't1',
          config: { workflowId: 'wf-1' },
          status: 'completed',
          execution: { branch: 'experiment/t1' },
        }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
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

      const rawSummary = '## Summary\nRaw workflow summary — should not appear in PR body';
      const authoredBody = '## Summary\n\nAuthored PR body with enriched content\n\n## Test Plan\n\n- [x] verified\n\n## Revert Plan\n\n- Safe to revert';
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async () => '';
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).startPrPolling = vi.fn();
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue(rawSummary);
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: authoredBody,
        sessionId: 'sess-ext-propagation',
        agentName: 'claude',
      });

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // The authored body must be passed to createReview, not the raw summary
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ body: authoredBody }),
      );
      // Raw summary must not leak into the PR body
      const prBodyArg = mergeGateProvider.createReview.mock.calls[0][0].body;
      expect(prBodyArg).not.toContain('Raw workflow summary — should not appear in PR body');
    });

    it('authorPrBodyWithSkill receives workflowSummary and structuredContext in external_review', async () => {
      const allTasks = [
        makeTask({
          id: 't1',
          config: { workflowId: 'wf-1', command: 'pnpm test' },
          description: 'Run unit tests',
          status: 'completed',
          execution: { branch: 'experiment/t1' },
        }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
        handleWorkerResponse: vi.fn(() => []),
        setTaskAwaitingApproval: vi.fn(),
      };
      const persistence = {
        loadWorkflow: () => ({
          id: 'wf-1',
          onFinish: 'merge',
          mergeMode: 'external_review',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          name: 'Test Workflow',
          description: 'Workflow description from YAML',
        }),
        updateTask: vi.fn(),
      };
      const mergeGateProvider = {
        createReview: vi.fn().mockResolvedValue({ url: 'https://example.com/pr/1', identifier: '1' }),
      };
      const authorPrSpy = vi.fn().mockResolvedValue({
        body: '## Summary\n\nOK\n\n## Test Plan\n\n- [x] pnpm test\n\n## Revert Plan\n\n- Safe',
        sessionId: 'sess-ctx',
        agentName: 'claude',
      });
      const executor = new TaskRunner({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGitReadonly = async () => '';
      (executor as any).execGitIn = async () => '';
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).startPrPolling = vi.fn();
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('## Summary\nWorkflow summary');
      (executor as any).authorPrBodyWithSkill = authorPrSpy;

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // authorPrBodyWithSkill should receive structuredContext with task entries
      expect(authorPrSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          workflowSummary: expect.any(String),
          structuredContext: expect.objectContaining({
            tasks: expect.arrayContaining([
              expect.objectContaining({
                taskId: 't1',
                description: 'Run unit tests',
                status: 'completed',
              }),
            ]),
          }),
        }),
      );
    });
  });

  describe('UI-workflow Test Plan retention', () => {
    it('canonical PR body retains executed UI verification commands in Test Plan', () => {
      const ctx: PrAuthoringContext = {
        workflowDescription: 'Add dark mode toggle',
        tasks: [
          { taskId: 't1', description: 'Implement dark mode CSS', status: 'completed' },
          { taskId: 't2', description: 'Run visual regression', status: 'completed', command: 'pnpm test:visual' },
          { taskId: 't3', description: 'Run accessibility check', status: 'completed', command: 'pnpm test:a11y' },
          { taskId: 't4', description: 'Manual UI review', status: 'completed' },
        ],
      };

      const body = buildCanonicalPrBody({
        title: 'Dark Mode',
        workflowSummary: 'Summary',
        structuredContext: ctx,
      });

      // UI verification commands must appear in the Test Plan
      expect(body).toContain('`pnpm test:visual`');
      expect(body).toContain('`pnpm test:a11y`');
      // Commands are checked (completed)
      expect(body).toContain('- [x] `pnpm test:visual` — Run visual regression');
      expect(body).toContain('- [x] `pnpm test:a11y` — Run accessibility check');
      // Must not fall back to manual verification since command tasks exist
      expect(body).not.toContain('Manual verification required');
    });

    it('UI verification commands are not dropped when mixed with non-command tasks', () => {
      const ctx: PrAuthoringContext = {
        tasks: [
          { taskId: 't1', description: 'Write component', status: 'completed' },
          { taskId: 't2', description: 'Screenshot check', status: 'completed', command: 'bash scripts/ui-visual-proof.sh' },
        ],
      };

      const body = buildCanonicalPrBody({
        title: 'UI Feature',
        workflowSummary: 'Added UI feature',
        structuredContext: ctx,
      });

      // The UI command must survive into the final body
      expect(body).toContain('`bash scripts/ui-visual-proof.sh`');
      expect(body).toContain('Screenshot check');
    });
  });

  describe('visual-proof markdown preservation', () => {
    it('canonical PR body includes visual proof markdown verbatim', () => {
      const visualProof = [
        '## Visual Proof',
        '',
        '| Before | After |',
        '|--------|-------|',
        '| ![before](https://img.example.com/before.png) | ![after](https://img.example.com/after.png) |',
      ].join('\n');

      const ctx: PrAuthoringContext = {
        tasks: [
          { taskId: 't1', description: 'Update UI', status: 'completed', command: 'pnpm test' },
        ],
        visualProofMarkdown: visualProof,
      };

      const body = buildCanonicalPrBody({
        title: 'UI Update',
        workflowSummary: 'Updated UI components',
        structuredContext: ctx,
      });

      // Visual proof must appear in the body verbatim
      expect(body).toContain('## Visual Proof');
      expect(body).toContain('![before](https://img.example.com/before.png)');
      expect(body).toContain('![after](https://img.example.com/after.png)');
      // The whole visual proof block must be preserved
      expect(body).toContain(visualProof);
    });

    it('canonical PR body omits visual proof section when no capture content exists', () => {
      const body = buildCanonicalPrBody({
        title: 'No Proof',
        workflowSummary: 'Summary',
        structuredContext: {
          tasks: [{ taskId: 't1', description: 'Task', status: 'completed', command: 'echo ok' }],
          // visualProofMarkdown is undefined
        },
      });

      expect(body).not.toContain('Visual Proof');
    });

    it('visual proof is preserved through the full authorPrBodyWithSkill fallback path', async () => {
      const logger = createMockLogger();
      const bareAgent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        bundledSkills: ['make-pr'],
        buildCommand: () => ({ cmd: 'false', args: [], sessionId: 'x' }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };

      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => null,
          getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
        } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: () => bareAgent,
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([bareAgent]),
        } as any,
        cwd: '/tmp',
        logger,
      });

      const visualProof = '## Visual Proof\n\n![screenshot](https://img.example.com/proof.png)\n\nVideo walkthrough: [link](https://example.com/video)';

      const result = await (executor as any).authorPrBodyWithSkill({
        workflowId: 'wf-1',
        title: 'Visual Proof Preservation',
        baseBranch: 'master',
        featureBranch: 'plan/visual',
        workflowSummary: 'Summary',
        structuredContext: {
          tasks: [
            { taskId: 't1', description: 'Build UI', status: 'completed', command: 'pnpm build' },
          ],
          visualProofMarkdown: visualProof,
        },
        cwd: '/tmp',
      });

      // All agents fail (no skill installed) → canonical fallback must preserve visual proof
      expect(result.agentName).toBe('canonical');
      expect(result.body).toContain('## Visual Proof');
      expect(result.body).toContain('![screenshot](https://img.example.com/proof.png)');
      expect(result.body).toContain('Video walkthrough: [link](https://example.com/video)');
      expect(result.body).toContain('pnpm build');
    });

    it('visual proof content is not dropped when structuredContext has both tasks and visual proof', () => {
      const ctx: PrAuthoringContext = {
        workflowName: 'UI Workflow',
        workflowDescription: 'Add responsive layout',
        tasks: [
          { taskId: 't1', description: 'Implement CSS grid', status: 'completed' },
          { taskId: 't2', description: 'Run responsive tests', status: 'completed', command: 'pnpm test:responsive' },
          { taskId: 't3', description: 'Capture screenshots', status: 'completed', command: 'bash scripts/ui-visual-proof.sh' },
        ],
        visualProofMarkdown: '## Visual Proof\n\n### Desktop\n![desktop](https://img.example.com/desktop.png)\n\n### Mobile\n![mobile](https://img.example.com/mobile.png)',
      };

      const body = buildCanonicalPrBody({
        title: 'Responsive Layout',
        workflowSummary: 'Summary',
        structuredContext: ctx,
      });

      // All sections must coexist
      expect(body).toContain('## Summary');
      expect(body).toContain('Add responsive layout');
      expect(body).toContain('## Test Plan');
      expect(body).toContain('`pnpm test:responsive`');
      expect(body).toContain('`bash scripts/ui-visual-proof.sh`');
      expect(body).toContain('## Revert Plan');
      expect(body).toContain('## Visual Proof');
      expect(body).toContain('![desktop](https://img.example.com/desktop.png)');
      expect(body).toContain('![mobile](https://img.example.com/mobile.png)');
      // Validate the body passes canonical schema validation
      expect(validateCanonicalPrBody(body)).toEqual([]);
    });
  });

  describe('SSH heartbeat persistence metadata', () => {
    it('stores remote workload heartbeat metadata for SSH executors', async () => {
      const runningTask = makeTask({
        id: 'task-ssh-heartbeat',
        status: 'running',
        config: {
          workflowId: 'wf-1',
          runnerKind: 'ssh',
          command: 'echo hi',
          poolMemberId: 'remote-1',
        },
        execution: { generation: 0, selectedAttemptId: 'attempt-ssh-1' },
      });

      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const heartbeatCallbacks = new Map<string, (taskId: string) => void>();
      const completeCallbacks = new Map<string, (response: any) => void>();
      const sshExecutor = {
        type: 'ssh',
        start: vi.fn(async () => ({
          executionId: 'exec-ssh-1',
          taskId: runningTask.id,
          workspacePath: '/tmp/ws',
        })),
        onOutput: vi.fn((_handle: unknown, _cb: (chunk: string) => void) => () => {}),
        onHeartbeat: vi.fn((_handle: unknown, cb: (taskId: string) => void) => {
          heartbeatCallbacks.set(runningTask.id, cb);
          return () => {};
        }),
        onComplete: vi.fn((_handle: unknown, cb: (response: any) => void) => {
          completeCallbacks.set(runningTask.id, cb);
          return () => {};
        }),
      } as any;

      const runner = new TaskRunner({
        orchestrator: {
          getTask: vi.fn((id: string) => (id === runningTask.id ? runningTask : undefined)),
          getAllTasks: vi.fn(() => [runningTask]),
          markTaskRunningAfterLaunch: vi.fn(() => true),
          handleWorkerResponse: vi.fn(() => []),
        } as any,
        persistence: {
          loadWorkflow: vi.fn(() => ({ id: 'wf-1', repoUrl: 'git@github.com:owner/repo.git' })),
          updateTask,
          updateAttempt,
          appendTaskOutput: vi.fn(),
        } as any,
        executorRegistry: {
          getDefault: vi.fn(() => sshExecutor),
          get: vi.fn((type: string) => (type === 'ssh' ? sshExecutor : null)),
          getAll: vi.fn(() => []),
        } as any,
        cwd: '/tmp',
        callbacks: { onHeartbeat: vi.fn() },
      });

      const pending = runner.executeTask(runningTask);
      await new Promise((resolve) => setImmediate(resolve));
      heartbeatCallbacks.get(runningTask.id)?.(runningTask.id);
      completeCallbacks.get(runningTask.id)?.({
        requestId: 'req-done',
        actionId: runningTask.id,
        status: 'completed',
        outputs: { exitCode: 0 },
      });
      await pending;

      expect(updateTask).toHaveBeenCalledWith(
        runningTask.id,
        expect.objectContaining({
          execution: expect.objectContaining({
            lastHeartbeatAt: expect.any(Date),
            remoteHeartbeatAt: expect.any(Date),
            heartbeatSource: 'remote_workload',
          }),
        }),
      );
      expect(updateAttempt).toHaveBeenCalledWith(
        'attempt-ssh-1',
        expect.objectContaining({
          lastHeartbeatAt: expect.any(Date),
          leaseExpiresAt: expect.any(Date),
        }),
      );
    });
  });
});
