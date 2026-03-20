import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskExecutor } from '../task-executor.js';
import type { TaskState } from '@invoker/core';
import { EventEmitter } from 'events';

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

function createExecutorWithTasks(tasks: Map<string, TaskState>): TaskExecutor {
  const orchestrator = {
    getTask: (id: string) => tasks.get(id),
  };

  return new TaskExecutor({
    orchestrator: orchestrator as any,
    persistence: {} as any,
    familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
    cwd: '/tmp',
  });
}

describe('TaskExecutor', () => {
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

    it('excludes dependencies without a branch field', () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('dep-with-branch', makeTask({
        id: 'dep-with-branch',
        status: 'completed',
        execution: { branch: 'experiment/dep-with-branch' },
      }));
      tasks.set('dep-no-branch', makeTask({
        id: 'dep-no-branch',
        status: 'completed',
      }));

      const executor = createExecutorWithTasks(tasks);
      const task = makeTask({
        id: 'child',
        dependencies: ['dep-with-branch', 'dep-no-branch'],
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
  });

  describe('executeTask error handling', () => {
    it('sends failed WorkResponse when familiar.start throws', async () => {
      const handleWorkerResponse = vi.fn();
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse,
      };
      const throwingFamiliar = {
        type: 'worktree',
        start: async () => { throw new Error('worktree creation failed'); },
        onOutput: () => () => {},
        onComplete: () => () => {},
      };
      const registry = {
        getDefault: () => throwingFamiliar,
        get: () => throwingFamiliar,
        getAll: () => [throwingFamiliar],
      };
      const onComplete = vi.fn();

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { updateTask: vi.fn() } as any,
        familiarRegistry: registry as any,
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
  });

  describe('baseBranch in WorkRequest', () => {
    it('includes workflow baseBranch in request inputs', async () => {
      let capturedRequest: any;
      const capturingFamiliar = {
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
        getDefault: () => capturingFamiliar,
        get: () => capturingFamiliar,
        getAll: () => [capturingFamiliar],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ baseBranch: 'main', generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: registry as any,
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
      const capturingFamiliar = {
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
        getDefault: () => capturingFamiliar,
        get: () => capturingFamiliar,
        getAll: () => [capturingFamiliar],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: registry as any,
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
      const capturingFamiliar = {
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
        getDefault: () => capturingFamiliar,
        get: () => capturingFamiliar,
        getAll: () => [capturingFamiliar],
      };
      const persistence = {
        updateTask: vi.fn(),
        loadWorkflow: () => ({ generation: 0 }),
      };
      const orchestrator = {
        getTask: () => undefined,
        handleWorkerResponse: vi.fn(),
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: registry as any,
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

      const origExecGit = (executor as any).execGit.bind(executor);
      (executor as any).execGit = async (args: string[]) => {
        if (args.includes('symbolic-ref')) {
          return 'refs/remotes/origin/master';
        }
        return origExecGit(args);
      };

      const branch = await executor.detectDefaultBranch();
      expect(branch).toBe('master');
    });

    it('falls back to main when symbolic-ref fails but main exists', async () => {
      const executor = createExecutorWithTasks(new Map());

      (executor as any).execGit = async (args: string[]) => {
        if (args.includes('symbolic-ref')) {
          throw new Error('not set');
        }
        if (args.includes('rev-parse') && args.includes('main')) {
          return 'abc123';
        }
        throw new Error('unexpected');
      };

      const branch = await executor.detectDefaultBranch();
      expect(branch).toBe('main');
    });

    it('falls back to master when both symbolic-ref and main fail', async () => {
      const executor = createExecutorWithTasks(new Map());

      (executor as any).execGit = async () => {
        throw new Error('not found');
      };

      const branch = await executor.detectDefaultBranch();
      expect(branch).toBe('master');
    });
  });

  describe('execGit error format', () => {
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

      const origExecGit = (executor as any).execGit.bind(executor);
      (executor as any).execGit = (args: string[]) => {
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

      try {
        await (executor as any).execGit(['merge', '--no-ff', 'some-branch']);
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout' && args[1] === '-b') return '';
        if (args[0] === 'merge' && args.includes('--no-ff')) {
          throw new Error('git merge --no-ff failed (code 1): CONFLICT (content): file.txt');
        }
        return '';
      };

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      const mergeAbortCall = gitCalls.find(c => c[0] === 'merge' && c[1] === '--abort');
      expect(mergeAbortCall).toBeDefined();

      const checkoutOriginal = gitCalls.filter(c => c[0] === 'checkout' && c[1] === 'master');
      expect(checkoutOriginal.length).toBeGreaterThanOrEqual(1);

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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete: vi.fn() },
      });

      const gitCalls: string[][] = [];
      let checkoutNewBranchAttempt = 0;
      (executor as any).execGit = async (args: string[]) => {
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

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      const deleteCall = gitCalls.find(c => c[0] === 'branch' && c[1] === '-D' && c[2] === 'plan/feature');
      expect(deleteCall).toBeDefined();

      // Default mergeMode is 'manual', so setTaskAwaitingApproval is called
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1');
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };

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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rebase' && gitCalls.filter(c => c[0] === 'checkout' && c[1] === 'experiment/t2').length > 0) {
          throw new Error('CONFLICT in file.txt');
        }
        return '';
      };

      const result = await executor.rebaseTaskBranches('wf-1', 'master');

      expect(result.success).toBe(false);
      expect(result.rebasedBranches).toEqual(['experiment/t1']);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('experiment/t2');
      expect(result.errors[0]).toContain('CONFLICT');

      const abortCalls = gitCalls.filter(c => c[0] === 'rebase' && c[1] === '--abort');
      expect(abortCalls).toHaveLength(1);
    });

    it('restores original branch after rebase', async () => {
      const allTasks = [
        makeTask({ id: 't1', config: { workflowId: 'wf-1' }, status: 'completed', execution: { branch: 'experiment/t1' } }),
      ];
      const orchestrator = {
        getTask: (id: string) => allTasks.find(t => t.id === id),
        getAllTasks: () => allTasks,
      };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'my-feature';
        return '';
      };

      await executor.rebaseTaskBranches('wf-1', 'master');

      const lastCheckout = gitCalls.filter(c => c[0] === 'checkout').pop();
      expect(lastCheckout).toEqual(['checkout', 'my-feature']);
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };

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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };

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

      // Should call setTaskAwaitingApproval instead of handleWorkerResponse
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1');
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({ status: 'completed' }),
      );

      // Should persist familiarType, branch, and workspacePath
      expect(persistence.updateTask).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: { familiarType: 'local' },
          execution: { branch: 'plan/feature', workspacePath: '/tmp' },
        }),
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete: vi.fn() },
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        // diff --cached --quiet exits non-zero when there are staged changes
        if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
          throw new Error('exit code 1');
        }
        return '';
      };

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        dependencies: ['t1'],
        config: { isMergeNode: true, workflowId: 'wf-1' },
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should squash merge featureBranch into baseBranch (no rebase)
      const rebaseCall = gitCalls.find(c => c[0] === 'rebase');
      expect(rebaseCall).toBeUndefined();
      const squashCall = gitCalls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/feature'));
      expect(squashCall).toBeDefined();
      const commitCall = gitCalls.find(c => c[0] === 'commit' && c.includes('-m'));
      expect(commitCall).toBeDefined();

      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('executeMergeNode skips squash-merge and creates PR when mergeMode=github', async () => {
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
          mergeMode: 'github',
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
        mergeGateProvider: mergeGateProvider as any,
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };

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

      // Should create a PR via mergeGateProvider
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith({
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        title: 'Test Workflow',
        cwd: '/tmp',
      });

      // Should set task awaiting approval (not handleWorkerResponse)
      expect(orchestrator.setTaskAwaitingApproval).toHaveBeenCalledWith('__merge__wf-1');
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
      expect(onComplete).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({ status: 'completed' }),
      );

      // Should persist PR metadata
      expect(persistence.updateTask).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          config: { familiarType: 'local' },
          execution: expect.objectContaining({
            branch: 'plan/feature',
            prUrl: 'https://github.com/owner/repo/pull/42',
            prIdentifier: 'owner/repo#42',
            prStatus: 'Awaiting review',
          }),
        }),
      );
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
      };
      const executor = new TaskExecutor({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };

      await executor.approveMerge('wf-1');

      // Should checkout baseBranch, squash merge, and commit (no rebase)
      const rebaseCall = gitCalls.find(c => c[0] === 'rebase');
      expect(rebaseCall).toBeUndefined();
      const checkoutBase = gitCalls.find(c => c[0] === 'checkout' && c[1] === 'master');
      expect(checkoutBase).toBeDefined();
      const squashCall = gitCalls.find(c => c[0] === 'merge' && c.includes('--squash') && c.includes('plan/feature'));
      expect(squashCall).toBeDefined();
      const commitCall = gitCalls.find(c => c[0] === 'commit' && c.includes('-m'));
      expect(commitCall).toBeDefined();
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
      const executor = new TaskExecutor({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.approveMerge('wf-1')).rejects.toThrow('no merge configured');
    });

    it('github merge path logs PR URL to console', async () => {
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
          mergeMode: 'github',
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
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

    it('github merge path calls consolidateAndMerge exactly once', async () => {
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
          mergeMode: 'github',
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        mergeGateProvider: mergeGateProvider as any,
      });

      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
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
        'none', 'master', 'plan/feature', 'wf-1', 'Test Workflow', ['t1'],
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
      };
      const executor = new TaskExecutor({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/55');

      const logSpy = vi.spyOn(console, 'log');

      await executor.approveMerge('wf-1');

      // Should push + create PR
      expect((executor as any).execPr).toHaveBeenCalledWith('master', 'plan/feature', 'Test Workflow');

      // Should persist the PR URL on the merge task
      expect(persistence.updateTask).toHaveBeenCalledWith(
        '__merge__wf-1',
        expect.objectContaining({
          execution: { prUrl: 'https://github.com/owner/repo/pull/55' },
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        callbacks: { onComplete },
      });

      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
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
            prUrl: 'https://github.com/owner/repo/pull/77',
          }),
        }),
      );

      // Should complete successfully
      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push(args);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged-commit-hash';
        return '';
      };

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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      let mergeCount = 0;
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT (content)');
        }
        return '';
      };

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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const result = await executor.mergeExperimentBranches('pivot-reconciliation', ['pivot-exp-v1']);

      expect(result.branch).toBe('experiment/pivot-exp-v1-hash1');
      expect(result.commit).toBe('single-commit');
    });
  });

  describe('consolidateAndMerge', () => {
    it('only merges leaf branches (merge gate deps), not intermediate', async () => {
      const tasks = new Map<string, TaskState>();
      // Diamond: A -> B, C -> D. Merge gate depends on [D]
      tasks.set('A', makeTask({ id: 'A', status: 'completed', config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/A' } }));
      tasks.set('B', makeTask({ id: 'B', status: 'completed', config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/B' } }));
      tasks.set('C', makeTask({ id: 'C', status: 'completed', config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/C' } }));
      tasks.set('D', makeTask({ id: 'D', status: 'completed', config: { workflowId: 'wf-1' }, execution: { branch: 'invoker/D' } }));
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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-1', name: 'Test' }), updateTask: vi.fn() } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [], getMergeGateFamiliar: () => ({ type: 'local' }) } as any,
        cwd: '/tmp',
      });

      const mergedBranches: string[] = [];
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };

      await executor.executeTask(tasks.get('__merge__wf-1')!);

      // Only D's branch should be merged, not A, B, or C
      expect(mergedBranches).toContain('invoker/D');
      expect(mergedBranches).not.toContain('invoker/A');
      expect(mergedBranches).not.toContain('invoker/B');
      expect(mergedBranches).not.toContain('invoker/C');
    });

    it('forked leaves: merges only leaf branches from merge gate deps', async () => {
      const tasks = new Map<string, TaskState>();
      // A -> B -> D, A -> C -> E. Merge gate depends on [D, E]
      tasks.set('A', makeTask({ id: 'A', status: 'completed', config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/A' } }));
      tasks.set('B', makeTask({ id: 'B', status: 'completed', config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/B' } }));
      tasks.set('C', makeTask({ id: 'C', status: 'completed', config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/C' } }));
      tasks.set('D', makeTask({ id: 'D', status: 'completed', config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/D' } }));
      tasks.set('E', makeTask({ id: 'E', status: 'completed', config: { workflowId: 'wf-2' }, execution: { branch: 'invoker/E' } }));
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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-2', name: 'Test' }), updateTask: vi.fn() } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [], getMergeGateFamiliar: () => ({ type: 'local' }) } as any,
        cwd: '/tmp',
      });

      const mergedBranches: string[] = [];
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergedBranches.push(args[args.length - 1]);
          return '';
        }
        if (args[0] === 'branch' && args[1] === '-D') return '';
        return '';
      };

      await executor.executeTask(tasks.get('__merge__wf-2')!);

      // Only D and E (leaf deps) should be merged
      expect(mergedBranches).toContain('invoker/D');
      expect(mergedBranches).toContain('invoker/E');
      expect(mergedBranches).not.toContain('invoker/A');
      expect(mergedBranches).not.toContain('invoker/B');
      expect(mergedBranches).not.toContain('invoker/C');
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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-3', name: 'Test' }), updateTask: vi.fn() } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [], getMergeGateFamiliar: () => ({ type: 'local' }) } as any,
        cwd: '/tmp',
      });

      const mergeOrder: string[] = [];
      (executor as any).execGit = async (args: string[]) => {
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

      await executor.executeTask(tasks.get('__merge__wf-3')!);

      // Branches should be merged in sorted order
      expect(mergeOrder).toEqual(['invoker/a-task', 'invoker/m-task', 'invoker/z-task']);
    });

    it('approveMerge aborts and restores branch on merge failure', async () => {
      const executor = new TaskExecutor({
        orchestrator: { getTask: () => undefined } as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', baseBranch: 'master', featureBranch: 'feature/test', name: 'Test' }), updateTask: vi.fn() } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const calls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        calls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'original-branch';
        if (args[0] === 'merge' && args.includes('--squash')) throw new Error('CONFLICT');
        return '';
      };

      await expect(executor.approveMerge('wf-test')).rejects.toThrow('CONFLICT');

      // Should have attempted merge --abort and checkout back to original (no rebase)
      const rebaseAbort = calls.find(c => c[0] === 'rebase' && c[1] === '--abort');
      const mergeAbort = calls.find(c => c[0] === 'merge' && c[1] === '--abort');
      const restoreCall = calls.find(c => c[0] === 'checkout' && c[1] === 'original-branch');
      expect(rebaseAbort).toBeUndefined();
      expect(mergeAbort).toBeDefined();
      expect(restoreCall).toBeDefined();
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const calls: string[][] = [];
      let mergeCount = 0;
      (executor as any).execGit = async (args: string[]) => {
        calls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT (content)');
        }
        if (args[0] === 'rev-parse') return 'abc123';
        return '';
      };

      await expect(executor.mergeExperimentBranches('recon', ['exp-1', 'exp-2'])).rejects.toThrow('CONFLICT');

      const abortCall = calls.find(c => c[0] === 'merge' && c[1] === '--abort');
      const restoreCall = calls.find(c => c[0] === 'checkout' && c[1] === 'master');
      expect(abortCall).toBeDefined();
      expect(restoreCall).toBeDefined();
    });

    it('3 experiments: conflict at 2nd identifies which failed', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('exp-a', makeTask({ id: 'exp-a', status: 'completed', execution: { branch: 'experiment/exp-a' } }));
      tasks.set('exp-b', makeTask({ id: 'exp-b', status: 'completed', execution: { branch: 'experiment/exp-b' } }));
      tasks.set('exp-c', makeTask({ id: 'exp-c', status: 'completed', execution: { branch: 'experiment/exp-c' } }));
      tasks.set('recon', makeTask({ id: 'recon', config: { isReconciliation: true, parentTask: 'parent' } }));
      tasks.set('parent', makeTask({ id: 'parent', status: 'completed', execution: { branch: 'experiment/parent' } }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => null } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      let mergeCount = 0;
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          mergeCount++;
          if (mergeCount === 2) throw new Error('CONFLICT merging exp-b branch');
        }
        if (args[0] === 'rev-parse') return 'abc123';
        return '';
      };

      // The first merge (exp-a) succeeds, second (exp-b) fails, third (exp-c) is never attempted
      await expect(executor.mergeExperimentBranches('recon', ['exp-a', 'exp-b', 'exp-c'])).rejects.toThrow('CONFLICT');
      // exp-c's merge should not have been attempted
      expect(mergeCount).toBe(2);
    });
  });

  describe('resolveConflictWithClaude', () => {
    it('throws for non-failed task', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('running-task', makeTask({
        id: 'running-task',
        status: 'running',
      }));

      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflictWithClaude('running-task'))
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
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflictWithClaude('failed-task'))
        .rejects.toThrow('does not have merge conflict information');
    });

    it('throws for nonexistent task', async () => {
      const orchestrator = { getTask: () => undefined };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      await expect(executor.resolveConflictWithClaude('nonexistent'))
        .rejects.toThrow('not found');
    });

    it('re-creates merge state and runs git operations', async () => {
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
          workspacePath: '/tmp/workspace',
        },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
      };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push([...args]);
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };

      await executor.resolveConflictWithClaude('conflict-task');

      // Should have checked out the task branch
      const checkoutCall = gitCalls.find(c => c[0] === 'checkout' && c[1] === 'invoker/conflict-task');
      expect(checkoutCall).toBeDefined();

      // Should have attempted to merge the conflicting branch
      const mergeCall = gitCalls.find(c => c[0] === 'merge' && c.includes('invoker/dep-task'));
      expect(mergeCall).toBeDefined();
    });
  });

  describe('fixWithClaude', () => {
    it('throws for nonexistent task', async () => {
      const orchestrator = { getTask: () => undefined };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      await expect(executor.fixWithClaude('nonexistent', 'output')).rejects.toThrow('not found');
    });

    it('throws for non-failed/non-running task', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('pending-task', makeTask({
        id: 'pending-task',
        status: 'pending',
        config: { command: 'npm test' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      await expect(executor.fixWithClaude('pending-task', 'output')).rejects.toThrow('not in a fixable state');
    });

    it('appends Claude output to task output', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('fix-task', makeTask({
        id: 'fix-task',
        status: 'failed',
        config: { command: 'npm test' },
        execution: { branch: 'invoker/fix-task', workspacePath: '/tmp/workspace' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const appendTaskOutput = vi.fn();
      const updateTask = vi.fn();
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput, updateTask } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      (executor as any).spawnClaudeFix = async () => ({ stdout: 'Fixed the import', sessionId: 'test-session-123' });
      await executor.fixWithClaude('fix-task', 'error output here');
      expect(appendTaskOutput).toHaveBeenCalledWith('fix-task', expect.stringContaining('Fixed the import'));
    });

    it('persists claudeSessionId after fix', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('fix-task', makeTask({
        id: 'fix-task',
        status: 'failed',
        config: { command: 'npm test' },
        execution: { branch: 'invoker/fix-task', workspacePath: '/tmp/workspace' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const appendTaskOutput = vi.fn();
      const updateTask = vi.fn();
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput, updateTask } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });
      (executor as any).spawnClaudeFix = async () => ({ stdout: 'Fixed it', sessionId: 'sess-abc-123' });
      await executor.fixWithClaude('fix-task', 'error output');
      expect(updateTask).toHaveBeenCalledWith('fix-task', { execution: { claudeSessionId: 'sess-abc-123' } });
    });

    it('does not perform any git checkout', async () => {
      const tasks = new Map<string, TaskState>();
      tasks.set('fix-task', makeTask({
        id: 'fix-task',
        status: 'failed',
        config: { command: 'npm test' },
        execution: { branch: 'invoker/fix-task' },
      }));
      const orchestrator = { getTask: (id: string) => tasks.get(id) };
      const appendTaskOutput = vi.fn();
      const updateTask = vi.fn();
      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { appendTaskOutput, updateTask } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp/repo',
      });
      const gitCalls: string[][] = [];
      (executor as any).execGit = async (args: string[]) => {
        gitCalls.push([...args]);
        return '';
      };
      (executor as any).spawnClaudeFix = async () => ({ stdout: '', sessionId: 'sess-xyz' });
      await executor.fixWithClaude('fix-task', 'error output');
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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: { loadWorkflow: () => ({ onFinish: 'merge', mergeMode: 'automatic', baseBranch: 'master', featureBranch: 'feature/wf-msg', name: 'Test' }), updateTask: vi.fn() } as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [], getMergeGateFamiliar: () => ({ type: 'local' }) } as any,
        cwd: '/tmp',
      });

      const mergeMsgs: string[] = [];
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };

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

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        defaultBranch: 'master',
      });

      const mergeMsgs: string[] = [];
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'merged-hash';
        if (args[0] === 'merge' && args[1] === '--no-ff') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };

      await executor.mergeExperimentBranches('recon', ['exp-v1', 'exp-v2']);

      expect(mergeMsgs).toHaveLength(2);
      expect(mergeMsgs[0]).toContain('experiment/exp-v1-abc');
      expect(mergeMsgs[0]).toContain('Use Redis for caching');
      expect(mergeMsgs[1]).toContain('experiment/exp-v2-def');
      expect(mergeMsgs[1]).toContain('Use Memcached for caching');
    });

    it('resolveConflictWithClaude includes dep description in merge -m', async () => {
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
          workspacePath: '/tmp/workspace',
        },
      }));

      const orchestrator = {
        getTask: (id: string) => tasks.get(id),
        getAllTasks: () => Array.from(tasks.values()),
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: {} as any,
        familiarRegistry: { getDefault: () => ({ type: 'local' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const mergeMsgs: string[] = [];
      (executor as any).execGit = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'merge') {
          const mIdx = args.indexOf('-m');
          if (mIdx !== -1) mergeMsgs.push(args[mIdx + 1]);
        }
        return '';
      };

      await executor.resolveConflictWithClaude('conflict-task');

      expect(mergeMsgs).toHaveLength(1);
      expect(mergeMsgs[0]).toContain('invoker/dep-task');
      expect(mergeMsgs[0]).toContain('Add typing indicator support');
    });
  });
});
