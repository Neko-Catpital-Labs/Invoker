import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { Writable, Readable } from 'node:stream';

// Mock child_process before importing WorktreeFamiliar
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

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
        gitProc.emit('close', 0, null);
      });

      return gitProc as any;
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

describe('WorktreeFamiliar', () => {
  let familiar: WorktreeFamiliar;

  beforeEach(() => {
    vi.clearAllMocks();
    familiar = new WorktreeFamiliar({
      repoDir: '/fake/repo',
      worktreeBaseDir: '/fake/worktrees',
    });
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

    // Verify git worktree add was called
    const gitCalls = mockedSpawn.mock.calls.filter(
      (call) => call[0] === 'git',
    );
    expect(gitCalls.length).toBeGreaterThanOrEqual(1);

    const worktreeAddCall = gitCalls.find(
      (call) => {
        const a = call[1] as string[];
        return a?.includes('worktree') && a?.includes('add');
      },
    );
    expect(worktreeAddCall).toBeDefined();

    const worktreeArgs = worktreeAddCall![1] as string[];
    expect(worktreeArgs).toContain('add');
    expect(worktreeArgs).toContain('-b');
    expect(worktreeArgs).toContain('experiment/action-1');

    // Cleanup: emit close on task process to prevent hanging
    taskProcess.emit('close', 0, null);
  });

  it('task runs in worktree directory, not main repo', async () => {
    const { taskProcess } = setupSpawnMock();

    const request = makeRequest({ inputs: { command: 'make test' } });
    await familiar.start(request);

    // Find the non-git spawn call (the task process)
    const taskCall = mockedSpawn.mock.calls.find(
      (call) => call[0] !== 'git',
    );
    expect(taskCall).toBeDefined();

    const options = taskCall![2] as { cwd: string };
    // The cwd should be under the worktree base dir, not the main repo
    expect(options.cwd).toMatch(/^\/fake\/worktrees\//);
    expect(options.cwd).not.toBe('/fake/repo');

    // Cleanup
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
    // Summary should contain the branch and commit hash
    expect(response.outputs.summary).toContain('experiment/action-1');
    expect(response.outputs.summary).toContain('abc123def456');
  });

  it('kill terminates process and removes worktree', async () => {
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

    // Verify git worktree remove was called
    const removeCalls = mockedSpawn.mock.calls.filter(
      (call) =>
        call[0] === 'git' &&
        (call[1] as string[])?.includes('remove'),
    );
    expect(removeCalls.length).toBeGreaterThanOrEqual(1);

    vi.mocked(process.kill).mockRestore();
  });

  it('destroyAll removes all worktrees', async () => {
    const taskProcesses: Array<ChildProcess & EventEmitter> = [];

    // Override spawn to return unique task processes
    let callCount = 0;
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

    // Verify worktree remove was called for cleanup
    const removeCalls = mockedSpawn.mock.calls.filter(
      (call) =>
        call[0] === 'git' &&
        (call[1] as string[])?.includes('remove'),
    );
    expect(removeCalls.length).toBeGreaterThanOrEqual(2);

    vi.mocked(process.kill).mockRestore();
  });

  it('handles git worktree creation failure gracefully', async () => {
    // Prune succeeds but worktree add fails on both attempts
    mockedSpawn.mockImplementation((cmd: string, args?: readonly string[], _options?: any) => {
      const gitProc = createMockProcess();
      if (cmd === 'git') {
        const argsArr = args as string[];
        Promise.resolve().then(() => {
          if (argsArr?.includes('prune')) {
            gitProc.emit('close', 0, null);
          } else {
            gitProc.stderr!.emit('data', Buffer.from('fatal: not a git repository\n'));
            gitProc.emit('close', 128, null);
          }
        });
        return gitProc as any;
      }

      return createMockProcess() as any;
    });

    const request = makeRequest();
    await expect(familiar.start(request)).rejects.toThrow('Failed to create worktree');
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

      const gitCalls = mockedSpawn.mock.calls.filter(
        (call) => call[0] === 'git',
      );
      const mergeCalls = gitCalls.filter(
        (call) => (call[1] as string[])?.[0] === 'merge',
      );

      expect(mergeCalls).toHaveLength(2);
      expect((mergeCalls[0][1] as string[])).toEqual(['merge', '--no-edit', 'experiment/dep-1']);
      expect((mergeCalls[1][1] as string[])).toEqual(['merge', '--no-edit', 'experiment/dep-2']);

      // Merge should run in the worktree directory, not the main repo
      const mergeOptions = mergeCalls.map((call) => call[2] as { cwd: string });
      for (const opt of mergeOptions) {
        expect(opt.cwd).toMatch(/^\/fake\/worktrees\//);
      }

      taskProcess.emit('close', 0, null);
    });

    it('skips merging when upstreamBranches is empty', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        inputs: { command: 'echo hello', upstreamBranches: [] },
      });
      await familiar.start(request);

      const gitCalls = mockedSpawn.mock.calls.filter(
        (call) => call[0] === 'git',
      );
      const mergeCalls = gitCalls.filter(
        (call) => (call[1] as string[])?.[0] === 'merge',
      );

      expect(mergeCalls).toHaveLength(0);

      taskProcess.emit('close', 0, null);
    });

    it('skips merging when upstreamBranches is undefined', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({ inputs: { command: 'echo hello' } });
      await familiar.start(request);

      const gitCalls = mockedSpawn.mock.calls.filter(
        (call) => call[0] === 'git',
      );
      const mergeCalls = gitCalls.filter(
        (call) => (call[1] as string[])?.[0] === 'merge',
      );

      expect(mergeCalls).toHaveLength(0);

      taskProcess.emit('close', 0, null);
    });

    it('fails the task start when merge conflicts occur', async () => {
      // Override spawn to make merge commands fail
      const taskProcess = createMockProcess();
      let taskReturned = false;

      mockedSpawn.mockImplementation((cmd: string, args?: readonly string[], _options?: any) => {
        if (cmd === 'git') {
          const gitProc = createMockProcess();
          Promise.resolve().then(() => {
            const argsArr = args as string[];
            if (argsArr?.[0] === 'merge') {
              gitProc.stderr!.emit('data', Buffer.from('CONFLICT (content): Merge conflict\n'));
              gitProc.emit('close', 1, null);
            } else {
              if (argsArr?.includes('rev-parse')) {
                gitProc.stdout!.emit('data', Buffer.from('abc123\n'));
              }
              gitProc.emit('close', 0, null);
            }
          });
          return gitProc as any;
        }
        if (!taskReturned) {
          taskReturned = true;
          return taskProcess as any;
        }
        return createMockProcess() as any;
      });

      const request = makeRequest({
        inputs: {
          command: 'echo hello',
          upstreamBranches: ['experiment/conflicting'],
        },
      });

      await expect(familiar.start(request)).rejects.toThrow();
    });
  });

  // ── Claude CLI tests ──────────────────────────────────────────

  describe('claude action type', () => {
    it('spawns claude CLI with session ID instead of echo stub', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        repoDir: '/fake/repo',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test prompt' },
      });
      const handle = await claudeFamiliar.start(request);

      // Verify the command is the claude command, not /bin/sh echo
      const taskCall = mockedSpawn.mock.calls.find(
        (call) => call[0] !== 'git',
      );
      expect(taskCall).toBeDefined();
      expect(taskCall![0]).toBe('/bin/echo');

      const args = taskCall![1] as string[];
      expect(args).toContain('--session-id');
      expect(args).toContain('--dangerously-skip-permissions');
      expect(args).toContain('-p');
      expect(args).toContain('test prompt');

      // Verify session ID is set on handle
      expect(handle.claudeSessionId).toBeDefined();
      expect(handle.claudeSessionId).toMatch(/^[0-9a-f-]+$/);

      // Cleanup
      taskProcess.emit('close', 0, null);
    });

    it('prepends upstream context to prompt', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        repoDir: '/fake/repo',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'claude',
        inputs: {
          prompt: 'do the thing',
          upstreamContext: [
            { taskId: 'dep-1', description: 'setup task', summary: 'done' },
          ],
        },
      });
      await claudeFamiliar.start(request);

      const taskCall = mockedSpawn.mock.calls.find(
        (call) => call[0] !== 'git',
      );
      const args = taskCall![1] as string[];
      const promptArg = args[args.indexOf('-p') + 1];
      expect(promptArg).toContain('Upstream task: dep-1');
      expect(promptArg).toContain('do the thing');

      taskProcess.emit('close', 0, null);
    });

    it('includes claudeSessionId in completion response outputs', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        repoDir: '/fake/repo',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      const responsePromise = new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      taskProcess.emit('close', 0, null);
      const response = await responsePromise;

      expect(response.outputs.claudeSessionId).toBe(handle.claudeSessionId);
    });

    it('getTerminalSpec returns claude --resume for claude tasks', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        repoDir: '/fake/repo',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);
      const spec = claudeFamiliar.getTerminalSpec(handle);

      expect(spec).toBeDefined();
      expect(spec!.command).toBe('claude');
      expect(spec!.args).toContain('--resume');
      expect(spec!.args).toContain(handle.claudeSessionId);
      expect(spec!.cwd).toMatch(/^\/fake\/worktrees\//);

      taskProcess.emit('close', 0, null);
    });

    it('does not set claudeSessionId for command tasks', async () => {
      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({ inputs: { command: 'echo hello' } });
      const handle = await familiar.start(request);

      expect(handle.claudeSessionId).toBeUndefined();

      taskProcess.emit('close', 0, null);
    });

    it('uses ignore for stdin when actionType is claude', async () => {
      const claudeFamiliar = new WorktreeFamiliar({
        repoDir: '/fake/repo',
        worktreeBaseDir: '/fake/worktrees',
        claudeCommand: '/bin/echo',
      });

      const { taskProcess } = setupSpawnMock();

      const request = makeRequest({
        actionType: 'claude',
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

  describe('stale worktree on restart', () => {
    it('fails when branch is still locked after prune (e.g. worktree dir on disk)', async () => {
      // Even after prune, if the old worktree dir still exists on disk,
      // git refuses to create a new worktree with the same branch.
      mockedSpawn.mockImplementation((cmd: string, args?: readonly string[]) => {
        const proc = createMockProcess();
        const argsArr = args as string[];

        Promise.resolve().then(() => {
          if (cmd === 'git' && argsArr?.includes('prune')) {
            proc.emit('close', 0, null);
          } else if (cmd === 'git' && argsArr?.includes('worktree') && argsArr?.includes('add')) {
            proc.stderr!.emit('data', Buffer.from(
              "fatal: 'experiment/action-1' is already used by worktree at '/old/worktree'\n",
            ));
            proc.emit('close', 128, null);
          } else {
            proc.emit('close', 0, null);
          }
        });

        return proc as any;
      });

      const request = makeRequest();
      await expect(familiar.start(request)).rejects.toThrow(/Failed to create worktree/);
    });

    it('succeeds after git worktree prune cleans stale references', async () => {
      let pruned = false;

      mockedSpawn.mockImplementation((cmd: string, args?: readonly string[]) => {
        const proc = createMockProcess();
        const argsArr = args as string[];

        Promise.resolve().then(() => {
          if (cmd === 'git' && argsArr?.includes('prune')) {
            pruned = true;
            proc.emit('close', 0, null);
          } else if (cmd === 'git' && argsArr?.includes('worktree') && argsArr?.includes('add')) {
            if (argsArr?.includes('-b') && !pruned) {
              // First attempt without prune would fail
              proc.stderr!.emit('data', Buffer.from("fatal: branch already exists\n"));
              proc.emit('close', 128, null);
            } else {
              proc.emit('close', 0, null);
            }
          } else if (cmd === 'git' && argsArr?.includes('rev-parse')) {
            proc.stdout!.emit('data', Buffer.from('abc123def456\n'));
            proc.emit('close', 0, null);
          } else {
            proc.emit('close', 0, null);
          }
        });

        return proc as any;
      });

      const request = makeRequest();
      const handle = await familiar.start(request);
      expect(handle).toBeDefined();
      expect(pruned).toBe(true);
    });
  });
});
