import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SshFamiliar } from '../ssh-familiar.js';
import type { WorkRequest } from '@invoker/contracts';
import type { PersistedTaskMeta } from '../familiar.js';

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'test-task',
    actionType: 'command',
    inputs: { command: 'echo hello', description: 'test' },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();

  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
  (proc as any).pid = 12345;
  (proc as any).killed = false;
  proc.kill = vi.fn().mockReturnValue(true);

  return proc;
}

// ---------------------------------------------------------------------------
// Module-level spawn mock
//
// vi.mock is hoisted to the top of the file at compile time, so the factory
// must reference module-scoped state (not describe-scoped locals).
// ---------------------------------------------------------------------------
let spawnedProcesses: Array<ChildProcess & EventEmitter> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('node:child_process');
  return {
    ...actual,
    spawn: vi.fn((..._args: any[]) => {
      const proc = createMockProcess();
      spawnedProcesses.push(proc);
      return proc;
    }),
  };
});

describe('SshFamiliar pre-flight validation', () => {
  it('throws when SSH key file does not exist', async () => {
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/nonexistent/path/id_ed25519',
    });
    await expect(ssh.start(makeRequest())).rejects.toThrow(
      'SSH key file not accessible',
    );
  });

  it('throws when task has no repoUrl', async () => {
    // Use /dev/null as a readable file to pass the key check
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/dev/null',
    });
    const req = makeRequest({
      inputs: {
        command: 'cd packages/app && pnpm test',
        description: 'test',
      },
    });
    await expect(ssh.start(req)).rejects.toThrow(
      'requires repoUrl',
    );
  });

  it('does not throw for reconciliation requests', async () => {
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/nonexistent/path/id_ed25519',
    });
    const req = makeRequest({ actionType: 'reconciliation' });
    const handle = await ssh.start(req);
    expect(handle).toBeDefined();
    expect(handle.executionId).toBeDefined();
  });

  it('falls back to a resolvable base ref when requested baseBranch is missing on remote', async () => {
    const ssh = new SshFamiliar({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/dev/null',
    }) as any;

    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          "__INVOKER_BASE_WARNING__=Requested base 'plan/nonexistent' not found; falling back to 'origin/master'.",
          '__INVOKER_BASE_REF__=origin/master',
          '__INVOKER_BASE_HEAD__=0123456789abcdef0123456789abcdef01234567',
          '',
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/root';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    const setupTaskBranchSpy = vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(async (_executionId: string, _request: any, handle: any) => handle);

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo hello',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
        baseBranch: 'plan/nonexistent',
      },
    });

    const handle = await ssh.start(req);
    expect(handle.workspacePath).toContain('/.invoker/worktrees/');
    expect(setupTaskBranchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ base: 'origin/master' }),
    );
  });
});

describe('SshFamiliar entry lifecycle', () => {
  let ssh: SshFamiliar;

  beforeEach(() => {
    spawnedProcesses = [];
    vi.clearAllMocks();

    ssh = new SshFamiliar({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
    });

    // Mock execRemoteCapture to bypass actual SSH
    vi.spyOn(ssh as any, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          '__INVOKER_BASE_REF__=origin/master',
          '__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc123',
          '',
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      if (script.includes('git rev-parse HEAD')) return 'abc123def456\n';
      return '';
    });

    // Mock setupTaskBranch
    vi.spyOn(ssh as any, 'setupTaskBranch').mockResolvedValue(undefined);

    // Mock mergeRequestUpstreamBranches
    vi.spyOn(ssh as any, 'mergeRequestUpstreamBranches').mockResolvedValue(undefined);
  });

  it('decreases entries.size after terminal close', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    const handle = await ssh.start(request);

    expect((ssh as any).entries.size).toBe(1);

    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 250));

    expect((ssh as any).entries.size).toBe(0);
  });

  it('removes entry state on spawn error', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    const handle = await ssh.start(request);

    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('error', new Error('spawn ENOENT'));

    await new Promise((r) => setTimeout(r, 250));

    expect((ssh as any).entries.size).toBe(0);
  });

  it('does not leak listeners or timers on spawn error', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    const handle = await ssh.start(request);

    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('error', new Error('spawn ENOENT'));

    await new Promise((r) => setTimeout(r, 250));

    const entry = (ssh as any).entries.get(handle.executionId);
    expect(entry).toBeUndefined();
  });

  it('destroyAll remains idempotent after completion', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    await ssh.start(request);

    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 250));

    await ssh.destroyAll();
    expect((ssh as any).entries.size).toBe(0);

    await expect(ssh.destroyAll()).resolves.toBeUndefined();
  });

  it('destroyAll remains idempotent after failure', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    await ssh.start(request);

    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('close', 1, null);

    await new Promise((r) => setTimeout(r, 250));

    await ssh.destroyAll();
    expect((ssh as any).entries.size).toBe(0);

    await expect(ssh.destroyAll()).resolves.toBeUndefined();
  });

  it('getRestoredTerminalSpec still returns a valid spec after entry cleanup', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    const handle = await ssh.start(request);

    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 50));

    // Entry has been cleaned up by the centralized BaseFamiliar.emitComplete teardown.
    expect((ssh as any).entries.size).toBe(0);

    // Revisit path uses persisted metadata, NOT the entries map.
    const meta: PersistedTaskMeta = {
      taskId: handle.taskId,
      familiarType: ssh.type,
      // Remote-style path so getRestoredTerminalSpec hits the isRemotePath branch.
      workspacePath: handle.workspacePath ?? '/home/testuser/.invoker/worktrees/test',
      branch: handle.branch,
      executionAgent: 'claude',
    };

    const spec = ssh.getRestoredTerminalSpec(meta);
    expect(spec).toBeTruthy();
    expect(spec.command).toBe('ssh');
    expect(spec.args).toBeTruthy();
    expect(spec.args!.length).toBeGreaterThan(0);
  });
});
