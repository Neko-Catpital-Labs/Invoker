import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  (proc as any).exitCode = null;
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

function extractRunnerScript(bootstrapScript: string): string {
  const match = bootstrapScript.match(/cat > "\$RUNNER_PATH" <<'([^']+)'\n([\s\S]*?)\n\1/);
  if (!match?.[2]) throw new Error('runner heredoc not found');
  return match[2];
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
  it('happy path: creates worktree, runs command, sets workspacePath and branch', async () => {
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
    expect(callScript).not.toMatch(/Provisioning remote worktree/);
    expect(callScript).not.toMatch(/base64 -d/);
    expect(callScript).toContain(`/runtime/ssh-executor/${callExecId}-test-task`);
    expect(callScript).toContain('RUNNER_PATH="$STAGING_DIR/runner.sh"');
    expect(callScript).toContain('PAYLOAD_PATH="$STAGING_DIR/payload.sh"');
    expect(callScript).not.toContain('PROVISION_PATH="$STAGING_DIR/provision.sh"');
    expect(callScript).toContain('cat > "$RUNNER_PATH" <<');
    expect(callScript).toContain('cat > "$PAYLOAD_PATH" <<');
    expect(callScript).not.toContain('cat > "$PROVISION_PATH" <<');
    expect(callScript).toContain('start_bootstrap_heartbeat');
    expect(callScript).toContain('stop_bootstrap_heartbeat');
    expect(callScript.indexOf('stop_bootstrap_heartbeat')).toBeLessThan(callScript.indexOf('"$RUNNER_PATH" "$PAYLOAD_PATH"'));
    expect(callScript).toContain('"$RUNNER_PATH" "$PAYLOAD_PATH"');
    expect(callScript).toContain('rm -rf "$STAGING_DIR"');
    expect(callScript).toContain("trap 'cleanup_runtime \"$?\"' EXIT");
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

  it('reuse_exact: sandbox-resets the worktree before mergeRequestUpstreamBranches', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
    }) as any;

    const repoHash = computeRepoUrlHash('git@github.com:owner/repo.git');
    const baseHead = 'aabbccddeeff00112233445566778899aabbccdd';
    const actionId = 'reuse-sandbox-test';
    const command = 'pnpm test';
    const lifecycleTag = '';
    const upstreamCommits: string[] = [];

    // Compute the exact branch the executor will derive from these inputs.
    // The executor uses request.inputs.prompt (not description) as the third arg.
    const contentHash = computeContentHash(actionId, command, undefined, upstreamCommits, baseHead);
    const experimentBranch = buildExperimentBranchName(actionId, lifecycleTag, contentHash);
    const san = experimentBranch.replace(/\//g, '-');
    const invokerHome = '/home/testuser/.invoker';
    const exactPath = `${invokerHome}/worktrees/${repoHash}/${san}`;

    const capturedCalls: Array<{ script: string; phase?: string }> = [];
    vi.spyOn(ssh, 'execRemoteCapture').mockImplementation(async (script: string, phase?: string) => {
      capturedCalls.push({ script, phase });
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return `__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=${baseHead}`;
      }
      if (script.includes('printf %s "$HOME"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) {
        // Return a porcelain listing that includes the exact canonical path with the right branch
        return [
          `worktree ${exactPath}`,
          `HEAD ${baseHead}`,
          `branch refs/heads/${experimentBranch}`,
          '',
        ].join('\n');
      }
      // Respond to the abbrev-ref HEAD inspection for reuse candidate
      if (script.includes('rev-parse --abbrev-ref HEAD')) {
        return experimentBranch;
      }
      return '';
    });

    const mergeUpstreamSpy = vi.spyOn(ssh, 'mergeRequestUpstreamBranches').mockResolvedValue(undefined);
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any) => handle,
    );

    await ssh.start(makeRequest({
      actionType: 'command',
      actionId,
      inputs: { command, description: 'sandbox reset test', repoUrl: 'git@github.com:owner/repo.git' },
    }));

    // sandbox_reset must have been called with the right script content
    const sandboxResetCall = capturedCalls.find(c => c.phase === 'sandbox_reset');
    expect(sandboxResetCall).toBeDefined();
    expect(sandboxResetCall?.script).toContain('git -C "$WT" reset --hard "$REF"');
    expect(sandboxResetCall?.script).toContain('git -C "$WT" clean -fd');

    // mergeRequestUpstreamBranches must have been called exactly once
    expect(mergeUpstreamSpy).toHaveBeenCalledTimes(1);

    // sandbox_reset (execRemoteCapture call) must be ordered before mergeRequestUpstreamBranches.
    // We verify this via invocationCallOrder so a future refactor cannot silently move
    // the reset after the merge without breaking this test.
    const sandboxResetCallIndex = capturedCalls.findIndex(c => c.phase === 'sandbox_reset');
    // execRemoteCapture is called once per capturedCalls entry; find which mock invocation
    // index corresponds to the sandbox_reset call.
    const execMock = vi.mocked(ssh.execRemoteCapture as unknown as (...args: any[]) => any);
    const sandboxResetInvocationOrder = execMock.mock.invocationCallOrder[sandboxResetCallIndex];
    const mergeInvocationOrder = mergeUpstreamSpy.mock.invocationCallOrder[0];
    expect(sandboxResetInvocationOrder).toBeDefined();
    expect(mergeInvocationOrder).toBeDefined();
    expect(sandboxResetInvocationOrder!).toBeLessThan(mergeInvocationOrder!);
  });

  it('staging dir is always evicted (rm -rf before mkdir) in buildRuntimeBootstrapScript', async () => {
    const ssh = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
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

    let capturedScript = '';
    vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
      (_executionId: string, _request: any, handle: any, script: string) => {
        capturedScript = script;
        return handle;
      },
    );

    await ssh.start(makeRequest({
      actionType: 'command',
      inputs: { command: 'echo hi', description: 'test', repoUrl: 'git@github.com:owner/repo.git' },
    }));

    // rm -rf must appear before mkdir -p in the bootstrap script
    const rmIndex = capturedScript.indexOf('rm -rf "$STAGING_DIR"');
    const mkdirIndex = capturedScript.indexOf('mkdir -p "$STAGING_DIR"');
    expect(rmIndex).toBeGreaterThanOrEqual(0);
    expect(mkdirIndex).toBeGreaterThanOrEqual(0);
    expect(rmIndex).toBeLessThan(mkdirIndex);
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
    const spawnStub = vi.spyOn(ssh, 'spawnSshRemoteStdin').mockImplementation(
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
    expect(spawnStub).toHaveBeenCalledTimes(1);
    const [callExecId, , , callScript] = spawnStub.mock.calls[0];
    expect(callScript).not.toContain('base64 -d');
    expect(callScript).toContain(`/runtime/ssh-executor/${callExecId}-test-task`);
    expect(callScript).toContain('RUNNER_PATH="$STAGING_DIR/runner.sh"');
    expect(callScript).toContain('PAYLOAD_PATH="$STAGING_DIR/payload.sh"');
    expect(callScript).not.toContain('cat > "$PROVISION_PATH"');
    expect(callScript).toContain('WT=$(normalize_remote_path \'/custom/path\')');
    expect(callScript).toContain('"$RUNNER_PATH" "$PAYLOAD_PATH"');
    expect(callScript).toContain('rm -rf "$STAGING_DIR"');
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

  it('keeps heartbeats alive while close finalization is pending', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });
    (ssh as any).heartbeatIntervalMs = 20;
    const finalizeDeferred = createDeferred<{ commitHash?: string; error?: string }>();
    vi.spyOn(ssh as any, 'remoteGitRecordAndPush').mockImplementation(() => finalizeDeferred.promise);

    const handle = await ssh.start(request);
    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    (sshProcess as any).exitCode = 0;

    let heartbeatCount = 0;
    let completed = false;
    ssh.onHeartbeat(handle, () => {
      heartbeatCount += 1;
    });
    ssh.onComplete(handle, () => {
      completed = true;
    });

    sshProcess.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 80));

    expect(completed).toBe(false);
    expect(heartbeatCount).toBeGreaterThan(0);

    finalizeDeferred.resolve({ commitHash: 'abc123' });
    await new Promise((r) => setTimeout(r, 80));
    expect(completed).toBe(true);
  });

  it('filters remote heartbeat markers from output and emits heartbeat events', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    const handle = await ssh.start(request);
    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    const outputChunks: string[] = [];
    let heartbeatCount = 0;
    ssh.onOutput(handle, (chunk) => outputChunks.push(chunk));
    ssh.onHeartbeat(handle, () => {
      heartbeatCount += 1;
    });

    (sshProcess.stdout as any).emit('data', Buffer.from('__INVOKER_REMOTE_HEARTBEAT__ 100\nhello\n'));
    (sshProcess.stdout as any).emit('data', Buffer.from('__INVOKER_REMOTE_HEARTBEAT__ 101\nworld'));
    sshProcess.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 80));
    expect(heartbeatCount).toBe(2);
    expect(outputChunks.join('')).toContain('hello\n');
    expect(outputChunks.join('')).toContain('world');
    expect(outputChunks.join('')).not.toContain('__INVOKER_REMOTE_HEARTBEAT__');
  });

  it('maps SSH exit 255 broken pipe into deterministic transport error', async () => {
    const request = makeRequest({
      inputs: {
        command: 'echo hello',
        repoUrl: 'git@github.com:test/repo.git',
      },
    });

    const handle = await ssh.start(request);
    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    const completion = new Promise<any>((resolve) => {
      ssh.onComplete(handle, (response) => resolve(response));
    });

    (sshProcess.stderr as any).emit('data', Buffer.from('client_loop: send disconnect: Broken pipe\n'));
    sshProcess.emit('close', 255, null);

    const response = await completion;
    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).toBe(255);
    expect(response.outputs.error).toContain('broken pipe');
  });

  it('includes SSH transport timeout/keepalive options in spawned SSH args', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
    }) as any;

    const pending = ssh2.runBash('echo ready', '/tmp');
    await new Promise((r) => setImmediate(r));
    const sshProcess = spawnedProcesses[spawnedProcesses.length - 1];
    (sshProcess.stdout as any).emit('data', Buffer.from('ready\n'));
    sshProcess.emit('close', 0, null);
    await pending;

    const childProcessMod = await import('node:child_process');
    const spawnMock = childProcessMod.spawn as unknown as ReturnType<typeof vi.fn>;
    const firstCallArgs = spawnMock.mock.calls[spawnMock.mock.calls.length - 1]?.[1] as string[];
    expect(firstCallArgs).toEqual(expect.arrayContaining([
      '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'BatchMode=yes',
    ]));
  });

  it('uses configured remote heartbeat interval from SSH target config', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteHeartbeatIntervalSeconds: 11,
    }) as any;

    vi.spyOn(ssh2, 'execRemoteCapture').mockImplementation(async (script: string) => {
      if (script.includes('__INVOKER_BASE_REF__=')) {
        return '__INVOKER_BASE_REF__=origin/main\n__INVOKER_BASE_HEAD__=abc123def456abc123def456abc123def456abc1';
      }
      if (script.includes('printf %s \"$HOME\"')) return '/home/testuser';
      if (script.includes('worktree list --porcelain')) return '';
      return '';
    });
    vi.spyOn(ssh2, 'setupTaskBranch').mockResolvedValue(undefined);

    await ssh2.start(makeRequest({
      actionType: 'command',
      inputs: {
        command: 'echo heartbeat',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    }));

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    expect(proc).toBeDefined();
    const writeMock = (proc.stdin as any).write as ReturnType<typeof vi.fn>;
    const script = writeMock.mock.calls[0]![0] as string;
    expect(script).toContain('INVOKER_HEARTBEAT_INTERVAL_SECONDS=11');
    expect(script).toContain('start_bootstrap_heartbeat');
    expect(script).toContain('stop_bootstrap_heartbeat');
    expect(script).toContain('RUNNER_PATH="$STAGING_DIR/runner.sh"');
    expect(script).toContain('"$RUNNER_PATH" "$PAYLOAD_PATH"');
    expect(script).not.toContain('base64 -d');
    proc.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 50));
  });

  it('runs the remote payload in the foreground while the heartbeat loop is backgrounded', async () => {
    const request = makeRequest({
      actionType: 'command',
      inputs: {
        command: 'exit 7',
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    const handle = await ssh.start(request);
    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    expect(proc).toBeDefined();
    const writeMock = (proc.stdin as any).write as ReturnType<typeof vi.fn>;
    const bootstrapScript = writeMock.mock.calls[0]![0] as string;
    const runnerScript = extractRunnerScript(bootstrapScript);

    expect(runnerScript).toContain('bash "$PAYLOAD_PATH"');
    expect(runnerScript).toContain('stop_heartbeat');
    expect(runnerScript).not.toContain('PAYLOAD_PID');
    expect(runnerScript).not.toContain('wait "$PAYLOAD_PID"');

    const fakeHome = mkdtempSync(join(tmpdir(), 'ssh-runner-foreground-home-'));
    try {
      const workspacePath = handle.workspacePath!.replace(/^~(?=\/|$)/, fakeHome);
      mkdirSync(workspacePath, { recursive: true });

      const childProcessModule = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const result = childProcessModule.spawnSync('/bin/bash', ['-c', bootstrapScript], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome },
      });

      expect(result.status).toBe(7);
      expect(result.stdout).toContain('__INVOKER_REMOTE_HEARTBEAT__');
      expect(result.stderr).not.toContain('wait_for');
      expect(result.stderr).not.toContain('No record of process');
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      proc.emit('close', 7, null);
      await new Promise((r) => setTimeout(r, 50));
    }
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

  it('managed mode with remoteInvokerHome="~/.invoker" stages runtime scripts and tilde-normalizes paths', async () => {
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

    // The workspace path is transported as a quoted literal and normalized on
    // the remote, avoiding the old buggy `WT="~/.invoker/..."` literal (which
    // bash would NOT expand) and avoiding base64 runtime delivery.
    expect(script).not.toContain('base64 -d');
    expect(script).toContain("INVOKER_HOME=$(normalize_remote_path '~/.invoker')");
    expect(script).toContain('WT=$(normalize_remote_path \'~/.invoker/worktrees/');
    expect(script).toContain(`if [[ "$path" == '~' ]]; then`);
    expect(script).not.toContain('WT="~/.invoker/');
    expect(script).toContain('RUNNER_PATH="$STAGING_DIR/runner.sh"');
    expect(script).toContain('PAYLOAD_PATH="$STAGING_DIR/payload.sh"');
    expect(script).not.toContain('PROVISION_PATH="$STAGING_DIR/provision.sh"');
    expect(script).toContain('"$RUNNER_PATH" "$PAYLOAD_PATH"');
    expect(script).toContain('rm -rf "$STAGING_DIR"');

    // Let the mock process finish so heartbeat and entry state clean up.
    proc.emit('close', 0, null);
    await new Promise((r) => setTimeout(r, 50));
  });
  it.skip('managed mode skips implicit provisioning and still reaches a Flutter payload', async () => {
    const ssh2 = new SshExecutor({
      host: 'localhost',
      user: 'testuser',
      sshKeyPath: '/dev/null',
      managedWorkspaces: true,
      remoteHeartbeatIntervalSeconds: 1,
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
        command: "printf 'ok\\n' > .invoker-flutter-bootstrap-ran",
        description: 'test',
        repoUrl: 'git@github.com:owner/repo.git',
      },
    });

    await ssh2.start(req);

    const proc = spawnedProcesses[spawnedProcesses.length - 1];
    expect(proc).toBeDefined();
    const writeMock = (proc.stdin as any).write as { mock: { calls: unknown[][] } };
    expect(writeMock.mock.calls.length).toBeGreaterThan(0);
    const script = writeMock.mock.calls[0]?.[0];
    expect(typeof script).toBe('string');

    const bootstrapScript = script as string;
    expect(bootstrapScript).not.toContain('"$PROVISION_PATH"');
    expect(bootstrapScript).not.toContain('. "$PROVISION_PATH"');

    const workspaceMatch = bootstrapScript.match(/WT=\$\(normalize_remote_path '([^']+)'\)/);
    if (!workspaceMatch?.[1]) {
      throw new Error('Managed SSH bootstrap did not embed a workspace path');
    }

    const fakeHome = mkdtempSync(join(tmpdir(), 'ssh-flutter-bootstrap-home-'));
    try {
      const workspacePath = workspaceMatch[1].replace(/^~(?=\/|$)/, fakeHome);
      const markerPath = join(workspacePath, '.invoker-flutter-bootstrap-ran');
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, 'pubspec.yaml'), 'name: flutter_fixture\n');

      const childProcessModule = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const result = childProcessModule.spawnSync('/bin/bash', ['-c', bootstrapScript], {
        encoding: 'utf8',
        env: { ...process.env, HOME: fakeHome },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('[SshExecutor] Running task payload...');
      expect(result.stdout).not.toContain('[provision]');
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
      proc.emit('close', 0, null);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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

  it('managed mode with absolute remoteInvokerHome stages scripts under that home', async () => {
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

    expect(script).not.toContain('base64 -d');
    expect(script).toContain("INVOKER_HOME=$(normalize_remote_path '/opt/invoker')");
    expect(script).toContain('STAGING_DIR="$INVOKER_HOME/runtime/ssh-executor/');
    expect(script).toContain('WT=$(normalize_remote_path \'/opt/invoker/worktrees/');
    expect(script).toContain('RUNNER_PATH="$STAGING_DIR/runner.sh"');
    expect(script).toContain('PAYLOAD_PATH="$STAGING_DIR/payload.sh"');
    expect(script).toContain('"$RUNNER_PATH" "$PAYLOAD_PATH"');

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
      runnerKind: ssh.type,
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
