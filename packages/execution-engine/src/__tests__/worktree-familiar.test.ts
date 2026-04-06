import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { PersistedTaskMeta } from '../familiar.js';
import type { Writable, Readable } from 'node:stream';

// Mock child_process before importing WorktreeFamiliar
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync), mkdirSync: vi.fn() };
});

// Must import after mock setup
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { WorktreeFamiliar, computeBranchHash } from '../worktree-familiar.js';
import { BaseFamiliar } from '../base-familiar.js';

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
 * Mock the RepoPool on a WorktreeFamiliar instance so that
 * pool.ensureClone / pool.acquireWorktree bypass real git.
 */
function mockPool(fam: WorktreeFamiliar) {
  const pool = {
    ensureClone: vi.fn().mockResolvedValue('/fake/cache/clone'),
    acquireWorktree: vi.fn().mockImplementation((_repoUrl: string, branch: string) => {
      const sanitized = branch.replace(/\//g, '-');
      return Promise.resolve({
        clonePath: '/fake/cache/clone',
        worktreePath: `/fake/worktrees/${sanitized}`,
        branch,
        release: vi.fn().mockResolvedValue(undefined),
        softRelease: vi.fn(),
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

describe('computeBranchHash', () => {
  it('is deterministic: same inputs produce same hash', () => {
    const a = computeBranchHash('t1', 'echo hi', undefined, ['c1'], 'HEAD1');
    const b = computeBranchHash('t1', 'echo hi', undefined, ['c1'], 'HEAD1');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is sensitive to command changes', () => {
    const a = computeBranchHash('t1', 'echo hi', undefined, [], 'HEAD1');
    const b = computeBranchHash('t1', 'echo bye', undefined, [], 'HEAD1');
    expect(a).not.toBe(b);
  });

  it('is sensitive to prompt changes', () => {
    const a = computeBranchHash('t1', undefined, 'prompt A', [], 'HEAD1');
    const b = computeBranchHash('t1', undefined, 'prompt B', [], 'HEAD1');
    expect(a).not.toBe(b);
  });

  it('is sensitive to baseHead changes', () => {
    const a = computeBranchHash('t1', 'cmd', undefined, [], 'abc123');
    const b = computeBranchHash('t1', 'cmd', undefined, [], 'def456');
    expect(a).not.toBe(b);
  });

  it('is sensitive to upstream commit changes', () => {
    const a = computeBranchHash('t1', 'cmd', undefined, ['c1'], 'HEAD1');
    const b = computeBranchHash('t1', 'cmd', undefined, ['c2'], 'HEAD1');
    expect(a).not.toBe(b);
  });

  it('is order-independent for upstream commits', () => {
    const a = computeBranchHash('t1', 'cmd', undefined, ['c1', 'c2'], 'HEAD1');
    const b = computeBranchHash('t1', 'cmd', undefined, ['c2', 'c1'], 'HEAD1');
    expect(a).toBe(b);
  });

  it('is sensitive to salt changes', () => {
    const a = computeBranchHash('t1', 'cmd', undefined, [], 'HEAD1', '0');
    const b = computeBranchHash('t1', 'cmd', undefined, [], 'HEAD1', '1');
    expect(a).not.toBe(b);
  });

  it('produces same hash when salt is identical', () => {
    const a = computeBranchHash('t1', 'cmd', undefined, [], 'HEAD1', '42');
    const b = computeBranchHash('t1', 'cmd', undefined, [], 'HEAD1', '42');
    expect(a).toBe(b);
  });

  it('is backward compatible when salt is omitted or empty', () => {
    const noSalt = computeBranchHash('t1', 'cmd', undefined, [], 'HEAD1');
    const emptySalt = computeBranchHash('t1', 'cmd', undefined, [], 'HEAD1', '');
    expect(noSalt).toBe(emptySalt);
  });
});

describe('WorktreeFamiliar', () => {
  let familiar: WorktreeFamiliar;

  beforeEach(() => {
    vi.clearAllMocks();
    familiar = new WorktreeFamiliar({
      cacheDir: '/fake/cache',
      worktreeBaseDir: '/fake/worktrees',
    });
    mockPool(familiar);

    // Mock runBash so upstream merge scripts work with the spawn-level git mocks.
    // The bash scripts would normally call git commands inside a single bash process,
    // but in tests we need them to flow through the mocked spawn('git', ...).
    vi.spyOn(BaseFamiliar.prototype as any, 'runBash').mockImplementation(
      async (script: string, _cwd: string) => {
        // Simulate bashPreserveOrReset: always force-create (not preserved)
        if (script.includes('PRESERVED=')) {
          return 'PRESERVED=0\nBASE_SHA=abc123def456\n';
        }
        // Simulate bashMergeUpstreams: delegate to execGitSimple for each merge
        if (script.includes('Invoker: merge')) {
          // Extract branch names from the script (they appear as shell-quoted literals)
          const branchMatches = script.match(/'([^']+)'/g);
          if (branchMatches) {
            const branches = branchMatches
              .map(m => m.replace(/'/g, ''))
              .filter(b => b !== _cwd && !b.startsWith('/'));
            for (const b of branches) {
              try {
                await (familiar as any).execGitSimple(
                  ['merge', '--no-edit', '-m', `Invoker: merge ${b}`, b], _cwd,
                );
              } catch (err: any) {
                const mergeErr = new Error(`bash exited with code 31: MERGE_CONFLICT_BRANCH=${b}`);
                (mergeErr as any).exitCode = 31;
                (mergeErr as any).stderr = `MERGE_CONFLICT_BRANCH=${b}\nMERGE_CONFLICT_FILE=conflicted.txt`;
                throw mergeErr;
              }
            }
          }
          return '';
        }
        return '';
      },
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('start creates git worktree with unique branch', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await familiar.start(request);

    expect(handle).toBeDefined();
    expect(handle.executionId).toBeDefined();
    expect(handle.taskId).toBe('action-1');

    // Verify pool.acquireWorktree was called with the correct branch
    const pool = (familiar as any).pool;
    expect(pool.acquireWorktree).toHaveBeenCalledTimes(1);
    const [calledUrl, calledBranch] = pool.acquireWorktree.mock.calls[0];
    expect(calledUrl).toBe('git@github.com:test/repo.git');
    expect(calledBranch).toMatch(/^experiment\/action-1-[0-9a-f]{8}$/);

    // Branch should be content-addressable
    expect(handle.branch).toMatch(/^experiment\/action-1-[0-9a-f]{8}$/);

    // Cleanup: emit close on task process to prevent hanging
    taskProcess.emit('close', 0, null);
  });

  it('task runs in worktree directory, not main repo', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest({ inputs: { command: 'make test' } });
    await familiar.start(request);

    // Find the task spawn call (non-git, non-pnpm-install)
    const taskCall = mockedSpawn.mock.calls.find(
      ([cmd, args]) => cmd !== 'git' && !(cmd === '/bin/bash' && (args as string[])?.[1]?.includes('pnpm install')),
    );
    expect(taskCall).toBeDefined();

    const options = taskCall![2] as { cwd: string };
    // The cwd should be under the worktree base dir, not the main repo
    expect(options.cwd).toMatch(/^\/fake\/worktrees\//);
    expect(options.cwd).not.toBe('/fake/repo');

    // Cleanup
    taskProcess.emit('close', 0, null);
  });

  it('runs pnpm install before spawning the task process', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    await familiar.start(request);

    const pnpmCall = mockedSpawn.mock.calls.find(
      ([cmd, args]) => cmd === '/bin/bash' && (args as string[])?.[1]?.includes('pnpm install'),
    );
    expect(pnpmCall).toBeDefined();
    expect((pnpmCall![1] as string[])[1]).toContain('--frozen-lockfile');

    const taskCall = mockedSpawn.mock.calls.find(
      ([cmd, args]) => cmd === '/bin/bash' && (args as string[])?.[1] === 'echo hello',
    );
    expect(taskCall).toBeDefined();

    const pnpmIdx = mockedSpawn.mock.calls.indexOf(pnpmCall!);
    const taskIdx = mockedSpawn.mock.calls.indexOf(taskCall!);
    expect(pnpmIdx).toBeLessThan(taskIdx);

    taskProcess.emit('close', 0, null);
  });

  it('completion captures branch and commit hash in summary', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await familiar.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    // Emit stdout then close the task process
    taskProcess.stdout!.emit('data', Buffer.from('hello world\n'));
    taskProcess.emit('close', 0, null);

    const response = await responsePromise;

    expect(response.status).toBe('completed');
    expect(response.requestId).toBe('req-1');
    expect(response.actionId).toBe('action-1');
    expect(response.outputs.exitCode).toBe(0);
    expect(response.outputs.summary).toMatch(/experiment\/action-1-[0-9a-f]{8}/);
    expect(response.outputs.summary).toContain('abc123def456');
  });

  it('kill terminates process without removing worktree', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest({ inputs: { command: 'sleep 60' } });
    const handle = await familiar.start(request);

    // Register onComplete before kill so close event is handled
    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    // When kill sends SIGTERM, simulate process exit
    const origKill = process.kill;
    vi.spyOn(process, 'kill').mockImplementation((_pid, _signal?) => {
      // Simulate the process closing after receiving the signal
      setTimeout(() => taskProcess.emit('close', null, 'SIGTERM'), 0);
      return true;
    });

    await familiar.kill(handle);

    // Worktrees are intentionally preserved so users can inspect task output
    const removeCalls = mockedSpawn.mock.calls.filter(
      (call) =>
        call[0] === 'git' &&
        (call[1] as string[])?.includes('worktree') &&
        (call[1] as string[])?.includes('remove'),
    );
    expect(removeCalls.length).toBe(0);

    vi.mocked(process.kill).mockRestore();
  });

  it('destroyAll kills processes without removing worktrees', async () => {
    const taskProcesses: Array<ChildProcess & EventEmitter> = [];

    // Override spawn to return unique task processes
    mockedSpawn.mockImplementation((cmd: string, args?: readonly string[], _options?: any) => {
      if (cmd === 'git') {
        const gitProc = createMockProcess();
        Promise.resolve().then(() => {
          const argsArr = args as string[];
          if (argsArr?.includes('rev-parse')) {
            gitProc.stdout!.emit('data', Buffer.from('abc123\n'));
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

      const tp = createMockProcess();
      taskProcesses.push(tp);
      return tp as any;
    });

    const handle1 = await familiar.start(
      makeRequest({ requestId: 'req-1', actionId: 'action-1', inputs: { command: 'sleep 60' } }),
    );
    const handle2 = await familiar.start(
      makeRequest({ requestId: 'req-2', actionId: 'action-2', inputs: { command: 'sleep 60' } }),
    );

    expect(taskProcesses).toHaveLength(2);

    // Simulate processes closing when SIGTERM is sent
    vi.spyOn(process, 'kill').mockImplementation((_pid, _signal?) => {
      for (const tp of taskProcesses) {
        if (!(tp as any)._closed) {
          (tp as any)._closed = true;
          setTimeout(() => tp.emit('close', null, 'SIGTERM'), 0);
        }
      }
      return true;
    });

    await familiar.destroyAll();

    // Worktrees are intentionally preserved so users can inspect task output
    const removeCalls = mockedSpawn.mock.calls.filter(
      (call) =>
        call[0] === 'git' &&
        (call[1] as string[])?.includes('worktree') &&
        (call[1] as string[])?.includes('remove'),
    );
    expect(removeCalls.length).toBe(0);

    vi.mocked(process.kill).mockRestore();
  });

  it('handles git worktree creation failure gracefully', async () => {
    setupSpawnMock();

    // Mock pool.acquireWorktree to reject
    (familiar as any).pool.acquireWorktree.mockRejectedValue(
      new Error('bash exited with code 128: fatal: not a git repository'),
    );

    const request = makeRequest();
    await expect(familiar.start(request)).rejects.toThrow('not a git repository');
  });

  it('onOutput relays stdout and stderr from task process', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await familiar.start(request);

    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    taskProcess.stdout!.emit('data', Buffer.from('stdout line\n'));
    taskProcess.stderr!.emit('data', Buffer.from('stderr line\n'));

    expect(output).toContain('stdout line\n');
    expect(output).toContain('stderr line\n');

    // Cleanup
    taskProcess.emit('close', 0, null);
  });

  it('reconciliation requests return needs_input without spawning', async () => {
    setupSpawnMock();

    const request = makeRequest({
      actionType: 'reconciliation',
      inputs: {},
    });

    const handle = await familiar.start(request);

    const response = await new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    expect(response.status).toBe('needs_input');
    expect(response.outputs.summary).toBe('Select winning experiment');

    const pool = (familiar as any).pool;
    expect(pool.acquireWorktree).toHaveBeenCalledTimes(1);
    expect(handle.workspacePath).toMatch(/^\/fake\/worktrees\//);
    expect(handle.branch).toMatch(/^experiment\/action-1-[0-9a-f]{8}$/);

    // No non-git spawn should have occurred
    const taskCalls = mockedSpawn.mock.calls.filter(
      (call) => call[0] !== 'git',
    );
    expect(taskCalls).toHaveLength(0);
  });

  it('sendInput writes to the task process stdin', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest({ inputs: { command: 'cat' } });
    const handle = await familiar.start(request);

    familiar.sendInput(handle, 'hello\n');
    expect((taskProcess.stdin as any).write).toHaveBeenCalledWith('hello\n');

    // Cleanup
    taskProcess.emit('close', 0, null);
  });

  it('getTerminalSpec returns worktree directory for command tasks', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await familiar.start(request);
    const spec = familiar.getTerminalSpec(handle);

    expect(spec).toBeDefined();
    expect(spec!.cwd).toMatch(/^\/fake\/worktrees\//);
    expect(spec!.command).toBeUndefined();

    // Cleanup
    taskProcess.emit('close', 0, null);
  });

  it('handle.workspacePath is set to worktree directory', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await familiar.start(request);

    expect(handle.workspacePath).toBeDefined();
    expect(handle.workspacePath).toMatch(/^\/fake\/worktrees\//);

    // Cleanup
    taskProcess.emit('close', 0, null);
  });

  it('getTerminalSpec returns null for unknown handle', () => {
    const spec = familiar.getTerminalSpec({ executionId: 'nonexistent', taskId: 'x' });
    expect(spec).toBeNull();
  });

  it('retains worktree and annotates startup error metadata when provisioning fails', async () => {
    setupSpawnMock();

    const release = vi.fn().mockResolvedValue(undefined);
    const softRelease = vi.fn();
    const branch = 'experiment/action-1-abc12345';
    const worktreePath = '/fake/worktrees/experiment-action-1-abc12345';
    const pool = {
      ensureClone: vi.fn().mockResolvedValue('/fake/cache/clone'),
      acquireWorktree: vi.fn().mockResolvedValue({
        clonePath: '/fake/cache/clone',
        worktreePath,
        branch,
        release,
        softRelease,
      }),
      destroyAll: vi.fn().mockResolvedValue(undefined),
      getClonePath: vi.fn().mockReturnValue('/fake/cache/clone'),
    };
    (familiar as any).pool = pool;
    vi.spyOn(familiar as any, 'provisionWorktree').mockRejectedValue(new Error('lockfile mismatch'));

    const err = await familiar.start(makeRequest()).catch((e: unknown) => e as Error & { workspacePath?: string; branch?: string });

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('lockfile mismatch');
    expect(err.workspacePath).toBe(worktreePath);
    expect(err.branch).toBe(branch);
    expect(softRelease).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  // ── Upstream branch merging ────────────────────────────────────

  describe('upstream branch merging', () => {
    it('merges upstream branches into the worktree after creation', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/dep-1', 'experiment/dep-2'],
        },
      });
      await familiar.start(request);

      // setupTaskBranch uses runBash for merging. Verify the merge script contains both branches.
      const runBashMock = vi.mocked((BaseFamiliar.prototype as any).runBash);
      const mergeCall = runBashMock.mock.calls.find(
        (call) => call[0].includes('Invoker: merge'),
      );
      expect(mergeCall).toBeDefined();
      expect(mergeCall![0]).toContain('experiment/dep-1');
      expect(mergeCall![0]).toContain('experiment/dep-2');

      taskProcess.emit('close', 0, null);
    });

    it('skips merging when upstreamBranches is empty', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: { command: 'echo hello', upstreamBranches: [] },
      });
      await familiar.start(request);

      // No merge script should be called
      const runBashMock = vi.mocked((BaseFamiliar.prototype as any).runBash);
      const mergeCall = runBashMock.mock.calls.find(
        (call) => call[0].includes('Invoker: merge'),
      );
      expect(mergeCall).toBeUndefined();

      taskProcess.emit('close', 0, null);
    });

    it('skips merging when upstreamBranches is undefined', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({ inputs: { command: 'echo hello' } });
      await familiar.start(request);

      const runBashMock = vi.mocked((BaseFamiliar.prototype as any).runBash);
      const mergeCall = runBashMock.mock.calls.find(
        (call) => call[0].includes('Invoker: merge'),
      );
      expect(mergeCall).toBeUndefined();

      taskProcess.emit('close', 0, null);
    });

    it('includes upstream branch names in merge script', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/dep-task-abc123'],
        },
      });
      await familiar.start(request);

      const runBashMock = vi.mocked((BaseFamiliar.prototype as any).runBash);
      const mergeCall = runBashMock.mock.calls.find(
        (call) => call[0].includes('Invoker: merge'),
      );
      expect(mergeCall).toBeDefined();
      expect(mergeCall![0]).toContain('experiment/dep-task-abc123');

      taskProcess.emit('close', 0, null);
    });

    it('merge script handles multiple upstream branches', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/fork1-add-api-hash1', 'experiment/fork2-caching-hash2'],
        },
      });
      await familiar.start(request);

      const runBashMock = vi.mocked((BaseFamiliar.prototype as any).runBash);
      const mergeCall = runBashMock.mock.calls.find(
        (call) => call[0].includes('Invoker: merge'),
      );
      expect(mergeCall).toBeDefined();
      expect(mergeCall![0]).toContain('experiment/fork1-add-api-hash1');
      expect(mergeCall![0]).toContain('experiment/fork2-caching-hash2');

      taskProcess.emit('close', 0, null);
    });

    it('fails the task start when merge conflicts occur', async () => {
      setupSpawnMock();

      vi.mocked((BaseFamiliar.prototype as any).runBash).mockImplementation(
        async (script: string) => {
          if (script.includes('PRESERVED=')) {
            return 'PRESERVED=0\nBASE_SHA=abc123\n';
          }
          if (script.includes('Invoker: merge')) {
            const err = new Error('bash exited with code 31: merge conflict');
            (err as any).exitCode = 31;
            (err as any).stderr = 'MERGE_CONFLICT_BRANCH=experiment/conflicting\nMERGE_CONFLICT_FILE=file.ts';
            throw err;
          }
          return '';
        },
      );

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/conflicting'],
        },
      });

      const handle = await familiar.start(request);
      expect(handle).toBeDefined();

      const response = await new Promise<WorkResponse>((resolve) => {
        familiar.onComplete(handle, resolve);
      });
      expect(response.status).toBe('failed');
      expect(response.outputs?.exitCode).toBe(1);
      const errObj = JSON.parse(response.outputs!.error!);
      expect(errObj.type).toBe('merge_conflict');
      expect(errObj.failedBranch).toBe('experiment/conflicting');
      expect(errObj.conflictFiles).toContain('file.ts');
    });

    it('error message includes conflict file details', async () => {
      setupSpawnMock();

      vi.mocked((BaseFamiliar.prototype as any).runBash).mockImplementation(
        async (script: string) => {
          if (script.includes('PRESERVED=')) {
            return 'PRESERVED=0\nBASE_SHA=abc123\n';
          }
          if (script.includes('Invoker: merge')) {
            const err = new Error('bash exited with code 31: merge conflict');
            (err as any).exitCode = 31;
            (err as any).stderr = 'MERGE_CONFLICT_BRANCH=experiment/conflicting\nMERGE_CONFLICT_FILE=App.tsx';
            throw err;
          }
          return '';
        },
      );

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/conflicting'],
        },
      });

      const handle = await familiar.start(request);
      const response = await new Promise<WorkResponse>((resolve) => {
        familiar.onComplete(handle, resolve);
      });
      expect(response.status).toBe('failed');
      const errObj = JSON.parse(response.outputs!.error!);
      expect(errObj.type).toBe('merge_conflict');
      expect(errObj.conflictFiles).toContain('App.tsx');
    });

    it('gives clear error when upstream branch does not exist', async () => {
      setupSpawnMock();

      vi.mocked((BaseFamiliar.prototype as any).runBash).mockImplementation(
        async (script: string) => {
          if (script.includes('PRESERVED=')) {
            return 'PRESERVED=0\nBASE_SHA=abc123\n';
          }
          if (script.includes('Invoker: merge')) {
            const err = new Error('bash exited with code 30: missing ref');
            (err as any).exitCode = 30;
            (err as any).stderr = 'MISSING_REF=experiment/nonexistent-branch';
            throw err;
          }
          return '';
        },
      );

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/nonexistent-branch'],
        },
      });

      await expect(familiar.start(request)).rejects.toThrow();
    });
  });

  // ── Claude CLI tests ──────────────────────────────────────────

  describe('claude action type', () => {
    it('spawns claude CLI with session ID instead of echo stub', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        cacheDir: '/fake/cache',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });
      mockPool(claudeFamiliar);

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'ai_task',
        inputs: { prompt: 'test prompt' },
      });
      const handle = await claudeFamiliar.start(request);

      // Verify the command is the claude command, not /bin/bash echo
      const taskCall = mockedSpawn.mock.calls.find(
        ([cmd, args]) => cmd !== 'git' && !(cmd === '/bin/bash' && (args as string[])?.[1]?.includes('pnpm install')),
      );
      expect(taskCall).toBeDefined();
      expect(taskCall![0]).toBe('/bin/echo');

      const args = taskCall![1] as string[];
      expect(args).toContain('--session-id');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('-p');
      expect(args).toContain('test prompt');

      // Verify session ID is set on handle
      expect(handle.agentSessionId).toBeDefined();
      expect(handle.agentSessionId).toMatch(/^[0-9a-f-]+$/);

      // Cleanup
      taskProcess.emit('close', 0, null);
    });

    it('prepends upstream context to prompt', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        cacheDir: '/fake/cache',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });
      mockPool(claudeFamiliar);

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'ai_task',
        inputs: {
          prompt: 'do the thing',
          upstreamContext: [
            { taskId: 'dep-1', description: 'setup task', summary: 'done' },
          ],
        },
      });
      await claudeFamiliar.start(request);

      const taskCall = mockedSpawn.mock.calls.find(
        ([cmd, args]) => cmd !== 'git' && !(cmd === '/bin/bash' && (args as string[])?.[1]?.includes('pnpm install')),
      );
      const args = taskCall![1] as string[];
      const promptArg = args[args.indexOf('-p') + 1];
      expect(promptArg).toContain('Upstream task: dep-1');
      expect(promptArg).toContain('do the thing');

      taskProcess.emit('close', 0, null);
    });

    it('includes agentSessionId in completion response outputs', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        cacheDir: '/fake/cache',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });
      mockPool(claudeFamiliar);

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'ai_task',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      const responsePromise = new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      taskProcess.emit('close', 0, null);
      const response = await responsePromise;

      expect(response.outputs.agentSessionId).toBe(handle.agentSessionId);
    });

    it('getTerminalSpec returns claude --resume for claude tasks', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        cacheDir: '/fake/cache',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });
      mockPool(claudeFamiliar);

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'ai_task',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);
      const spec = claudeFamiliar.getTerminalSpec(handle);

      expect(spec).toBeDefined();
      expect(spec!.command).toBe('claude');
      expect(spec!.args).toContain('--resume');
      expect(spec!.args).toContain(handle.agentSessionId);
      expect(spec!.cwd).toMatch(/^\/fake\/worktrees\//);

      taskProcess.emit('close', 0, null);
    });

    it('does not set agentSessionId for command tasks', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({ inputs: { command: 'echo hello' } });
      const handle = await familiar.start(request);

      expect(handle.agentSessionId).toBeUndefined();

      taskProcess.emit('close', 0, null);
    });

    it('uses ignore for stdin when actionType is claude', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        cacheDir: '/fake/cache',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });
      mockPool(claudeFamiliar);

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'ai_task',
        inputs: { prompt: 'test' },
      });
      await claudeFamiliar.start(request);

      const taskCall = mockedSpawn.mock.calls.find(
        (call) => call[0] !== 'git',
      );
      const options = taskCall![2] as { stdio: any[] };
      expect(options.stdio[0]).toBe('ignore');

      taskProcess.emit('close', 0, null);
    });
  });

  describe('baseBranch start point', () => {
    it('uses baseBranch for rev-parse and worktree add start point', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: { command: 'echo hello', baseBranch: 'master' },
      });
      await familiar.start(request);

      // Short branch names resolve via origin/<branch> after fetch (plan base on remote tip)
      const gitCalls = mockedSpawn.mock.calls.filter((call) => call[0] === 'git');
      const fetchCall = gitCalls.find((call) => {
        const args = call[1] as string[];
        return args[0] === 'fetch' && args[1] === 'origin';
      });
      expect(fetchCall).toBeDefined();
      const revParseCall = gitCalls.find((call) => {
        const args = (call[1] as string[]).join(' ');
        return args.includes('rev-parse') && args.includes('origin/master');
      });
      expect(revParseCall).toBeDefined();

      // pool.acquireWorktree should have been called with the branch
      const pool = (familiar as any).pool;
      expect(pool.acquireWorktree).toHaveBeenCalledTimes(1);

      taskProcess.emit('close', 0, null);
    });

    it('falls back to HEAD when baseBranch is not provided', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: { command: 'echo hello' },
      });
      await familiar.start(request);

      // rev-parse should target HEAD (default)
      const gitCalls = mockedSpawn.mock.calls.filter((call) => call[0] === 'git');
      const revParseCall = gitCalls.find(
        (call) => (call[1] as string[])?.[0] === 'rev-parse' && (call[1] as string[])?.[1] === 'HEAD',
      );
      expect(revParseCall).toBeDefined();

      // pool.acquireWorktree should have been called
      const pool = (familiar as any).pool;
      expect(pool.acquireWorktree).toHaveBeenCalledTimes(1);

      taskProcess.emit('close', 0, null);
    });

    it('baseBranch changes content-addressable branch hash', () => {
      const hashWithMaster = computeBranchHash('t1', 'cmd', undefined, [], 'master-sha');
      const hashWithDev = computeBranchHash('t1', 'cmd', undefined, [], 'dev-sha');
      expect(hashWithMaster).not.toBe(hashWithDev);
    });
  });

  describe('stale worktree on restart', () => {
    it('pool.acquireWorktree is called with the content-addressable branch name', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest();
      const handle = await familiar.start(request);
      expect(handle).toBeDefined();

      const pool = (familiar as any).pool;
      expect(pool.acquireWorktree).toHaveBeenCalledTimes(1);
      const [, calledBranch] = pool.acquireWorktree.mock.calls[0];
      expect(calledBranch).toMatch(/^experiment\/action-1-[0-9a-f]{8}$/);

      taskProcess.emit('close', 0, null);
    });

    it('still fails if pool.acquireWorktree rejects', async () => {
      setupSpawnMock();

      (familiar as any).pool.acquireWorktree.mockRejectedValue(
        new Error("bash exited with code 128: fatal: branch is already used by worktree at '/old/worktree'"),
      );

      const request = makeRequest();
      await expect(familiar.start(request)).rejects.toThrow(/already used by worktree/);
    });

    it('start succeeds when pool.acquireWorktree succeeds (no conflict)', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest();
      const handle = await familiar.start(request);
      expect(handle).toBeDefined();
      expect(handle.workspacePath).toMatch(/^\/fake\/worktrees\//);

      taskProcess.emit('close', 0, null);
    });
  });

  describe('getRestoredTerminalSpec', () => {
    const baseMeta: PersistedTaskMeta = {
      taskId: 'task-wt-1',
      familiarType: 'worktree',
    };

    afterEach(() => {
      vi.mocked(existsSync).mockReset();
    });

    it('returns cwd spec when worktree exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        workspacePath: '/home/user/.invoker/worktrees/wt-abc',
      });
      expect(spec).toEqual({ cwd: '/home/user/.invoker/worktrees/wt-abc' });
    });

    it('returns claude --resume spec with cwd when session exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        workspacePath: '/home/user/.invoker/worktrees/wt-abc',
        agentSessionId: 'session-wt-1',
      });
      expect(spec).toEqual({
        command: 'claude',
        args: ['--resume', 'session-wt-1', '--dangerously-skip-permissions'],
        cwd: '/home/user/.invoker/worktrees/wt-abc',
      });
    });

    it('throws when worktree path no longer exists', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(() =>
        familiar.getRestoredTerminalSpec({
          ...baseMeta,
          workspacePath: '/home/user/.invoker/worktrees/deleted-wt',
        }),
      ).toThrow(/no longer exists.*cleaned up/);
    });

    it('returns git checkout when workspacePath and branch are set', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        workspacePath: '/fake/repo',
        branch: 'plan/my-workflow',
      });
      expect(spec.command).toBe('bash');
      expect(spec.cwd).toBe('/fake/repo');
      expect(spec.args![1]).toContain("git checkout 'plan/my-workflow'");
      expect(spec.args![1]).not.toContain('worktree add');
    });

    it('returns git checkout when workspacePath is a worktree path and branch is set', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        workspacePath: '/fake/worktrees/wt-abc',
        branch: 'plan/my-workflow',
      });
      expect(spec.command).toBe('bash');
      expect(spec.cwd).toBe('/fake/worktrees/wt-abc');
      expect(spec.args![1]).toContain("git checkout 'plan/my-workflow'");
      expect(spec.args![1]).not.toContain('worktree add');
    });

    it('returns spec with undefined cwd when no workspace path', () => {
      const spec = familiar.getRestoredTerminalSpec(baseMeta);
      expect(spec).toEqual({ cwd: undefined });
    });
  });

  describe('git availability pre-flight check', () => {
    beforeEach(() => {
      BaseFamiliar.resetGitAvailableCheck();
    });

    it('throws when git is not available', async () => {
      const spy = vi.spyOn(
        BaseFamiliar.prototype as any,
        'execGitSimple',
      ).mockRejectedValueOnce(
        new Error('Failed to spawn git: spawn git ENOENT'),
      );

      const familiar = new WorktreeFamiliar({
        cacheDir: '/tmp/fake-cache',
        worktreeBaseDir: '/tmp/fake-worktrees',
      });
      const request = {
        requestId: 'req-1',
        actionId: 'test',
        actionType: 'command' as const,
        inputs: { command: 'echo hi', description: 'test', repoUrl: 'git@github.com:test/repo.git' },
        callbackUrl: '',
        timestamps: { createdAt: new Date().toISOString() },
      };
      await expect(familiar.start(request)).rejects.toThrow(
        'git is not available on PATH',
      );
      spy.mockRestore();
    });
  });
});
