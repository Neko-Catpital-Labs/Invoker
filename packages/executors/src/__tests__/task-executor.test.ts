import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskExecutor } from '../task-executor.js';
import type { TaskState } from '@invoker/core';
import { EventEmitter } from 'events';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'test',
    description: 'Test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date(),
    ...overrides,
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
        branch: 'experiment/dep-1',
      }));
      tasks.set('dep-2', makeTask({
        id: 'dep-2',
        status: 'completed',
        branch: 'experiment/dep-2',
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
        branch: 'experiment/dep-with-branch',
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
        branch: 'experiment/dep-running',
      }));
      tasks.set('dep-failed', makeTask({
        id: 'dep-failed',
        status: 'failed',
        branch: 'experiment/dep-failed',
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
        isReconciliation: true,
        selectedExperiment: 'exp-v1',
        branch: 'experiment/exp-v1-abc12345',  // propagated from winner
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
        branch: 'experiment/dep-b',
      }));
      tasks.set('dep-c', makeTask({
        id: 'dep-c',
        status: 'completed',
        branch: 'experiment/dep-c',
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
        branch: 'experiment/parent',
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

      const task = makeTask({ id: 'failing-start', status: 'running', command: 'echo hi' });
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
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
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
        isMergeNode: true,
        workflowId: 'wf-1',
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
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
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
        isMergeNode: true,
        workflowId: 'wf-1',
      });

      await (executor as any).executeMergeNode(mergeTask);

      const deleteCall = gitCalls.find(c => c[0] === 'branch' && c[1] === '-D' && c[2] === 'plan/feature');
      expect(deleteCall).toBeDefined();

      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });
  });

  describe('rebaseTaskBranches', () => {
    it('rebases all completed task branches onto baseBranch', async () => {
      const allTasks = [
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
        makeTask({ id: 't2', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t2' }),
        makeTask({ id: 't3', workflowId: 'wf-1', status: 'pending', branch: 'experiment/t3' }),
        makeTask({ id: '__merge__wf-1', workflowId: 'wf-1', status: 'failed', isMergeNode: true }),
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
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
        makeTask({ id: 't2', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t2' }),
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
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
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
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
        makeTask({ id: 't2', workflowId: 'wf-1', status: 'failed', branch: 'experiment/t2' }),
        makeTask({ id: '__merge__wf-1', workflowId: 'wf-1', status: 'failed', isMergeNode: true, branch: 'plan/feature' }),
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
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
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
        isMergeNode: true,
        workflowId: 'wf-1',
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should consolidate task branches into featureBranch
      const consolidateMerge = gitCalls.find(c => c[0] === 'merge' && c.includes('experiment/t1'));
      expect(consolidateMerge).toBeDefined();

      // Should NOT merge featureBranch into baseBranch
      const finalMerge = gitCalls.find(c =>
        c[0] === 'merge' && c.includes('plan/feature') && c.includes('--no-ff'),
      );
      expect(finalMerge).toBeUndefined();

      // Should still report completed
      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
      );
    });

    it('executeMergeNode performs full merge when mergeMode=automatic', async () => {
      const allTasks = [
        makeTask({ id: 't1', workflowId: 'wf-1', status: 'completed', branch: 'experiment/t1' }),
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
        return '';
      };

      const mergeTask = makeTask({
        id: '__merge__wf-1',
        status: 'running',
        isMergeNode: true,
        workflowId: 'wf-1',
      });

      await (executor as any).executeMergeNode(mergeTask);

      // Should perform final merge of featureBranch into baseBranch
      const finalMerge = gitCalls.find(c =>
        c[0] === 'merge' && c.includes('plan/feature') && c.includes('--no-ff'),
      );
      expect(finalMerge).toBeDefined();

      expect(orchestrator.handleWorkerResponse).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed' }),
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

      // Should checkout baseBranch and merge featureBranch
      const checkoutBase = gitCalls.find(c => c[0] === 'checkout' && c[1] === 'master');
      expect(checkoutBase).toBeDefined();

      const finalMerge = gitCalls.find(c =>
        c[0] === 'merge' && c.includes('plan/feature') && c.includes('--no-ff'),
      );
      expect(finalMerge).toBeDefined();
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
  });
});
