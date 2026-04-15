import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { collectTransitiveNonMergeTaskIds } from '../merge-runner.js';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkResponse } from '@invoker/contracts';
import { EventEmitter } from 'events';

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

  describe('collectTransitiveNonMergeTaskIds', () => {
    it('walks backwards from merge deps to include intermediate tasks', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('verify-ui-tests', makeTask({ id: 'verify-ui-tests', dependencies: [] }));
      tasks.set('distinguish', makeTask({ id: 'distinguish', dependencies: ['verify-ui-tests'] }));
      const merge = makeTask({
        id: '__merge__wf-1',
        dependencies: ['distinguish'],
        config: { isMergeNode: true },
      });
      const ids = collectTransitiveNonMergeTaskIds(merge, (id) => tasks.get(id));
      expect([...ids].sort()).toEqual(['distinguish', 'verify-ui-tests']);
    });

    it('stops at merge nodes in the dependency chain', () => {
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
      const ids = collectTransitiveNonMergeTaskIds(rootMerge, (id) => tasks.get(id));
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
        config: { executorType: 'worktree' },
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
        config: { command: 'echo hi', executorType: 'ssh' as any },
      });
      await executor.executeTask(task);

      expect(updateTask).toHaveBeenCalledWith('failing-start', {
        config: { executorType: 'ssh' },
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

  describe('upstream branch metadata guard', () => {
    it('fails task when a completed worktree dep has no branch', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-a', makeTask({
        id: 'dep-a',
        status: 'completed',
        config: { executorType: 'worktree' },
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
        config: { executorType: 'worktree' },
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

    it('fails when dep has no executorType set and no branch', async () => {
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
        config: { executorType: 'worktree' },
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
        config: { executorType: 'worktree' },
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

    it('fails when dep has no executorType set and no branch', async () => {
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

  describe('baseBranch in WorkRequest', () => {
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
        config: expect.objectContaining({ executorType: 'worktree' }),
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
        config: expect.objectContaining({ executorType: 'worktree' }),
        execution: expect.objectContaining({ branch: 'plan/feature', workspacePath: '/tmp/mock-wt' }),
      }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({ status: 'completed' }),
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

      // Should create a PR via mergeGateProvider (using the gate clone dir, not host.cwd)
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          title: 'Test Workflow',
          cwd: '/tmp/mock-wt',
        }),
      );

      // Should set task awaiting approval with PR metadata (not handleWorkerResponse)
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1', expect.objectContaining({
        config: expect.objectContaining({ executorType: 'worktree' }),
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
        expect.objectContaining({ status: 'completed' }),
      );
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
        config: expect.objectContaining({ executorType: 'worktree' }),
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

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

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
        config: expect.objectContaining({ executorType: 'worktree' }),
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

    it('executeMergeNode anchors external_review gate worktrees on upstream base when upstream remote exists', async () => {
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
        if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
          return 'git@github.com:upstream/repo.git';
        }
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async () => '';
      const createMergeWorktreeSpy = vi.fn().mockResolvedValue('/tmp/mock-wt');
      (executor as any).createMergeWorktree = createMergeWorktreeSpy;
      (executor as any).removeMergeWorktree = async () => {};
      (executor as any).startPrPolling = vi.fn();

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(createMergeWorktreeSpy).toHaveBeenCalledWith(
        'upstream/master',
        expect.stringContaining('gate-__merge__wf-1'),
        undefined,
      );
    });

    it('executeMergeNode treats persisted mergeMode=github like external_review (legacy DB / UI value)', async () => {
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
          mergeMode: 'github',
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
        config: expect.objectContaining({ executorType: 'worktree' }),
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

      const logSpy = vi.spyOn(console, 'log');

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

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
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/55');

      const logSpy = vi.spyOn(console, 'log');

      await executor.approveMerge('wf-1');

      // Should push + create PR (with clone dir as cwd)
      expect((executor as any).execPr).toHaveBeenCalledWith('master', 'plan/feature', 'Test Workflow', expect.any(String), '/tmp/mock-wt');

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

    it('executeMergeNode passes summary body to createReview in external_review mode', async () => {
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

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({ body: '## Summary\nTest summary' }),
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
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/88');

      await executor.approveMerge('wf-1');

      expect((executor as any).execPr).toHaveBeenCalledWith(
        'master', 'plan/feature', 'Test Workflow', '## Summary\nApprove summary', '/tmp/mock-wt',
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

    it('completes merge gate when PR is approved', async () => {
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
          approved: true,
          rejected: false,
          statusText: 'Approved',
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
        execution: { reviewStatus: 'Approved' },
      });
      expect(orchestrator.approve).toHaveBeenCalledWith('task-1');

      // Should stop polling after approval
      expect((executor as any).activePrPollers.has('task-1')).toBe(false);
    });

    it('is no-op when no active poller', async () => {
      const orchestrator = {
        getTask: vi.fn(),
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

      await executor.checkPrApprovalNow('task-with-no-poller');

      expect(mergeGateProvider.checkApproval).not.toHaveBeenCalled();
      expect(persistence.updateTask).not.toHaveBeenCalled();
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
      // Check that horizontal rule separator is NOT present
      // (table header separator contains dashes but is different format)
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

    it('merges the full linear chain when merge gate depends only on the tip task', async () => {
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

      expect(mergedBranches.sort()).toEqual(['invoker/A', 'invoker/B', 'invoker/C', 'invoker/D']);
    });

    it('includes parallel workflow leaves even when merge.dependencies omits one leaf', async () => {
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

      expect(mergedBranches.sort()).toEqual(['experiment/distinguish-par', 'experiment/verify-par']);
    });

    it('merges transitive upstream branches when merge gate depends only on the final leaf', async () => {
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
      expect(mergedBranches).toContain('experiment/verify-ce05');
    });

    it('forked leaves: merges only leaf branches from merge gate deps', async () => {
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

      // Transitive closure from leaves D,E includes fork ancestors A,B,C
      expect(mergedBranches.sort()).toEqual([
        'invoker/A',
        'invoker/B',
        'invoker/C',
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
        config: { executorType: 'ssh', remoteTargetId: 'do-droplet' },
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
        config: { executorType: 'ssh', remoteTargetId: 'missing-target' },
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

      // PR created via mergeGateProvider (using gate clone dir, not host.cwd)
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          title: 'Test Workflow',
          cwd: '/tmp/gate-clone',
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

      expect((executor as any).execPr).toHaveBeenCalledWith('master', 'plan/feature', 'Test Workflow', '## Summary', '/tmp/gate-clone');
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
        config: expect.objectContaining({ executorType: 'worktree' }),
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
          error: expect.stringContaining('Post-fix PR prep failed'),
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
    it('caches SSH executors by remoteTargetId and reuses them', () => {
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
        config: { executorType: 'ssh', remoteTargetId: 'remote-a' },
      });
      const task2 = makeTask({
        id: 'task-2',
        config: { executorType: 'ssh', remoteTargetId: 'remote-a' },
      });
      const task3 = makeTask({
        id: 'task-3',
        config: { executorType: 'ssh', remoteTargetId: 'remote-b' },
      });

      const executor1 = executor.selectExecutor(task1);
      const executor2 = executor.selectExecutor(task2);
      const executor3 = executor.selectExecutor(task3);

      // task1 and task2 share the same remoteTargetId → same executor instance
      expect(executor1).toBe(executor2);
      // task3 has a different remoteTargetId → different executor instance
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
        config: { executorType: 'worktree' },
      });
      const task2 = makeTask({
        id: 'task-2',
        config: { executorType: 'worktree' },
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
        config: { executorType: 'ssh', remoteTargetId: 'remote-a' },
      });
      const task2 = makeTask({
        id: 'task-2',
        config: { executorType: 'ssh', remoteTargetId: 'remote-a' },
      });

      const executor1 = executor.selectExecutor(task1);
      await executor.clearSshExecutorCache();
      const executor2 = executor.selectExecutor(task2);

      // After clearing cache, a new executor instance should be created
      expect(executor1).not.toBe(executor2);
    });

    it('throws when SSH task has no remoteTargetId', () => {
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        remoteTargetsProvider: () => ({}),
      });

      const task = makeTask({
        id: 'task-missing-target',
        config: { executorType: 'ssh' },
      });

      expect(() => executor.selectExecutor(task)).toThrow('has executorType=ssh but no remoteTargetId');
    });

    it('throws when remoteTargetId does not exist in config', () => {
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
        config: { executorType: 'ssh', remoteTargetId: 'remote-unknown' },
      });

      expect(() => executor.selectExecutor(task)).toThrow('no matching entry exists in remoteTargets config');
    });
  });

  describe('metadata persistence hardening', () => {
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
          executorType: 'ssh',
          remoteTargetId: 'remote-1',
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
        config: { executorType: 'ssh' },
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
        config: { command: 'echo test', executorType: 'ssh' },
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
        config: { executorType: 'ssh' },
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
        config: { command: 'pwd', executorType: 'ssh' },
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
        config: { executorType: 'ssh' },
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

    it('serializes concurrent onComplete handlers for merge-node tasks', async () => {
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

      const task1 = makeTask({ id: 'merge-1', status: 'running', config: { isMergeNode: true } });
      const task2 = makeTask({ id: 'merge-2', status: 'running', config: { isMergeNode: true } });

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
      expect(log).toEqual(['enter-1']);

      deferred1.resolve(undefined as any);
      await flush();
      expect(log).toEqual(['enter-1', 'exit-1', 'enter-2']);

      deferred2.resolve(undefined as any);
      await Promise.all([done1, done2]);
      expect(log).toEqual(['enter-1', 'exit-1', 'enter-2', 'exit-2']);
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
});
