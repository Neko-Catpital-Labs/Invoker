import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { WorkRequest } from '@invoker/protocol';
import type { Writable } from 'node:stream';

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
import { WorktreeFamiliar } from '../worktree-familiar.js';

const mockedSpawn = vi.mocked(spawn);

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'action-1',
    actionType: 'command',
    inputs: { command: 'echo hello' },
    callbackUrl: 'http://localhost:3000/callback',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
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
  let familiar: WorktreeFamiliar;

  beforeEach(() => {
    vi.clearAllMocks();
    familiar = new WorktreeFamiliar({
      repoDir: '/fake/repo',
      worktreeBaseDir: '/fake/worktrees',
    });
  });

  it('should preserve worktree after normal task completion', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest();
    const handle = await familiar.start(request);

    // Register onComplete listener
    const responsePromise = new Promise((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
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
    const handle = await familiar.start(request);

    // Register onComplete listener
    const responsePromise = new Promise((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    // Complete task successfully
    taskProcess.emit('close', 0, null);
    await responsePromise;

    // Wait 100ms for async cleanup
    await new Promise((r) => setTimeout(r, 100));

    // This WILL FAIL (size is 1) because entries are never deleted
    expect((familiar as any).entries.size).toBe(0);
  });

  it('should fetch from remote before branching when baseBranch is set', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest({
      inputs: { command: 'echo hello', baseBranch: 'main' },
    });
    await familiar.start(request);

    // Filter for git fetch calls
    const fetchCalls = mockedSpawn.mock.calls.filter(
      (call) =>
        call[0] === 'git' &&
        (call[1] as string[])?.[0] === 'fetch',
    );

    // This WILL FAIL (0 fetch calls) because start() never calls syncFromRemote
    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    taskProcess.emit('close', 0, null);
  });
});
