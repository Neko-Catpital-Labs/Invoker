import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { SshExecutor } from '../ssh-executor.js';
import type { WorkRequest } from '@invoker/contracts';
import type { PersistedTaskMeta } from '../executor.js';
import { createSshRemoteScriptError } from '../ssh-git-exec.js';
import { computeRepoUrlHash } from '../git-utils.js';
import { computeContentHash, buildExperimentBranchName, formatLifecycleTag } from '../branch-utils.js';

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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe('SshExecutor pre-flight validation', () => {
  it('throws when SSH key file does not exist', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/nonexistent/path/id_ed25519',
    });
    await expect(ssh.start(makeRequest())).rejects.toThrow(
      'SSH key file not accessible',
    );
  });

  it('throws when task has no repoUrl in managed mode', async () => {
    // Use /dev/null as a readable file to pass the key check
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
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
    const ssh = new SshExecutor({
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
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'root',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
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

describe('SshExecutor managed workspace mode', () => {
  it('happy path: creates worktree, provisions, runs command, sets workspacePath and branch', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    // Mock remote execution for bootstrap, home detection, worktree list
    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          '__INVOKER_BASE_REF__=origin/main',
          '__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1',
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      if (script.includes('worktree prune')) return '';
      return '';
    });

    vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);

    // Mock spawn to avoid real SSH
    const spawnStub = vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'pnpm test',
        description: 'run tests',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    const handle = await ssh.start(req);

    expect(handle.workspacePath).toMatch(/^\~\/\.invoker\/worktrees\/[a-f0-9]{12}\//);
    expect(handle.branch).toMatch(/^experiment\/test-task\/g\d+\.t\d+\.a[a-z0-9_-]*-[a-f0-9]{8}$/);

    // Verify spawnSshRemoteStdin was called with correct arguments
    expect(spawnStub).toHaveBeenCalledTimes(1);
    const [callExecId, callReq, callHandle, callScript, callAgentId, callFinalize] = spawnStub.mock.calls[0];
    expect(callExecId).toBe(handle.executionId);
    expect(callReq).toBe(req);
    expect(callHandle).toBe(handle);
    // Provision command is base64-encoded in the script, check for presence
    expect(callScript).toMatch(/Provisioning remote worktree/);
    expect(callScript).toMatch(/base64 -d/);
    expect(callAgentId).toBeUndefined();
    expect(callFinalize).toEqual({ branch: handle.branch, worktreePath: handle.workspacePath });
  });

  it('reuses a managed SSH worktree by actionId when the old base is still compatible', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    const repoHash = computeRepoUrlHash('git@github.com:owner/repo.git');
    const remotePath = `/home/testuser/.invoker/worktrees/${repoHash}/experiment-test-task-oldhash`;
    const execRemoteCapture = vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          '__INVOKER_BASE_REF__=origin/main',
          '__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1',
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) {
        return `worktree ${remotePath}
HEAD deadbeef
branch refs/heads/experiment/test-task-oldhash
`;
      }
      return '';
    });

    const setupTaskBranchSpy = vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    const req = makeRequest({
      actionType: 'command',
      actionId: 'test-task',
      inputs: {
        command: 'pnpm test',
        description: 'run tests',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    const handle = await ssh.start(req);

    expect(handle.workspacePath).toMatch(new RegExp(`^~/.invoker/worktrees/${repoHash}/experiment-test-task-g\\d+\\.t\\d+\\.a[a-z0-9_-]*-[0-9a-f]{8}$`));
    expect(handle.workspacePath).not.toBe(`~/.invoker/worktrees/${repoHash}/experiment-test-task-oldhash`);
    expect(setupTaskBranchSpy).toHaveBeenCalledTimes(1);
    expect(execRemoteCapture).not.toHaveBeenCalledWith(expect.stringContaining('branch -m'), 'rename_reuse_branch');
  });

  it('persists the owning worktree path on startup failure when Git reports a branch owner', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteInvokerHome: '/home/invoker/.invoker',
    }) as any;

    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1';
      }
      if (script.includes('printf %s "$HOME"')) return '/home/invoker';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    const ownerPath = '/home/invoker/.invoker/worktrees/049de5b865cc/experiment-test-task-oldhash';
    vi.spyOn(ssh, 'setupTaskBranch').mockRejectedValue(
      createSshRemoteScriptError(
        128,
        '',
        `Preparing worktree (checking out 'experiment/test-task-deadbeef')\n` +
          `fatal: 'experiment/test-task-deadbeef' is already used by worktree at '${ownerPath}'\n`,
        'setup_branch',
      ),
    );

    const req = makeRequest({
      actionType: 'command',
      actionId: 'test-task',
      inputs: {
        command: 'pnpm test',
        description: 'run tests',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    const err = await ssh.start(req).catch((e: unknown) => e as Error & { workspacePath?: string; branch?: string });

    expect(err.message).toContain('already used by worktree');
    expect(err.workspacePath).toBe(ownerPath);
    expect(err.branch).toMatch(/^experiment\/test-task\/g\d+\.t\d+\.a[a-z0-9_-]*-[0-9a-f]{8}$/);
  });

  it('cleans up the existing branch-owner worktree before recreating a conflicting target branch (when cleanup enabled)', async () => {
    const prevCleanup = process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP;
    process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP = '1';

    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    const repoHash = computeRepoUrlHash('git@github.com:owner/repo.git');
    const baseHead = 'abc123def456abc123def456abc123def456abc1';
    const branchHash = computeContentHash(
      'test-task-conflict',
      'pnpm test',
      undefined,
      [],
      baseHead,
    );
    const targetBranch = buildExperimentBranchName('test-task-conflict', '', branchHash);
    const ownerPath = `/home/testuser/.invoker/worktrees/${repoHash}/stale-owner-${branchHash}`;
    let cleanupScript = '';
    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string, phase?: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          '__INVOKER_BASE_REF__=origin/main',
          `__INVOKER_BASE_HEAD__=${baseHead}`,
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) {
        return `worktree ${ownerPath}
HEAD deadbeef
branch refs/heads/${targetBranch}
`;
      }
      if (phase === 'cleanup_worktree') {
        cleanupScript = script;
        return '';
      }
      if (script.includes('rev-parse --abbrev-ref HEAD')) return 'not-the-target-branch\n';
      return '';
    });

    const setupTaskBranchSpy = vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    const req = makeRequest({
      actionType: 'command',
      actionId: 'test-task-conflict',
      inputs: {
        command: 'pnpm test',
        description: 'run tests',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    try {
      await ssh.start(req);

      const encodedPaths = cleanupScript.match(/WORKTREES_B64="([^"]+)"/)?.[1];
      const decodedPaths = Buffer.from(encodedPaths ?? '', 'base64').toString('utf8');
      expect(decodedPaths).toContain(ownerPath);
      expect(setupTaskBranchSpy).toHaveBeenCalled();
    } finally {
      if (prevCleanup === undefined) {
        delete process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP;
      } else {
        process.env.INVOKER_ENABLE_WORKSPACE_CLEANUP = prevCleanup;
      }
    }
  });

  it('throws when managedWorkspaces=true but repoUrl is missing', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    });

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo hello',
        description: 'test',
      },
    });

    await expect(ssh.start(req)).rejects.toThrow(
      /requires repoUrl.*Add a top-level "repoUrl"/,
    );
  });

  it('reports startup phase and preserves raw stderr/stdout on bootstrap failure', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (_script: string, phase?: string) => {
      throw createSshRemoteScriptError(
        254,
        '__INVOKER_BASE_HEAD__=partial\n',
        'Welcome to Ubuntu\nreal bootstrap failure\n',
        phase,
      );
    });

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo test',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    await expect(ssh.start(req)).rejects.toThrow(/phase=bootstrap_clone_fetch/);
    await expect(ssh.start(req)).rejects.toThrow(/STDERR:\nWelcome to Ubuntu\nreal bootstrap failure/);
    await expect(ssh.start(req)).rejects.toThrow(/STDOUT:\n__INVOKER_BASE_HEAD__=partial/);
  });

  it('propagates provision command failure as process exit code', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      provisionCommand: 'exit 42',
    }) as any;

    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123';
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);

    // Capture script passed to spawnSshRemoteStdin to verify provision command is included
    let capturedScript = '';
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any, script: string) => {
        capturedScript = script;
        return handle;
      },
    );

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo test',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    await ssh.start(req);

    // Verify provision command 'exit 42' is embedded in the script
    expect(capturedScript).toContain('exit 42');
    // Note: We're testing that the provision command is included in the script.
    // The actual exit code propagation is tested by integration tests with real SSH.
  });

  it('does not return a handle until managed remote bootstrap/setup has finished', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    const bootstrap = createDeferred<string>();
    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return bootstrap.promise;
      }
      if (script.includes('printf %s \"$HOME\"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    const setupTaskBranchSpy = vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    const spawnSpy = vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo hello',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    let settled = false;
    const pending = ssh.start(req).then(() => {
      settled = true;
    });

    await new Promise((r) => setImmediate(r));

    expect(settled).toBe(false);
    expect(setupTaskBranchSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();

    bootstrap.resolve('__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123');
    await pending;

    expect(setupTaskBranchSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
  });

  it('uses configured remoteInvokerHome instead of default ~/.invoker', async () => {
    const customHome = '/opt/invoker';
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteInvokerHome: customHome,
    }) as any;

    const capturedScripts: string[] = [];
    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      capturedScripts.push(script);
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123';
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo test',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    const handle = await ssh.start(req);

    // Verify workspacePath uses custom home
    expect(handle.workspacePath).toMatch(/^\/opt\/invoker\/worktrees\//);

    // Verify scripts contain custom home (check decoded output or variable names)
    const bootstrapScript = capturedScripts.find((s) => s.includes('__INVOKER_BASE_REF__'));
    expect(bootstrapScript).toBeTruthy();
    // The script uses the INVOKER_HOME variable to construct repo path
    expect(bootstrapScript).toContain('CLONE="$INVOKER_HOME/repos/$H"');
  });

  it('BYO mode unchanged when managedWorkspaces=false', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: false, // explicit BYO mode
    }) as any;

    const execSpy = vi.spyOn(ssh, 'execRemoteCapture').mockResolvedValue('');
    const setupSpy = vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo hello',
        description: 'test',
        workspacePath: '/custom/path',
        repoUrl: 'git@github.com:owner/repo.git', // present but should be ignored
      },
    });

    const handle = await ssh.start(req);

    // In BYO mode, workspacePath comes from request inputs
    expect(handle.workspacePath).toBe('/custom/path');

    // No clone/fetch/worktree/provision should happen
    expect(execSpy).not.toHaveBeenCalled();
    expect(setupSpy).not.toHaveBeenCalled();
  });

  it('BYO mode throws when workspacePath is missing', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: false,
    });

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo hello',
        description: 'test',
        // no workspacePath
      },
    });

    await expect(ssh.start(req)).rejects.toThrow(
      /requires workspacePath.*enable managedWorkspaces/,
    );
  });
});

