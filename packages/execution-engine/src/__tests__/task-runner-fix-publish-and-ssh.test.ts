import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRunner } from '../task-runner.js';
import { collectDirectNonMergeTaskIds } from '../merge-runner.js';
import { getCurrentRequiredReviewArtifacts } from '../task-runner-review-gate.js';
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
const originalGithubTargetRepo = process.env.INVOKER_GITHUB_TARGET_REPO;
function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-task-executor-test-'));
  tempWorkspaces.push(dir);
  return dir;
}

afterEach(() => {
  if (originalGithubTargetRepo === undefined) {
    delete process.env.INVOKER_GITHUB_TARGET_REPO;
  } else {
    process.env.INVOKER_GITHUB_TARGET_REPO = originalGithubTargetRepo;
  }
  while (tempWorkspaces.length > 0) {
    const dir = tempWorkspaces.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('TaskRunner', () => {

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

    it('passes explicit executionModel to spawnAgentFix over task model', async () => {
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
        config: { executionAgent: 'codex', executionModel: 'gpt-5.2' },
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
        persistence: { logEvent: vi.fn() } as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      (executor as any).execGitIn = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        if (args[0] === 'checkout') return '';
        if (args[0] === 'merge') throw new Error('conflict');
        return '';
      };
      let capturedModel: string | undefined;
      (executor as any).spawnAgentFix = async (
        _prompt: string,
        _cwd: string,
        _agent?: string,
        executionModel?: string,
      ) => {
        capturedModel = executionModel;
        return { stdout: '', sessionId: 'sess-conflict-model' };
      };

      await executor.resolveConflict('conflict-task', undefined, 'codex', 'gpt-5-mini');
      expect(capturedModel).toBe('gpt-5-mini');
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
          agentName: 'codex',
          lastAgentName: 'codex',
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
        const autoStartExternallyUnblockedReadyTasksMock = vi.fn(() => []);
        const orchestrator = {
          getTask: (id: string) => allTasks.find(t => t.id === id),
          getAllTasks: () => allTasks,
          setTaskReviewReady,
          autoStartExternallyUnblockedReadyTasks: autoStartExternallyUnblockedReadyTasksMock,
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
          expect.objectContaining({ selectedAttemptId: 'merge-attempt-1', generation: 7 }),
        );
        expect(autoStartExternallyUnblockedReadyTasksMock).toHaveBeenCalled();
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
    it.skip('retries approved-fix publish when SSH capacity is full', async () => {
      vi.useFakeTimers();
      const publishSpy = vi.spyOn(SshExecutor.prototype, 'publishApprovedFix').mockResolvedValue({
        commitHash: 'queued123',
      });
      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const logEvent = vi.fn();
      const task = makeTask({
        id: 'ssh-fix-task-capacity',
        description: 'Apply approved fix after SSH capacity frees up',
        config: {
          runnerKind: 'ssh',
          poolMemberId: 'remote-1',
          command: 'bash -lc false',
        },
        execution: {
          workspacePath: '/remote/worktree',
          branch: 'experiment/ssh-fix-gap',
          selectedAttemptId: 'attempt-ssh-capacity-1',
        },
      });
      const tasks = new Map<string, TaskState>([[task.id, task]]);
      const executorRegistry = {
        getDefault: () => ({ type: 'worktree' }),
        get: () => null,
        register: () => {},
        getAll: () => [],
      };
      const runner = new TaskRunner({
        orchestrator: { getTask: (id: string) => tasks.get(id) } as any,
        persistence: { updateTask, updateAttempt, logEvent } as any,
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
      const selectExecutorSpy = vi.spyOn(runner, 'selectExecutor');
      const originalSelectExecutor = TaskRunner.prototype.selectExecutor.bind(runner);
      selectExecutorSpy.mockImplementationOnce(() => {
        throw new ResourceLimitError('Execution pool "pnpm-ssh" has no member capacity available');
      });
      selectExecutorSpy.mockImplementation((selectedTask, excludedPoolMemberKeys = new Set()) =>
        originalSelectExecutor(selectedTask, excludedPoolMemberKeys)
      );

      const publishPromise = runner.publishApprovedFix(task);
      await vi.advanceTimersByTimeAsync(15_000);
      await publishPromise;

      expect(logEvent).toHaveBeenCalledWith(task.id, 'task.approved_fix_waiting', expect.objectContaining({
        attempts: 1,
        message: 'Execution pool "pnpm-ssh" has no member capacity available',
      }));
      expect(publishSpy).toHaveBeenCalledWith(
        '/remote/worktree',
        expect.objectContaining({ actionId: task.id }),
        'experiment/ssh-fix-gap',
      );
      expect(updateTask).toHaveBeenCalledWith(task.id, {
        execution: { commit: 'queued123' },
      });
      expect(updateAttempt).toHaveBeenCalledWith('attempt-ssh-capacity-1', {
        branch: 'experiment/ssh-fix-gap',
        commit: 'queued123',
      });
      vi.useRealTimers();
    });

    it('pins SSH approved-fix publish to the recorded pool member in mixed pools', async () => {
      const publishSpy = vi.spyOn(SshExecutor.prototype, 'publishApprovedFix').mockResolvedValue({
        commitHash: 'def5678',
      });
      const worktreePublish = vi.fn().mockResolvedValue({
        error: 'local worktree publish should not be used for an SSH workspace',
      });
      const worktreeExecutor = {
        type: 'worktree',
        publishApprovedFix: worktreePublish,
      };

      const task = makeTask({
        id: 'mixed-pool-ssh-fix-task',
        description: 'Apply approved fix over the recorded SSH pool member',
        config: {
          runnerKind: 'ssh',
          poolId: 'mixed-local-ssh',
          poolMemberId: 'remote-1',
          command: 'bash -lc false',
        },
        execution: {
          workspacePath: '~/.invoker/worktrees/task-a',
          branch: 'experiment/mixed-pool-ssh-fix-gap',
          selectedAttemptId: 'attempt-mixed-ssh-1',
        },
      });
      const tasks = new Map<string, TaskState>([['mixed-pool-ssh-fix-task', task]]);
      const updateTask = vi.fn();
      const updateAttempt = vi.fn();
      const registryMap = new Map<string, any>([['worktree', worktreeExecutor]]);
      const executorRegistry = {
        getDefault: () => worktreeExecutor,
        get: (name: string) => registryMap.get(name) ?? null,
        register: (name: string, executor: any) => {
          registryMap.set(name, executor);
        },
        getAll: () => [...registryMap.values()],
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
        executionPoolsProvider: () => ({
          'mixed-local-ssh': {
            selectionStrategy: 'roundRobin',
            members: [
              { type: 'worktree', id: 'local' },
              { type: 'ssh', id: 'remote-1' },
            ],
          },
        }),
      });

      await runner.publishApprovedFix(task);

      expect(worktreePublish).not.toHaveBeenCalled();
      expect(publishSpy).toHaveBeenCalledWith(
        '~/.invoker/worktrees/task-a',
        expect.objectContaining({
          actionId: 'mixed-pool-ssh-fix-task',
        }),
        'experiment/mixed-pool-ssh-fix-gap',
      );
      expect(updateTask).toHaveBeenCalledWith('mixed-pool-ssh-fix-task', {
        execution: { commit: 'def5678' },
      });
      expect(updateAttempt).toHaveBeenCalledWith('attempt-mixed-ssh-1', {
        branch: 'experiment/mixed-pool-ssh-fix-gap',
        commit: 'def5678',
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
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
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
          throw new Error('gh pr list should not be used');
        }
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('GET')) {
          return JSON.stringify([{ html_url: 'https://github.com/owner/repo/pull/42', number: 42 }]);
        }
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls/42' && args.includes('PATCH')) {
          return '';
        }
        return '';
      };

      const url = await (executor as any).execPr('main', 'feature/test', 'My Workflow');
      expect(url).toBe('https://github.com/owner/repo/pull/42');

      // Should have called REST PR lookup with correct args
      const listCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls');
      expect(listCall).toBeDefined();
      expect(listCall).toContain('head=owner:feature/test');
      expect(listCall).toContain('state=open');

      // Should have called REST PR update to update title
      const editCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls/42');
      expect(editCall).toBeDefined();
      expect(editCall).toContain('title=My Workflow');

      // Should NOT have called REST PR create
      const createCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls' && c.includes('POST'));
      expect(createCall).toBeUndefined();
    });

    it('execPr creates new PR when no open PR exists', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
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
          throw new Error('gh pr list should not be used');
        }
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('GET')) {
          return '[]';
        }
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('POST')) {
          return '{"html_url":"https://github.com/owner/repo/pull/99","number":99}';
        }
        return '';
      };

      const url = await (executor as any).execPr('main', 'feature/new', 'New Workflow');
      expect(url).toBe('https://github.com/owner/repo/pull/99');

      // Should have called REST PR lookup
      const listCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls' && c.includes('GET'));
      expect(listCall).toBeDefined();

      // Should have called REST PR create with correct args
      const createCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls' && c.includes('POST'));
      expect(createCall).toBeDefined();
      expect(createCall).toContain('base=main');
      expect(createCall).toContain('head=feature/new');
      expect(createCall).toContain('title=New Workflow');

      // Should NOT have called REST PR update
      const editCall = ghCalls.find(c => c[0] === 'api' && /\/pulls\/\d+$/.test(c[1]));
      expect(editCall).toBeUndefined();
    });

    it('execPr retries transient REST PR lookup failures', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      let lookupAttempts = 0;
      (executor as any).execGh = async (args: string[]) => {
        if (args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('GET')) {
          lookupAttempts++;
          if (lookupAttempts === 1) {
            throw new Error('gh api repos/owner/repo/pulls failed (code 1): GraphQL: API rate limit already exceeded for user ID 1916223.');
          }
          return '[]';
        }
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('POST')) {
          return '{"html_url":"https://github.com/owner/repo/pull/99","number":99}';
        }
        return '';
      };

      const url = await (executor as any).execPr('main', 'feature/new', 'New Workflow');

      expect(url).toBe('https://github.com/owner/repo/pull/99');
      expect(lookupAttempts).toBe(2);
    });

    it('execPr passes normalized branch names to gh when base uses origin/ remote-tracking form', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
      });

      const ghCalls: string[][] = [];
      (executor as any).execGh = async (args: string[]) => {
        ghCalls.push(args);
        if (args[0] === 'pr' && args[1] === 'list') throw new Error('gh pr list should not be used');
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('GET')) return '[]';
        if (args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('POST')) return '{"html_url":"https://github.com/owner/repo/pull/200","number":200}';
        return '';
      };

      await (executor as any).execPr(
        'origin/fix/my-work',
        'origin/plan/experiment',
        'Title',
        'Body',
      );

      const listCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls' && c.includes('GET'));
      expect(listCall).toContain('head=owner:plan/experiment');

      const createCall = ghCalls.find(c => c[0] === 'api' && c[1] === 'repos/owner/repo/pulls' && c.includes('POST'));
      expect(createCall).toContain('base=fix/my-work');
      expect(createCall).toContain('head=plan/experiment');
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

    it('publishReviewStackWithMakePrSkill uses preferred agent then falls back to another make-pr agent', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const attempts: string[] = [];
        const claudeAgent = {
          name: 'claude',
          stdinMode: 'ignore',
          bundledSkillRoot: join(tempHome, '.claude', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => {
            attempts.push('claude');
            return { cmd: 'node', args: ['-e', 'process.stdout.write("not json")'], sessionId: 'sess-claude' };
          },
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const codexAgent = {
          name: 'codex',
          stdinMode: 'ignore',
          bundledSkillRoot: join(tempHome, '.codex', 'skills'),
          bundledSkills: ['make-pr'],
          buildCommand: () => {
            attempts.push('codex');
            return {
              cmd: 'node',
              args: ['-e', 'var b=["## Summary","","Slice prose.","","## Review Claim","","c","","## Review Lane","","cleanup","","## Review Unit","","scalar","","## Safety Invariant","","s","","## Slice Rationale","","r","","## Non-goals","- none","","## Test Plan","- [x] pnpm test","","## Revert Plan","- Safe to revert? Yes"].join("\\n");process.stdout.write(JSON.stringify({artifacts:[{id:"contracts",title:"Contracts",url:"https://example.test/pr/1",providerId:"1",branch:"stack/contracts",baseBranch:"master",body:b},{id:"runtime",title:"Runtime",url:"https://example.test/pr/2",providerId:"2",branch:"stack/runtime",baseBranch:"stack/contracts",dependsOn:["contracts"],body:b}]}))'],
              sessionId: 'sess-codex',
            };
          },
          buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
        };
        const logEvent = vi.fn().mockImplementationOnce(() => { throw new Error('telemetry down'); });
        const executor = new TaskRunner({
          orchestrator: {
            getTask: () => null,
            getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'claude' } })],
          } as any,
          persistence: { logEvent } as any,
          executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
          executionAgentRegistry: {
            get: (name: string) => (name === 'claude' ? claudeAgent : name === 'codex' ? codexAgent : undefined),
            getOrThrow: vi.fn(),
            getSessionDriver: vi.fn().mockReturnValue(undefined),
            listWithCapability: vi.fn().mockReturnValue([claudeAgent, codexAgent]),
          } as any,
          cwd: '/tmp',
        });

        const result = await (executor as any).publishReviewStackWithMakePrSkill({
          workflowId: 'wf-1',
          title: 'Stack',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          workflowSummary: 'summary',
          cwd: '/tmp',
          mergeNodeTaskId: '__merge__wf-1',
          expectedGeneration: 26,
        });

        expect(attempts).toEqual(['claude', 'codex']);
        expect(result.agentName).toBe('codex');
        expect(result.artifacts[1].dependsOn).toEqual(['contracts']);
        expect(result.artifacts.map((a: any) => a.generation)).toEqual([26, 26]);
        expect(logEvent).toHaveBeenCalledWith(
          '__merge__wf-1',
          'task.log',
          expect.objectContaining({
            level: 'info',
            message: 'Preparing make-pr review stack publisher',
            agentCount: 2,
          }),
        );
        expect(logEvent).toHaveBeenCalledWith(
          '__merge__wf-1',
          'task.log',
          expect.objectContaining({
            level: 'warn',
            message: 'claude make-pr agent failed',
          }),
        );
        expect(logEvent).toHaveBeenCalledWith(
          '__merge__wf-1',
          'task.log',
          expect.objectContaining({
            level: 'info',
            message: 'Review stack body validated',
            artifactCount: 2,
          }),
        );
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('publishReviewStackWithMakePrSkill throws when make-pr agents cannot publish valid JSON', async () => {
      const badAgent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        bundledSkills: ['make-pr'],
        buildCommand: () => ({ cmd: 'node', args: ['-e', 'process.stdout.write("not json")'], sessionId: 'bad' }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: vi.fn().mockReturnValue(badAgent),
          getOrThrow: vi.fn(),
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([badAgent]),
        } as any,
        cwd: '/tmp',
      });

      await expect((executor as any).publishReviewStackWithMakePrSkill({
        workflowId: 'wf-1',
        title: 'Stack',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        workflowSummary: 'summary',
        cwd: '/tmp',
      })).rejects.toThrow('make-pr skill is required to publish Invoker review stacks');
    });
    it('publishReviewStackWithMakePrSkill throws when make-pr agents publish a branched review stack', async () => {
      const branchedAgent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        bundledSkills: ['make-pr'],
        buildCommand: () => ({
          cmd: 'node',
          args: ['-e', 'process.stdout.write(JSON.stringify({artifacts:[{id:"contracts",title:"Contracts",url:"https://example.test/pr/1",providerId:"1",branch:"stack/contracts",baseBranch:"master"},{id:"runtime",title:"Runtime",url:"https://example.test/pr/2",providerId:"2",branch:"stack/runtime",baseBranch:"stack/contracts",dependsOn:["contracts"]},{id:"ui",title:"UI",url:"https://example.test/pr/3",providerId:"3",branch:"stack/ui",baseBranch:"stack/runtime",dependsOn:["contracts"]}]}))'],
          sessionId: 'branched',
        }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: vi.fn().mockReturnValue(branchedAgent),
          getOrThrow: vi.fn(),
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([branchedAgent]),
        } as any,
        cwd: '/tmp',
      });

      await expect((executor as any).publishReviewStackWithMakePrSkill({
        workflowId: 'wf-1',
        title: 'Stack',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        workflowSummary: 'summary',
        cwd: '/tmp',
      })).rejects.toThrow('make-pr skill is required to publish Invoker review stacks');
    });

    it('publishReviewStackWithMakePrSkill rejects a commit-message body lacking review-compression sections (PR #2170 regression)', async () => {
      // Valid artifact JSON + valid linear stack, but the body is a bare
      // commit-message body (## Summary / ## Test Plan / ## Revert Plan only,
      // no review-compression sections) — exactly what PR #2170 shipped.
      const tempHome = createTempWorkspace();
      mkdirSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');
      const commitMsgBodyAgent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        bundledSkills: ['make-pr'],
        bundledSkillRoot: join(tempHome, '.claude', 'skills'),
        buildCommand: () => ({
          cmd: 'node',
          args: ['-e', 'var b=["## Summary","","Cut over recovery.","","## Test Plan","- [x] x","","## Revert Plan","- yes"].join("\\n");process.stdout.write(JSON.stringify({artifacts:[{id:"only",title:"Only",url:"https://example.test/pr/1",providerId:"1",branch:"stack/only",baseBranch:"master",body:b}]}))'],
          sessionId: 'commit-msg',
        }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };
      // A bare commit-message body: no ## Non-goals, no review metadata sections.
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: vi.fn().mockReturnValue(commitMsgBodyAgent),
          getOrThrow: vi.fn(),
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([commitMsgBodyAgent]),
        } as any,
        cwd: '/tmp',
      });

      await expect((executor as any).publishReviewStackWithMakePrSkill({
        workflowId: 'wf-1',
        title: 'Stack',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        workflowSummary: 'summary',
        cwd: '/tmp',
      })).rejects.toThrow(/invalid PR body — .*Non-goals/);
    });

    it('publishReviewStackWithMakePrSkill validates the published body, not just the agent-reported one', async () => {
      // Agent reports a fully compliant body in JSON...
      const goodBody = [
        '## Summary', '', 'x', '',
        '## Review Claim', '', 'c', '',
        '## Review Lane', '', 'cleanup', '',
        '## Review Unit', '', 'scalar', '',
        '## Safety Invariant', '', 's', '',
        '## Slice Rationale', '', 'r', '',
        '## Non-goals', '- none', '', '## Test Plan', '- [x] t', '', '## Revert Plan', '- yes',
      ].join('\n');
      const tempHome = createTempWorkspace();
      mkdirSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.claude', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');
      const agent = {
        name: 'claude',
        stdinMode: 'ignore' as const,
        bundledSkills: ['make-pr'],
        bundledSkillRoot: join(tempHome, '.claude', 'skills'),
        buildCommand: () => ({
          cmd: 'node',
          args: ['-e', `var b=${JSON.stringify(goodBody)};process.stdout.write(JSON.stringify({artifacts:[{id:"only",title:"Only",url:"https://example.test/pr/1",providerId:"1",branch:"stack/only",baseBranch:"master",body:b}]}))`],
          sessionId: 'good',
        }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };
      const executor = new TaskRunner({
        orchestrator: { getTask: () => null, getAllTasks: () => [] } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: vi.fn().mockReturnValue(agent),
          getOrThrow: vi.fn(),
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([agent]),
        } as any,
        // ...but the body actually published on GitHub is a bare commit message.
        mergeGateProvider: {
          name: 'github',
          createReview: vi.fn(),
          checkApproval: vi.fn(),
          getReviewBody: vi.fn().mockResolvedValue('Just a commit message subject\n\nsome body line'),
        } as any,
        cwd: '/tmp',
      });

      await expect((executor as any).publishReviewStackWithMakePrSkill({
        workflowId: 'wf-1',
        title: 'Stack',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        workflowSummary: 'summary',
        cwd: '/tmp',
      })).rejects.toThrow(/invalid PR body — .*\[published\]/);
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

    const STRICT_COMPLIANT_REVIEW_STACK_BODY = [
      '## Summary',
      '',
      'Authored change.',
      '',
      '## Review Claim',
      '',
      'One reviewable gate change.',
      '',
      '## Review Lane',
      '',
      'behavior',
      '',
      '## Review Unit',
      '',
      'write-path',
      '',
      '## Safety Invariant',
      '',
      'Existing tests cover the gate.',
      '',
      '## Slice Rationale',
      '',
      'Single slice.',
      '',
      '## Non-goals',
      '',
      '- Nothing else.',
      '',
      '## Test Plan',
      '',
      '- [x] `pnpm test`',
      '',
      '## Revert Plan',
      '',
      '- Safe to revert? Yes',
    ].join('\n');

    const CANONICAL_ONLY_BODY = '## Summary\n\nAuthored\n\n## Test Plan\n\n- [x] `pnpm test`\n\n## Revert Plan\n\n- Safe to revert? Yes';

    function makeBodyEmittingAgent(tempHome: string, body: string) {
      return {
        name: 'codex',
        stdinMode: 'ignore',
        linuxTerminalTail: 'exec_bash',
        bundledSkillRoot: join(tempHome, '.codex', 'skills'),
        bundledSkills: ['make-pr'],
        buildCommand: () => ({
          cmd: 'node',
          args: ['-e', `process.stdout.write(${JSON.stringify(body)})`],
          sessionId: 'sess-strict-gate',
        }),
        buildResumeArgs: () => ({ cmd: 'node', args: ['-e', ''] }),
      };
    }

    function makeStrictGateExecutor(agent: any) {
      return new TaskRunner({
        orchestrator: {
          getTask: () => null,
          getAllTasks: () => [makeTask({ id: 't1', config: { workflowId: 'wf-1', executionAgent: 'codex' } })],
        } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        executionAgentRegistry: {
          get: (name: string) => name === 'codex' ? agent : undefined,
          getOrThrow: vi.fn().mockReturnValue(agent),
          getSessionDriver: vi.fn().mockReturnValue(undefined),
          listWithCapability: vi.fn().mockReturnValue([agent]),
        } as any,
        cwd: '/tmp',
        logger: createMockLogger(),
      });
    }

    it('authorPrBodyWithSkill rejects a canonical-only body and refuses fallback for Invoker repoUrl', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const executor = makeStrictGateExecutor(makeBodyEmittingAgent(tempHome, CANONICAL_ONLY_BODY));

        await expect((executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Test Workflow',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          workflowSummary: '## Summary\nSource summary',
          cwd: '/tmp',
          repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker',
        })).rejects.toThrow(/refusing canonical fallback/);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill accepts a review-stack-compliant body for Invoker repoUrl', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const executor = makeStrictGateExecutor(makeBodyEmittingAgent(tempHome, STRICT_COMPLIANT_REVIEW_STACK_BODY));

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Test Workflow',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          workflowSummary: '## Summary\nSource summary',
          cwd: '/tmp',
          repoUrl: 'git@github.com:EdbertChan/Invoker.git',
        });

        expect(result.agentName).toBe('codex');
        expect(result.body).toContain('## Non-goals');
        expect(result.body).toContain('## Review Claim');
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it('authorPrBodyWithSkill throws for Invoker repoUrl when no execution agent registry is configured', async () => {
      const executor = new TaskRunner({
        orchestrator: {
          getTask: () => null,
          getAllTasks: () => [],
        } as any,
        persistence: {} as any,
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
        cwd: '/tmp',
        logger: createMockLogger(),
      });

      await expect((executor as any).authorPrBodyWithSkill({
        workflowId: 'wf-1',
        title: 'Canonical Test',
        baseBranch: 'master',
        featureBranch: 'plan/canonical',
        workflowSummary: 'Summary.',
        cwd: '/tmp',
        repoUrl: 'https://github.com/EdbertChan/Invoker',
      })).rejects.toThrow(/cannot pass scripts\/validate-pr-body\.mjs/);
    });

    it('authorPrBodyWithSkill keeps the lenient gate and canonical fallback for non-Invoker repoUrl', async () => {
      const tempHome = createTempWorkspace();
      const originalHome = process.env.HOME;
      process.env.HOME = tempHome;
      mkdirSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr'), { recursive: true });
      writeFileSync(join(tempHome, '.codex', 'skills', 'invoker-make-pr', 'SKILL.md'), '# make-pr\n');

      try {
        const executor = makeStrictGateExecutor(makeBodyEmittingAgent(tempHome, CANONICAL_ONLY_BODY));

        const result = await (executor as any).authorPrBodyWithSkill({
          workflowId: 'wf-1',
          title: 'Test Workflow',
          baseBranch: 'master',
          featureBranch: 'plan/feature',
          workflowSummary: '## Summary\nSource summary',
          cwd: '/tmp',
          repoUrl: 'https://github.com/other/repo',
        });

        expect(result.agentName).toBe('codex');
        expect(result.body).toContain('## Test Plan');
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
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
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
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [], register: vi.fn() } as any,
        cwd: '/tmp',
        remoteTargetsProvider: provider,
      });

      const task = makeTask({
        id: 'ssh-task',
        config: { runnerKind: 'ssh', poolMemberId: 'do-droplet' },
      });

      const executor1 = executor.selectExecutor(task);
      expect(executor1.executor.type).toBe('ssh');
      expect((executor1.executor as any).sshKeyPath).toBe('/old/key');

      const executor2 = executor.selectExecutor(task);
      expect((executor2.executor as any).sshKeyPath).toBe('/new/key');

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
      repoUrl?: string;
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
        setTaskReviewReady: vi.fn(),
        autoStartExternallyUnblockedReadyTasks: vi.fn(() => []),
      };

      const persistence = {
        loadWorkflow: () => ({
          id: workflowId,
          onFinish: opts.onFinish ?? 'none',
          mergeMode: opts.mergeMode ?? 'manual',
          baseBranch: 'master',
          featureBranch: opts.featureBranch,
          name: 'Test Workflow',
          repoUrl: opts.repoUrl,
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
      (executor as any).buildMergeSummary = vi.fn().mockResolvedValue('## Summary');
      (executor as any).authorPrBodyWithSkill = vi.fn().mockResolvedValue({
        body: '## Summary\n\nPublished body',
        sessionId: 'sess-pr-4',
        agentName: 'codex',
      });
      (executor as any).execPr = vi.fn().mockResolvedValue('https://github.com/owner/repo/pull/100');

      return { executor, mergeTask, orchestrator, persistence, mergeGateProvider, gitCalls };
    }


    it('external_review on Invoker publishes a make-pr review stack instead of direct provider PR', async () => {
      const contractsTask = makeTask({
        id: 'contracts',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/contracts' },
        description: 'Contracts',
      });
      const runtimeTask = makeTask({
        id: 'runtime',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/runtime' },
        description: 'Runtime',
      });

      const { executor, mergeTask, orchestrator, mergeGateProvider } = setupPublishAfterFix({
        mergeMode: 'external_review',
        featureBranch: 'plan/feature',
        gateWorkspacePath: '/tmp/gate-clone',
        taskBranches: [contractsTask, runtimeTask],
        repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
      });

      (executor as any).publishReviewStackWithMakePrSkill = vi.fn().mockResolvedValue({
        artifacts: [
          {
            id: 'contracts',
            title: 'Define contracts',
            url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/1',
            providerId: '1',
            branch: 'stack/contracts',
            baseBranch: 'master',
            required: true,
            status: 'open',
            generation: 0,
          },
          {
            id: 'runtime',
            title: 'Wire runtime',
            url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/2',
            providerId: '2',
            branch: 'stack/runtime',
            baseBranch: 'stack/contracts',
            dependsOn: ['contracts'],
            required: true,
            status: 'open',
            generation: 0,
          },
        ],
        sessionId: 'sess-stack',
        agentName: 'codex',
      });

      await executor.publishAfterFix(mergeTask);

      expect((executor as any).publishReviewStackWithMakePrSkill).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Test Workflow',
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        cwd: '/tmp/gate-clone',
      }));
      expect(mergeGateProvider.createReview).not.toHaveBeenCalled();
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        execution: expect.objectContaining({
          reviewUrl: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/1',
          reviewId: '1',
          reviewGate: expect.objectContaining({
            activeGeneration: 0,
            artifacts: [
              expect.objectContaining({ id: 'contracts', generation: 0 }),
              expect.objectContaining({ id: 'runtime', dependsOn: ['contracts'], generation: 0 }),
            ],
          }),
        }),
      }), expect.objectContaining({ generation: 0 }));
    });
    it('stamps published stack artifacts with the merge task generation so the poller keeps them live', async () => {
      const contractsTask = makeTask({
        id: 'contracts',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/contracts' },
        description: 'Contracts',
      });

      const { executor, mergeTask, orchestrator } = setupPublishAfterFix({
        mergeMode: 'external_review',
        featureBranch: 'plan/feature',
        gateWorkspacePath: '/tmp/gate-clone',
        taskBranches: [contractsTask],
        repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
      });

      mergeTask.execution.generation = 26;

      (executor as any).publishReviewStackWithMakePrSkill = vi.fn().mockResolvedValue({
        artifacts: [
          {
            id: 'contracts',
            title: 'Define contracts',
            url: 'https://github.com/Neko-Catpital-Labs/Invoker/pull/1',
            providerId: '1',
            branch: 'stack/contracts',
            baseBranch: 'master',
            required: true,
            status: 'open',
            generation: 0,
          },
        ],
        sessionId: 'sess-stack',
        agentName: 'codex',
      });

      await executor.publishAfterFix(mergeTask);

      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledTimes(1);
      const [, changes] = (orchestrator.setTaskReviewReady as any).mock.calls[0];
      const gate = changes.execution.reviewGate;
      expect(gate.activeGeneration).toBe(26);
      for (const artifact of gate.artifacts) {
        expect(artifact.generation).toBe(gate.activeGeneration);
      }

      const publishedTask = { execution: changes.execution } as TaskState;
      expect(getCurrentRequiredReviewArtifacts(publishedTask)).toHaveLength(1);
    });
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
      const gatePush = gateGitCalls.find((c) =>
        c.args[0] === 'push' &&
        c.args.includes('origin') &&
        c.args.includes('plan/feature:refs/heads/plan/feature'));
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

      // Task set to review_ready with PR metadata
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/99',
          reviewId: 'owner/repo#99',
          reviewStatus: 'Awaiting review',
        }),
      }), expect.objectContaining({ generation: 0 }));

      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('pull_request mode: republishes through createReview and returns to review_ready', async () => {
      const completedTask = makeTask({
        id: 't1',
        status: 'completed',
        config: { workflowId: 'wf-pub' },
        execution: { branch: 'invoker/t1' },
      });

      const { executor, mergeTask, orchestrator, persistence, mergeGateProvider } = setupPublishAfterFix({
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
      expect(mergeGateProvider.createReview).toHaveBeenCalledWith(expect.objectContaining({
        baseBranch: 'master',
        featureBranch: 'plan/feature',
        title: 'Test Workflow',
        cwd: '/tmp/gate-clone',
        body: '## Summary\n\nPublished body',
      }));
      expect((executor as any).execPr).not.toHaveBeenCalled();
      expect(persistence.updateTask).not.toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        execution: expect.objectContaining({ reviewUrl: expect.any(String) }),
      }));
      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        execution: expect.objectContaining({
          branch: 'plan/feature',
          reviewUrl: 'https://github.com/owner/repo/pull/99',
          reviewId: 'owner/repo#99',
          reviewStatus: 'Awaiting review',
          reviewGate: expect.objectContaining({
            activeGeneration: 0,
            artifacts: [expect.objectContaining({
              providerId: 'owner/repo#99',
              status: 'open',
              generation: 0,
            })],
          }),
        }),
      }), expect.objectContaining({ generation: 0 }));
      expect(orchestrator.handleWorkerResponse).not.toHaveBeenCalled();
    });

    it('no featureBranch: early exit with setTaskReviewReady', async () => {
      const { executor, mergeTask, orchestrator, gitCalls } = setupPublishAfterFix({
        featureBranch: undefined,
        gateWorkspacePath: '/tmp/gate-clone',
      });

      await executor.publishAfterFix(mergeTask);

      expect(orchestrator.setTaskReviewReady).toHaveBeenCalledWith('__merge__wf-pub', expect.objectContaining({
        config: expect.objectContaining({ runnerKind: 'worktree' }),
        execution: expect.objectContaining({ workspacePath: '/tmp/gate-clone' }),
      }), expect.objectContaining({ generation: 0 }));

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
      expect(orchestrator.setTaskReviewReady).not.toHaveBeenCalled();
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
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [], register: vi.fn() } as any,
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
      expect(executor1.executor).toBe(executor2.executor);
      // task3 has a different poolMemberId → different executor instance
      expect(executor1.executor).not.toBe(executor3.executor);
      expect(executor2.executor).not.toBe(executor3.executor);
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
      expect(executor1.executor.type).toBe('worktree');
      expect(executor2.executor.type).toBe('worktree');
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
        executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [], register: vi.fn() } as any,
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
      expect(executor1.executor).not.toBe(executor2.executor);
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
        config: { runnerKind: 'ssh', executionAgent: 'codex', executionModel: undefined, poolMemberId: 'remote-a' },
        execution: expect.objectContaining({
          workspacePath: '/remote/worktrees/task-1',
          branch: 'experiment/task-1',
        }),
      });
    });

    it('retries SSH startup transport failures on another pool member before failing the task', async () => {
      const sshExecutor = createCompletingExecutor('ssh', {
        workspacePath: '/remote/worktrees/task-retry',
        branch: 'experiment/task-retry',
      });
      sshExecutor.start = vi.fn()
        .mockRejectedValueOnce(new Error(
          'SSH remote script failed (exit=255)\nSTDERR:\nConnection timed out during banner exchange',
        ))
        .mockResolvedValueOnce({
          executionId: 'exec-task-retry',
          taskId: 'task-retry',
          workspacePath: '/remote/worktrees/task-retry',
          branch: 'experiment/task-retry',
        });
      const logEvent = vi.fn();
      const updateTask = vi.fn();
      const appendTaskOutput = vi.fn();
      const handleWorkerResponse = vi.fn();
      const task = makeTask({
        id: 'task-retry',
        status: 'pending',
        config: { command: 'pnpm test', runnerKind: 'ssh', poolId: 'ci-pool' },
        execution: { selectedAttemptId: 'attempt-retry' },
      });

      const runner = new TaskRunner({
        orchestrator: { getTask: () => task, getAllTasks: () => [task], handleWorkerResponse } as any,
        persistence: { updateTask, updateAttempt: vi.fn(), appendTaskOutput, logEvent } as any,
        executorRegistry: {
          getDefault: () => sshExecutor,
          get: (type: string) => type === 'ssh' ? sshExecutor : null,
          getAll: () => [sshExecutor],
        } as any,
        cwd: '/tmp',
        executionPoolsProvider: () => ({
          'ci-pool': {
            selectionStrategy: 'leastLoaded',
            members: [
              { type: 'ssh', id: 'remote-a' },
              { type: 'ssh', id: 'remote-b' },
            ],
          },
        }),
        remoteTargetsProvider: () => ({
          'remote-a': { host: 'a.example.com', user: 'runner', sshKeyPath: '/secret/a' },
          'remote-b': { host: 'b.example.com', user: 'runner', sshKeyPath: '/secret/b' },
        }),
      });

      await runner.executeTask(task);

      expect(sshExecutor.start).toHaveBeenCalledTimes(2);
      expect(appendTaskOutput).toHaveBeenCalledWith(
        'task-retry',
        expect.stringContaining('retrying another SSH pool member'),
      );
      expect(logEvent).toHaveBeenCalledWith('task-retry', 'task.executor.startup-retry', expect.objectContaining({
        poolId: 'ci-pool',
        poolMemberId: 'remote-a',
        reason: 'ssh-startup-transport-failure',
      }));
      expect(logEvent).toHaveBeenCalledWith('task-retry', 'task.executor.selected', expect.objectContaining({
        runnerKind: 'ssh',
        poolMemberId: 'remote-b',
        remoteHost: 'b.example.com',
      }));
      expect(updateTask).toHaveBeenCalledWith('task-retry', {
        config: { runnerKind: 'ssh', executionAgent: 'codex', executionModel: undefined, poolMemberId: 'remote-b' },
        execution: expect.objectContaining({
          workspacePath: '/remote/worktrees/task-retry',
          branch: 'experiment/task-retry',
        }),
      });
      expect(handleWorkerResponse).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
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
        config: { runnerKind: 'ssh', executionAgent: 'codex', executionModel: undefined, poolMemberId: 'remote-1' },
        execution: {
          workspacePath: '~/.invoker/worktrees/abc123/experiment-ssh-task-1-def456',
          branch: 'experiment/ssh-task-1-def456',
          agentSessionId: 'session-123',
          lastAgentSessionId: 'session-123',
          agentName: undefined,
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
        config: { runnerKind: 'ssh', executionAgent: 'codex', executionModel: undefined },
        execution: {
          workspacePath: '/remote/user-provided/workspace',
          branch: undefined,
          agentSessionId: undefined,
          lastAgentSessionId: undefined,
          agentName: undefined,
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
        const receivedHeartbeats: Array<{ taskId: string; at: Date; source: string }> = [];
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
            onHeartbeat: (taskId, event) => {
              receivedHeartbeats.push({ taskId, ...event });
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
        expect(receivedHeartbeats).toEqual([
          {
            taskId: 'gc-task-3',
            at: expect.any(Date),
            source: 'executor',
          },
        ]);

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

    it('does not run legacy executeMergeNode from the completion handler', async () => {
      let mergeCallCount = 0;
      const completeCallbacks = new Map<string, (response: WorkResponse) => void>();
      const mergeExecutor = {
        type: 'merge',
        start: vi.fn(async (request: any) => ({
          executionId: `exec-${request.actionId}`,
          taskId: request.actionId,
          workspacePath: '/tmp/mock-merge',
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
          getDefault: () => mergeExecutor,
          get: (type: string) => (type === 'merge' ? mergeExecutor : null),
          getAll: () => [mergeExecutor],
          register: vi.fn(),
        } as any,
        cwd: '/tmp',
      });

      vi.spyOn(runner as any, 'executeMergeNode').mockImplementation(async () => {
        mergeCallCount += 1;
      });

      // Persisted runnerKind=worktree must still route to the merge executor.
      const task1 = makeTask({ id: 'merge-1', status: 'running', config: { isMergeNode: true, runnerKind: 'worktree' } });
      const task2 = makeTask({ id: 'merge-2', status: 'running', config: { isMergeNode: true, runnerKind: 'worktree' } });

      const done1 = runner.executeTask(task1);
      const done2 = runner.executeTask(task2);
      await flush();
      expect(mergeExecutor.start).toHaveBeenCalledTimes(2);
      expect(completeCallbacks.size).toBe(2);

      completeCallbacks.get('merge-1')!({
        requestId: 'r1', actionId: 'merge-1', status: 'completed', outputs: { exitCode: 0 },
      });
      completeCallbacks.get('merge-2')!({
        requestId: 'r2', actionId: 'merge-2', status: 'completed', outputs: { exitCode: 0 },
      });

      await flush();
      await Promise.all([done1, done2]);
      expect(mergeCallCount).toBe(0);
    });

    it('routes isMergeNode + runnerKind worktree through merge executor completion', async () => {
      vi.useFakeTimers();
      try {
        const completeCallbacks = new Map<string, (response: WorkResponse) => void>();
        const updateAttempt = vi.fn();
        const onCompleteCb = vi.fn();
        let legacyMergeCallCount = 0;

        const mergeExecutor = {
          type: 'merge',
          start: vi.fn(async (request: any) => ({
            executionId: `exec-${request.actionId}`,
            taskId: request.actionId,
            workspacePath: '/tmp/mock-merge',
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
            getDefault: () => mergeExecutor,
            get: (type: string) => (type === 'merge' ? mergeExecutor : null),
            getAll: () => [mergeExecutor],
            register: vi.fn(),
          } as any,
          cwd: '/tmp',
          callbacks: {
            onComplete: onCompleteCb,
          },
        });

        vi.spyOn(runner as any, 'executeMergeNode').mockImplementation(async () => {
          legacyMergeCallCount += 1;
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
        expect(mergeExecutor.start).toHaveBeenCalledTimes(2);
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
        await Promise.all([done1, done2]);
        expect(legacyMergeCallCount).toBe(0);
        expect(onCompleteCb).toHaveBeenCalledWith(
          'merge-2',
          expect.objectContaining({ status: 'completed' }),
        );
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

    it('does not submit fallback failure when completion becomes stale after handler error', async () => {
      let currentTask = makeTask({
        id: 'task-stale-completion',
        status: 'running',
        config: { command: 'echo hi' },
        execution: { selectedAttemptId: 'attempt-old', generation: 1 },
      });
      const handleWorkerResponse = vi.fn(() => {
        currentTask = makeTask({
          id: 'task-stale-completion',
          status: 'running',
          config: { command: 'echo hi' },
          execution: { selectedAttemptId: 'attempt-new', generation: 2 },
        });
        throw new Error('stale handler failure');
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
          getTask: () => currentTask,
          handleWorkerResponse,
          getAllTasks: () => [currentTask],
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

      const done = runner.executeTask(currentTask);
      await flush();

      completeCallbacks.get('task-stale-completion')!({
        requestId: 'r1',
        actionId: 'task-stale-completion',
        attemptId: 'attempt-old',
        executionGeneration: 1,
        status: 'completed',
        outputs: { exitCode: 0 },
      });

      await done;

      expect(handleWorkerResponse).toHaveBeenCalledTimes(1);
      expect(onCompleteCb).not.toHaveBeenCalled();
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

      const rawSummary = '## Summary\nRaw workflow summary — should not appear in PR body';
      const authoredBody = '## Summary\n\nAuthored PR body with enriched content\n\n## Test Plan\n\n- [x] verified\n\n## Revert Plan\n\n- Safe to revert';
      (executor as any).execGitReadonly = async (args: string[]) => {
        if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
        return '';
      };
      (executor as any).execGitIn = async () => '';
      (executor as any).createMergeWorktree = async () => '/tmp/mock-wt';
      (executor as any).removeMergeWorktree = async () => {};
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

  describe('SSH heartbeat owner callback metadata', () => {
    it('passes remote workload heartbeat metadata to the owner callback', async () => {
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

      const onHeartbeat = vi.fn();
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
        callbacks: { onHeartbeat },
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

      expect(updateTask).not.toHaveBeenCalledWith(
        runningTask.id,
        expect.objectContaining({
          execution: expect.objectContaining({
            lastHeartbeatAt: expect.any(Date),
          }),
        }),
      );
      expect(onHeartbeat).toHaveBeenCalledWith(
        runningTask.id,
        expect.objectContaining({
          at: expect.any(Date),
          source: 'remote_workload',
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
