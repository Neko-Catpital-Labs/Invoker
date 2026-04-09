import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { WorkRequest } from '@invoker/contracts';
import type { Writable } from 'node:stream';

// Mock child_process before importing WorktreeExecutor
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), mkdirSync: vi.fn() };
});

// Must import after mock setup
import { spawn } from 'node:child_process';
import { WorktreeExecutor } from '../worktree-executor.js';
import { BaseExecutor } from '../base-executor.js';

const mockedSpawn = vi.mocked(spawn);

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  const { inputs: inputOverrides, ...restOverrides } = overrides;
  return {
    requestId: 'req-1',
    actionId: 'action-1',
    actionType: 'command',
    inputs: { command: 'echo hello', repoUrl: 'git@github.com:test/repo.git', ...inputOverrides },
    callbackUrl: 'http://localhost:3000/callback',
    timestamps: { createdAt: new Date().toISOString() },
    ...restOverrides,
  };
}

/**
 * Mock the RepoPool on a WorktreeExecutor instance.
 */
function mockPool(fam: WorktreeExecutor) {
  const pool = {
    ensureClone: vi.fn().mockResolvedValue('/fake/cache/clone'),
    acquireWorktree: vi.fn().mockImplementation((_repoUrl: string, branch: string) => {
      const sanitized = branch.replace(/\//g, '-');
      return Promise.resolve({
        clonePath: '/fake/cache/clone',
        worktreePath: `/fake/worktrees/${sanitized}`,
        branch,
        release: vi.fn().mockResolvedValue(undefined),
      });
    }),
    destroyAll: vi.fn().mockResolvedValue(undefined),
    getClonePath: vi.fn().mockReturnValue('/fake/cache/clone'),
  };
  (fam as any).pool = pool;
  return pool;
}

/**
 * Creates a mock ChildProcess that emits events.
 * Callers control behavior by emitting 'close' and 'data' events on it.
 */
function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinMock = {
    write: vi.fn(),
    end: vi.fn(),
  };

  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = stdinMock as unknown as Writable;
  (proc as any).pid = 12345;
  (proc as any).killed = false;
  proc.kill = vi.fn().mockReturnValue(true);

  return proc;
}

/**
 * Sets up mockedSpawn to handle both git commands and task commands.
 *
 * Returns references to the mock processes for controlling test behavior.
 */
function setupSpawnMock(): {
  gitProcesses: Array<ChildProcess & EventEmitter>;
  taskProcess: ChildProcess & EventEmitter;
} {
  const gitProcesses: Array<ChildProcess & EventEmitter> = [];
  const taskProcess = createMockProcess();
  let taskProcessReturned = false;

  mockedSpawn.mockImplementation((cmd: string, args?: readonly string[], _options?: any) => {
    if (cmd === 'git') {
      const gitProc = createMockProcess();
      gitProcesses.push(gitProc);

      // Auto-succeed git commands after a microtask
      Promise.resolve().then(() => {
        const argsArr = args as string[];
        if (argsArr?.includes('rev-parse')) {
          gitProc.stdout!.emit('data', Buffer.from('abc123def456\n'));
        }
        // merge-base --is-ancestor should fail (not ancestor) so merges proceed
        if (argsArr?.[0] === 'merge-base' && argsArr?.[1] === '--is-ancestor') {
          gitProc.emit('close', 1, null);
          return;
        }
        gitProc.emit('close', 0, null);
      });

      return gitProc as any;
    }

    // Auto-succeed pnpm install (worktree provisioning)
    const argsArr = args as string[] | undefined;
    if (cmd === '/bin/bash' && argsArr?.[1]?.includes('pnpm install')) {
      const installProc = createMockProcess();
      Promise.resolve().then(() => installProc.emit('close', 0, null));
      return installProc as any;
    }

    // For non-git commands (task execution), return the task process
    if (!taskProcessReturned) {
      taskProcessReturned = true;
      return taskProcess as any;
    }

    // Additional non-git spawns get fresh mocks
    const extra = createMockProcess();
    return extra as any;
  });

  return { gitProcesses, taskProcess };
}

describe('BUG REPRO: worktree lifecycle leaks', () => {
  let executor: WorktreeExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = new WorktreeExecutor({
      cacheDir: '/fake/cache',
      worktreeBaseDir: '/fake/worktrees',
    });
    mockPool(executor);

    // Mock runBash so upstream merge scripts work without real bash
    vi.spyOn(BaseExecutor.prototype as any, 'runBash').mockImplementation(
      async (script: string) => {
        if (script.includes('PRESERVED=')) {
          return 'PRESERVED=0\nBASE_SHA=abc123def456\n';
        }
        return '';
      },
    );
  });

  it('should preserve worktree after normal task completion', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await executor.start(request);

    // Register onComplete listener
    const responsePromise = new Promise((resolve) => {
      executor.onComplete(handle, (res) => resolve(res));
    });

    // Complete task successfully
    taskProcess.emit('close', 0, null);
    await responsePromise;

    // Wait 100ms for async cleanup
    await new Promise((r) => setTimeout(r, 100));

    // Filter for git worktree remove calls
    const removeCalls = mockedSpawn.mock.calls.filter(
      (call) =>
        call[0] === 'git' &&
        (call[1] as string[])?.includes('worktree') &&
        (call[1] as string[])?.includes('remove'),
    );

    // Worktrees are intentionally preserved so users can inspect task output
    expect(removeCalls.length).toBe(0);
  });

  it('should clean entries map after task completion', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await executor.start(request);

    // Register onComplete listener
    const responsePromise = new Promise((resolve) => {
      executor.onComplete(handle, (res) => resolve(res));
    });

    // Complete task successfully
    taskProcess.emit('close', 0, null);
    await responsePromise;

    // Wait 100ms for async cleanup
    await new Promise((r) => setTimeout(r, 100));

    // This WILL FAIL (size is 1) because entries are never deleted
    expect((executor as any).entries.size).toBe(0);
  });

  it('should call pool.ensureClone (which fetches) before branching when baseBranch is set', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest({
      inputs: { command: 'echo hello', baseBranch: 'main' },
    });
    await executor.start(request);

    // pool.ensureClone handles fetching internally (git fetch --all on existing clones)
    const pool = (executor as any).pool;
    expect(pool.ensureClone).toHaveBeenCalledWith('git@github.com:test/repo.git');

    // Cleanup
    taskProcess.emit('close', 0, null);
  });
});