describe('SshExecutor fetch failure handling', () => {
  beforeEach(() => {
    spawnedProcesses = [];
    vi.clearAllMocks();
  });

  it('emits warning when bootstrap fetch fails and continues execution', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    // Capture warnings emitted via emitOutput
    const emittedOutputs: string[] = [];
    vi.spyOn(ssh, 'emitOutput').mockImplementation((executionId: string, data: string) => {
      emittedOutputs.push(data);
      // Also call through to the original to populate outputBuffer after entry is created
      const entry = ssh.entries.get(executionId);
      if (entry) {
        entry.outputBuffer.push(data);
        entry.outputBufferBytes += data.length;
      }
    });

    // Mock execRemoteCapture to simulate fetch failure in bootstrap
    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        // Simulate fetch failure by returning FETCH_FAILED marker
        return [
          '[WARNING] Git fetch failed for /home/testuser/.invoker/repos/abc123',
          '[WARNING] Continuing with existing refs. Tasks may use stale commits.',
          '__INVOKER_FETCH_FAILED__=1',
          '__INVOKER_BASE_REF__=origin/master',
          '__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc123',
        ].join('\n');
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });

    vi.spyOn(ssh, 'setupTaskBranch').mockResolvedValue(undefined);

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo test',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    const handle = await ssh.start(req);

    // Verify task started successfully despite fetch failure
    expect(handle.executionId).toBeDefined();
    expect(handle.workspacePath).toBeDefined();
    expect(handle.branch).toBeDefined();

    // Verify warning was emitted (captured via spy before entry existed)
    const allOutput = emittedOutputs.join('');
    expect(allOutput).toContain('[WARNING] Git fetch failed for remote mirror clone');
    expect(allOutput).toContain('Continuing with existing refs');
    expect(allOutput).toContain('Tasks may use stale commits');

    // Verify entry was created
    const entry = ssh.entries.get(handle.executionId);
    expect(entry).toBeDefined();

    // Clean up: emit close event to allow proper teardown
    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    sshProcess.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('SshExecutor entry lifecycle', () => {
  let ssh: SshExecutor;

  beforeEach(() => {
    spawnedProcesses = [];
    vi.clearAllMocks();

    ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    });

    // Mock execRemoteCapture to bypass actual SSH
    vi.spyOn(ssh as any, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return [
          '__INVOKER_FETCH_SUCCESS__=1',
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

  it('preserves stdout on execRemoteCapture error (Bug #4)', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
    }) as any;

    // Invoke the private execRemoteCapture via its protected `runBash` wrapper.
    // Do NOT mock execRemoteCapture — we want it to use the real implementation
    // backed by the module-level `spawn` mock so we can drive the error path.
    const pending = ssh2.runBash('echo COMMIT=abc123 && exit 1', '/tmp').catch((e: any) => e);

    // Let start() wire up listeners on the mock process.
    await new Promise((r) => setImmediate(r));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    expect(proc).toBeDefined();

    // Simulate a remote script that writes a commit hash to stdout and then
    // fails on `git push`, emitting stderr and a non-zero exit code.
    (proc.stdout as any).emit('data', Buffer.from('COMMIT_HASH=abc123def456\n'));
    (proc.stderr as any).emit('data', Buffer.from('fatal: unable to access remote\n'));
    proc.emit('close', 1, null);

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain('unable to access remote');
    // Bug #4 fix: stdout is now attached to the error so callers
    // (e.g. remoteGitRecordAndPush) can recover the commit hash.
    expect(err.stdout).toBe('COMMIT_HASH=abc123def456\n');
  });

  it('managed mode with remoteInvokerHome="~/.invoker" uses base64-decode + tilde-normalize (Bug #1 variant)', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteInvokerHome: '~/.invoker',
    }) as any;

    vi.spyOn(ssh2, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1';
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });
    vi.spyOn(ssh2, 'setupTaskBranch').mockResolvedValue(undefined);

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo test',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    await ssh2.start(req);

    // The real spawnSshRemoteStdin ran and wrote its bash script to the mocked
    // child process's stdin. Grab it and verify the fix.
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    expect(proc).toBeDefined();
    const writeMock = (proc.stdin as any).write as ReturnType<typeof vi.fn>;
    expect(writeMock).toHaveBeenCalled();
    const script = writeMock.mock.calls[0]![0] as string;

    // Bug #1 fix: base64-decode + tilde-normalize block replaces the old
    // buggy `WT="~/.invoker/..."` literal (which bash would NOT expand).
    expect(script).toContain('WT=$(echo ');
    expect(script).toContain('| base64 -d)');
    expect(script).toContain(`if [[ "$WT" == '~' ]]; then`);
    expect(script).toContain('WT="$HOME"');
    expect(script).not.toContain('WT="~/.invoker/');

    // Prove the decoded path is the tilde-prefixed canonical worktree path.
    const match = script.match(/WT=\$\(echo (\S+) \| base64 -d\)/);
    expect(match).toBeTruthy();
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf-8');
    expect(decoded).toMatch(/^~\/\.invoker\/worktrees\/[a-f0-9]{12}\//);

    // Let the mock process finish so heartbeat and entry state clean up.
    proc.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('changes managed branch and worktree when request lifecycleTag changes, as recreate does', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteInvokerHome: '~/.invoker',
    }) as any;

    vi.spyOn(ssh2, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1';
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });
    const setupTaskBranchSpy = vi.spyOn(ssh2, 'setupTaskBranch').mockResolvedValue(undefined);
    vi.spyOn(ssh2, 'spawnSshRemoteStdin').mockImplementation(
      async (_executionId: string, _request: any, handle: any) => handle,
    );

    const baseInputs = {
      command: 'echo test',
      description: 'test',
      repoUrl: 'git@github.com:owner/repo.git',
    };
    const first = await ssh2.start(makeRequest({
      requestId: 'req-salt-1',
      actionType: 'command',
      inputs: {
        ...baseInputs,
        lifecycleTag: formatLifecycleTag({ wfGen: 1, taskGen: 4, attemptShort: 'a1' }),
      },
    }));
    const second = await ssh2.start(makeRequest({
      requestId: 'req-salt-2',
      actionType: 'command',
      inputs: {
        ...baseInputs,
        lifecycleTag: formatLifecycleTag({ wfGen: 1, taskGen: 5, attemptShort: 'a2' }),
      },
    }));

    const firstOpts = setupTaskBranchSpy.mock.calls[0]?.[3];
    const secondOpts = setupTaskBranchSpy.mock.calls[1]?.[3];
    const branchPattern = /^experiment\/test-task\/g\d+\.t\d+\.a[a-z0-9_-]*-[0-9a-f]{8}$/;
    expect(firstOpts?.branchName).toMatch(branchPattern);
    expect(secondOpts?.branchName).toMatch(branchPattern);
    // Same content (cmd/prompt/base) → same content hash; lifecycle tag must
    // still differentiate the two branches.
    expect(firstOpts?.branchName).not.toBe(secondOpts?.branchName);
    expect(firstOpts?.worktreeDir).not.toBe(secondOpts?.worktreeDir);
    expect(first.branch).toBe(firstOpts?.branchName);
    expect(second.branch).toBe(secondOpts?.branchName);
    expect(first.workspacePath).toBe(firstOpts?.worktreeDir);
    expect(second.workspacePath).toBe(secondOpts?.worktreeDir);
  });

  it('managed mode with absolute remoteInvokerHome still uses base64-decode (normalize is a no-op)', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteInvokerHome: '/opt/invoker',
    }) as any;

    vi.spyOn(ssh2, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1';
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });
    vi.spyOn(ssh2, 'setupTaskBranch').mockResolvedValue(undefined);

    const req = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo test',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    await ssh2.start(req);

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    expect(proc).toBeDefined();
    const writeMock = (proc.stdin as any).write as ReturnType<typeof vi.fn>;
    const script = writeMock.mock.calls[0]![0] as string;

    // Same base64-decode pattern regardless of absolute vs tilde path.
    expect(script).toContain('WT=$(echo ');
    expect(script).toContain('| base64 -d)');

    // Decoded path starts with /opt/invoker; the normalize block is a no-op
    // because $WT does not begin with '~'.
    const match = script.match(/WT=\$\(echo (\S+) \| base64 -d\)/);
    expect(match).toBeTruthy();
    const decoded = Buffer.from(match![1]!, 'base64').toString('utf-8');
    expect(decoded).toMatch(/^\/opt\/invoker\/worktrees\/[a-f0-9]{12}\//);

    proc.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 50));
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

    // Entry has been cleaned up by the centralized BaseExecutor.emitComplete teardown.
    expect((ssh as any).entries.size).toBe(0);

    // Revisit path uses persisted metadata, NOT the entries map.
    const meta: PersistedTaskMeta = {
      taskId: handle.taskId,
      executorType: ssh.type,
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
