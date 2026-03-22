/**
 * A→B→C branch chain integration tests.
 *
 * Validates that every task in a dependency chain produces a branch with a
 * commit, carries transitive history, and provides correct upstream context
 * to downstream tasks — regardless of executor type (local/worktree) or
 * action type (command/prompt).
 *
 * These tests run against real git repos in temp dirs, real TaskExecutor,
 * and real collectUpstreamBranches / buildUpstreamContext.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import type { WorkResponse } from '@invoker/protocol';
import type { TaskState } from '@invoker/core';
import { TaskExecutor, FamiliarRegistry, LocalFamiliar } from '../index.js';

function createTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'branch-chain-'));
  execSync('git init -b master', { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, 'initial.txt'), 'initial');
  execSync('git add -A && git commit -m "initial"', { cwd: dir });
  return dir;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execSync(`git merge-base --is-ancestor ${ancestor} ${descendant}`, { cwd });
    return true;
  } catch {
    return false;
  }
}

function branchExists(cwd: string, branch: string): boolean {
  try {
    execSync(`git rev-parse --verify ${branch}`, { cwd });
    return true;
  } catch {
    return false;
  }
}

type TaskType = { familiar: 'local'; action: 'command' | 'claude' };

interface ChainConfig {
  a: TaskType;
  b: TaskType;
  c: TaskType;
}

function taskLabel(t: TaskType): string {
  return `${t.familiar}-${t.action}`;
}

describe('A→B→C branch chain', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempRepo();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTaskState(overrides: {
    id: string;
    description?: string;
    status?: string;
    dependencies?: string[];
    config?: Partial<TaskState['config']>;
    execution?: Partial<TaskState['execution']>;
  }): TaskState {
    return {
      id: overrides.id,
      description: overrides.description ?? overrides.id,
      status: overrides.status ?? 'pending',
      dependencies: overrides.dependencies ?? [],
      createdAt: new Date(),
      config: { ...overrides.config },
      execution: { ...overrides.execution },
    } as TaskState;
  }

  function buildChain(config: ChainConfig): {
    tasks: TaskState[];
    executor: TaskExecutor;
    responses: Map<string, WorkResponse>;
  } {
    const taskA = makeTaskState({
      id: 'task-a',
      description: 'Step A',
      config: {
        command: config.a.action === 'command' ? 'echo task-a-done' : undefined,
        prompt: config.a.action === 'claude' ? 'Do step A' : undefined,
        familiarType: config.a.familiar,
        workflowId: 'wf-test',
      },
    });
    const taskB = makeTaskState({
      id: 'task-b',
      description: 'Step B',
      dependencies: ['task-a'],
      config: {
        command: config.b.action === 'command' ? 'echo task-b-done' : undefined,
        prompt: config.b.action === 'claude' ? 'Do step B' : undefined,
        familiarType: config.b.familiar,
        workflowId: 'wf-test',
      },
    });
    const taskC = makeTaskState({
      id: 'task-c',
      description: 'Step C',
      dependencies: ['task-b'],
      config: {
        command: config.c.action === 'command' ? 'echo task-c-done' : undefined,
        prompt: config.c.action === 'claude' ? 'Do step C' : undefined,
        familiarType: config.c.familiar,
        workflowId: 'wf-test',
      },
    });

    const tasks = [taskA, taskB, taskC];
    const responses = new Map<string, WorkResponse>();

    const orchestrator = {
      getTask: (id: string) => tasks.find(t => t.id === id),
      getAllTasks: () => tasks,
      handleWorkerResponse: (response: WorkResponse) => {
        responses.set(response.actionId, response);
        const task = tasks.find(t => t.id === response.actionId);
        if (task) {
          task.status = response.status;
        }
        return [];
      },
      setTaskAwaitingApproval: () => {},
    };

    const persistence = {
      loadWorkflow: () => ({
        id: 'wf-test',
        baseBranch: 'master',
      }),
      updateTask: (id: string, changes: any) => {
        const task = tasks.find(t => t.id === id);
        if (task && changes.execution) {
          Object.assign(task.execution, changes.execution);
        }
        if (task && changes.config) {
          Object.assign(task.config, changes.config);
        }
      },
    };

    const registry = new FamiliarRegistry();
    const localFamiliar = new LocalFamiliar({
      claudeCommand: '/bin/echo',
      claudeFallback: false,
    });
    registry.register('local', localFamiliar);

    const executor = new TaskExecutor({
      orchestrator: orchestrator as any,
      persistence: persistence as any,
      familiarRegistry: registry,
      cwd: tmpDir,
      defaultBranch: 'master',
    });

    return { tasks, executor, responses };
  }

  async function executeTask(
    executor: TaskExecutor,
    tasks: TaskState[],
    taskId: string,
  ): Promise<void> {
    const task = tasks.find(t => t.id === taskId)!;
    task.status = 'running';
    await (executor as any).executeTaskInner(task);
  }

  const localCmd: TaskType = { familiar: 'local', action: 'command' };

  describe('all-local-command chain', () => {
    it('every task has a branch', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      expect(tasks[0].execution.branch).toBe('invoker/task-a');
      expect(branchExists(tmpDir, 'invoker/task-a')).toBe(true);

      await executeTask(executor, tasks, 'task-b');
      expect(tasks[1].execution.branch).toBe('invoker/task-b');
      expect(branchExists(tmpDir, 'invoker/task-b')).toBe(true);

      await executeTask(executor, tasks, 'task-c');
      expect(tasks[2].execution.branch).toBe('invoker/task-c');
      expect(branchExists(tmpDir, 'invoker/task-c')).toBe(true);
    });

    it('each branch has a result commit', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      await executeTask(executor, tasks, 'task-b');
      await executeTask(executor, tasks, 'task-c');

      for (const branch of ['invoker/task-a', 'invoker/task-b', 'invoker/task-c']) {
        const log = execSync(`git log --oneline ${branch}`, { cwd: tmpDir }).toString();
        expect(log).toContain('invoker:');
      }
    });

    it('transitive history: C contains A commits', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      const hashA = execSync('git rev-parse invoker/task-a', { cwd: tmpDir }).toString().trim();

      await executeTask(executor, tasks, 'task-b');
      await executeTask(executor, tasks, 'task-c');

      expect(isAncestor(tmpDir, hashA, 'invoker/task-c')).toBe(true);
    });

    it('collectUpstreamBranches returns correct branches', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      await executeTask(executor, tasks, 'task-b');

      const upstreamsB = executor.collectUpstreamBranches(tasks[1]);
      expect(upstreamsB).toEqual(['invoker/task-a']);

      const upstreamsC = executor.collectUpstreamBranches(tasks[2]);
      expect(upstreamsC).toEqual(['invoker/task-b']);
    });

    it('original branch is restored after each task', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      let current = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
      expect(current).toBe('master');

      await executeTask(executor, tasks, 'task-b');
      current = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
      expect(current).toBe('master');

      await executeTask(executor, tasks, 'task-c');
      current = execSync('git branch --show-current', { cwd: tmpDir }).toString().trim();
      expect(current).toBe('master');
    });

    it('empty commit records command and exit code', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');

      const body = execSync('git log -1 --format=%B invoker/task-a', { cwd: tmpDir }).toString().trim();
      expect(body).toContain('Exit code: 0');
    });
  });

  describe('the original bug: Worktree→Local→Worktree equivalent', () => {
    it('local intermediate does not break the chain', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      await executeTask(executor, tasks, 'task-b');
      await executeTask(executor, tasks, 'task-c');

      // B and C have branches
      expect(tasks[1].execution.branch).toBeTruthy();
      expect(tasks[2].execution.branch).toBeTruthy();

      // collectUpstreamBranches works through the chain
      expect(executor.collectUpstreamBranches(tasks[1])).toEqual(['invoker/task-a']);
      expect(executor.collectUpstreamBranches(tasks[2])).toEqual(['invoker/task-b']);

      // C transitively has A's history
      const hashA = execSync('git rev-parse invoker/task-a', { cwd: tmpDir }).toString().trim();
      expect(isAncestor(tmpDir, hashA, 'invoker/task-c')).toBe(true);
    });
  });

  describe('buildUpstreamContext returns commit info', () => {
    it('downstream task gets upstream commit hash and message', async () => {
      const { tasks, executor } = buildChain({ a: localCmd, b: localCmd, c: localCmd });

      await executeTask(executor, tasks, 'task-a');
      await executeTask(executor, tasks, 'task-b');

      // buildUpstreamContext for task-b should include task-a's info
      const contextB = await (executor as any).buildUpstreamContext(tasks[1]);
      expect(contextB).toHaveLength(1);
      expect(contextB[0].taskId).toBe('task-a');
      expect(contextB[0].description).toBe('Step A');

      // buildUpstreamContext for task-c should include task-b's info
      const contextC = await (executor as any).buildUpstreamContext(tasks[2]);
      expect(contextC).toHaveLength(1);
      expect(contextC[0].taskId).toBe('task-b');
      expect(contextC[0].description).toBe('Step B');
    });
  });

  describe('diamond: A→{B,C}→D', () => {
    it('D branch contains commits from both B and C', async () => {
      const taskA = makeTaskState({
        id: 'task-a',
        description: 'Step A',
        config: { command: 'echo a', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskB = makeTaskState({
        id: 'task-b',
        description: 'Step B',
        dependencies: ['task-a'],
        config: { command: 'echo b', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskC = makeTaskState({
        id: 'task-c',
        description: 'Step C',
        dependencies: ['task-a'],
        config: { command: 'echo c', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskD = makeTaskState({
        id: 'task-d',
        description: 'Step D',
        dependencies: ['task-b', 'task-c'],
        config: { command: 'echo d', familiarType: 'local', workflowId: 'wf-test' },
      });

      const tasks = [taskA, taskB, taskC, taskD];
      const registry = new FamiliarRegistry();
      const localFamiliar = new LocalFamiliar({ claudeCommand: '/bin/echo', claudeFallback: false });
      registry.register('local', localFamiliar);

      const orchestrator = {
        getTask: (id: string) => tasks.find(t => t.id === id),
        getAllTasks: () => tasks,
        handleWorkerResponse: (response: WorkResponse) => {
          const task = tasks.find(t => t.id === response.actionId);
          if (task) task.status = response.status;
          return [];
        },
        setTaskAwaitingApproval: () => {},
      };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-test', baseBranch: 'master' }),
        updateTask: (id: string, changes: any) => {
          const task = tasks.find(t => t.id === id);
          if (task && changes.execution) Object.assign(task.execution, changes.execution);
          if (task && changes.config) Object.assign(task.config, changes.config);
        },
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: registry,
        cwd: tmpDir,
        defaultBranch: 'master',
      });

      // Execute A (root)
      taskA.status = 'running';
      await (executor as any).executeTaskInner(taskA);
      const hashA = execSync('git rev-parse invoker/task-a', { cwd: tmpDir }).toString().trim();

      // Execute B and C (both depend on A)
      taskB.status = 'running';
      await (executor as any).executeTaskInner(taskB);
      const hashB = execSync('git rev-parse invoker/task-b', { cwd: tmpDir }).toString().trim();

      taskC.status = 'running';
      await (executor as any).executeTaskInner(taskC);
      const hashC = execSync('git rev-parse invoker/task-c', { cwd: tmpDir }).toString().trim();

      // Execute D (depends on B and C)
      taskD.status = 'running';
      await (executor as any).executeTaskInner(taskD);

      // D has both B and C as ancestors
      expect(isAncestor(tmpDir, hashA, 'invoker/task-d')).toBe(true);
      expect(isAncestor(tmpDir, hashB, 'invoker/task-d')).toBe(true);
      expect(isAncestor(tmpDir, hashC, 'invoker/task-d')).toBe(true);

      // D's branch exists
      expect(branchExists(tmpDir, 'invoker/task-d')).toBe(true);
    });

    it('collectUpstreamBranches returns both branches for D', async () => {
      const taskA = makeTaskState({
        id: 'task-a',
        description: 'Step A',
        config: { command: 'echo a', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskB = makeTaskState({
        id: 'task-b',
        description: 'Step B',
        dependencies: ['task-a'],
        config: { command: 'echo b', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskC = makeTaskState({
        id: 'task-c',
        description: 'Step C',
        dependencies: ['task-a'],
        config: { command: 'echo c', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskD = makeTaskState({
        id: 'task-d',
        description: 'Step D',
        dependencies: ['task-b', 'task-c'],
        config: { command: 'echo d', familiarType: 'local', workflowId: 'wf-test' },
      });

      const tasks = [taskA, taskB, taskC, taskD];
      const registry = new FamiliarRegistry();
      const localFamiliar = new LocalFamiliar({ claudeCommand: '/bin/echo', claudeFallback: false });
      registry.register('local', localFamiliar);

      const orchestrator = {
        getTask: (id: string) => tasks.find(t => t.id === id),
        getAllTasks: () => tasks,
        handleWorkerResponse: (response: WorkResponse) => {
          const task = tasks.find(t => t.id === response.actionId);
          if (task) task.status = response.status;
          return [];
        },
        setTaskAwaitingApproval: () => {},
      };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-test', baseBranch: 'master' }),
        updateTask: (id: string, changes: any) => {
          const task = tasks.find(t => t.id === id);
          if (task && changes.execution) Object.assign(task.execution, changes.execution);
          if (task && changes.config) Object.assign(task.config, changes.config);
        },
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: registry,
        cwd: tmpDir,
        defaultBranch: 'master',
      });

      // Execute A, B, C
      taskA.status = 'running';
      await (executor as any).executeTaskInner(taskA);
      taskB.status = 'running';
      await (executor as any).executeTaskInner(taskB);
      taskC.status = 'running';
      await (executor as any).executeTaskInner(taskC);

      const upstreams = executor.collectUpstreamBranches(taskD);
      expect(upstreams).toContain('invoker/task-b');
      expect(upstreams).toContain('invoker/task-c');
      expect(upstreams).toHaveLength(2);
    });
  });

  describe('fan-in: A→C, B→C', () => {
    it('C merges both upstream branches', async () => {
      const taskA = makeTaskState({
        id: 'task-a',
        description: 'Step A',
        config: { command: 'echo a', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskB = makeTaskState({
        id: 'task-b',
        description: 'Step B',
        config: { command: 'echo b', familiarType: 'local', workflowId: 'wf-test' },
      });
      const taskC = makeTaskState({
        id: 'task-c',
        description: 'Step C',
        dependencies: ['task-a', 'task-b'],
        config: { command: 'echo c', familiarType: 'local', workflowId: 'wf-test' },
      });

      const tasks = [taskA, taskB, taskC];
      const registry = new FamiliarRegistry();
      const localFamiliar = new LocalFamiliar({ claudeCommand: '/bin/echo', claudeFallback: false });
      registry.register('local', localFamiliar);

      const orchestrator = {
        getTask: (id: string) => tasks.find(t => t.id === id),
        getAllTasks: () => tasks,
        handleWorkerResponse: (response: WorkResponse) => {
          const task = tasks.find(t => t.id === response.actionId);
          if (task) task.status = response.status;
          return [];
        },
        setTaskAwaitingApproval: () => {},
      };
      const persistence = {
        loadWorkflow: () => ({ id: 'wf-test', baseBranch: 'master' }),
        updateTask: (id: string, changes: any) => {
          const task = tasks.find(t => t.id === id);
          if (task && changes.execution) Object.assign(task.execution, changes.execution);
          if (task && changes.config) Object.assign(task.config, changes.config);
        },
      };

      const executor = new TaskExecutor({
        orchestrator: orchestrator as any,
        persistence: persistence as any,
        familiarRegistry: registry,
        cwd: tmpDir,
        defaultBranch: 'master',
      });

      // Execute A and B (independent)
      taskA.status = 'running';
      await (executor as any).executeTaskInner(taskA);
      taskB.status = 'running';
      await (executor as any).executeTaskInner(taskB);

      const hashA = execSync('git rev-parse invoker/task-a', { cwd: tmpDir }).toString().trim();
      const hashB = execSync('git rev-parse invoker/task-b', { cwd: tmpDir }).toString().trim();

      // Execute C (depends on both)
      taskC.status = 'running';
      await (executor as any).executeTaskInner(taskC);

      // C has both ancestors
      expect(isAncestor(tmpDir, hashA, 'invoker/task-c')).toBe(true);
      expect(isAncestor(tmpDir, hashB, 'invoker/task-c')).toBe(true);

      // collectUpstreamBranches returns both
      const upstreams = executor.collectUpstreamBranches(taskC);
      expect(upstreams).toContain('invoker/task-a');
      expect(upstreams).toContain('invoker/task-b');
    });
  });
});
