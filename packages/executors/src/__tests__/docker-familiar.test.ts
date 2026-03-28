import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta } from '../familiar.js';
import { BaseFamiliar } from '../base-familiar.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: 'req-1',
    actionId: 'action-1',
    actionType: 'command',
    inputs: { command: 'echo hello', repoUrl: 'https://github.com/test/repo.git' },
    callbackUrl: 'http://localhost:4000/api/worker/response',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

function createMockContainer(id = 'container-abc123') {
  const container = {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  return { container };
}

function createMockChildProcess() {
  const child = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 99999999;
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    setTimeout(() => child.emit('close', null, signal ?? 'SIGTERM'), 5);
    return true;
  });
  return child;
}

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockState = {
  containers: [] as ReturnType<typeof createMockContainer>[],
  createContainer: null as ReturnType<typeof vi.fn> | null,
  getContainer: null as ReturnType<typeof vi.fn> | null,
  ping: null as ReturnType<typeof vi.fn> | null,
};

vi.mock('dockerode', () => {
  const MockDocker = function (this: any) {
    this.createContainer = (...args: any[]) => mockState.createContainer!(...args);
    this.getContainer = (...args: any[]) => mockState.getContainer!(...args);
    this.ping = (...args: any[]) => mockState.ping!(...args);
  };
  return { default: MockDocker };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    writeFileSync: vi.fn(actual.writeFileSync),
    mkdirSync: vi.fn(actual.mkdirSync),
  };
});

/** Task child processes created during test — call .emit('close', code) to trigger completion. */
let taskChildren: ReturnType<typeof createMockChildProcess>[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    spawn: vi.fn((..._args: any[]) => {
      const child = createMockChildProcess();
      taskChildren.push(child);
      return child;
    }),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DockerFamiliar', () => {
  let DockerFamiliar: typeof import('../docker-familiar.js').DockerFamiliar;
  let familiar: InstanceType<typeof DockerFamiliar>;

  // Spies on BaseFamiliar lifecycle methods
  let syncFromRemoteSpy: ReturnType<typeof vi.spyOn>;
  let setupTaskBranchSpy: ReturnType<typeof vi.spyOn>;
  let handleProcessExitSpy: ReturnType<typeof vi.spyOn>;
  let execRemoteCaptureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    mockState.containers = [];
    taskChildren = [];

    mockState.createContainer = vi.fn().mockImplementation(() => {
      const mc = createMockContainer(`container-${mockState.containers.length}`);
      mockState.containers.push(mc);
      return Promise.resolve(mc.container);
    });

    mockState.getContainer = vi.fn().mockImplementation((id: string) => {
      const mc = mockState.containers.find((c) => c.container.id === id);
      if (!mc) throw new Error(`No such container: ${id}`);
      return mc.container;
    });

    mockState.ping = vi.fn().mockResolvedValue('OK');

    const mod = await import('../docker-familiar.js');
    DockerFamiliar = mod.DockerFamiliar;

    // Mock execRemoteCapture to bypass docker exec CLI for git config
    execRemoteCaptureSpy = vi.spyOn(
      DockerFamiliar.prototype as any, 'execRemoteCapture',
    ).mockResolvedValue('');

    // Mock lifecycle methods so we don't need real git
    syncFromRemoteSpy = vi.spyOn(
      BaseFamiliar.prototype as any, 'syncFromRemote',
    ).mockResolvedValue(undefined);

    setupTaskBranchSpy = vi.spyOn(
      BaseFamiliar.prototype as any, 'setupTaskBranch',
    ).mockImplementation(async (_cwd: string, _request: WorkRequest, handle: FamiliarHandle, opts?: any) => {
      handle.branch = opts?.branchName ?? `experiment/${_request.actionId}-00000000`;
      return undefined;
    });

    handleProcessExitSpy = vi.spyOn(
      BaseFamiliar.prototype as any, 'handleProcessExit',
    ).mockResolvedValue(undefined);

    familiar = new DockerFamiliar({
      workspaceDir: '/tmp',
      callbackPort: 4000,
      claudeConfigDir: '/tmp',
      sshDir: '/tmp',
      repoInImage: true,
    });
  });

  afterEach(async () => {
    await familiar.destroyAll();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Container configuration
  // -------------------------------------------------------------------------

  it('creates container with idle command (tail -f /dev/null)', async () => {
    await familiar.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    expect(createArgs.Cmd).toEqual(['tail', '-f', '/dev/null']);
    expect(createArgs.Entrypoint).toEqual([]);
  });

  it('does NOT bind-mount workspaceDir into container', async () => {
    await familiar.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const binds: string[] = createArgs.HostConfig.Binds;
    const appBinds = binds.filter((b: string) => b.endsWith(':/app') || b.includes(':/app:'));
    expect(appBinds).toHaveLength(0);
  });

  it('mounts SSH keys at both /root/.ssh and /home/invoker/.ssh', async () => {
    await familiar.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const binds: string[] = createArgs.HostConfig.Binds;
    expect(binds).toContainEqual(expect.stringContaining(':/home/invoker/.ssh:ro'));
    expect(binds).toContainEqual(expect.stringContaining(':/root/.ssh:ro'));
  });

  it('does NOT include GIT_SSH_COMMAND in container env', async () => {
    await familiar.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const env: string[] = createArgs.Env;
    const sshEnv = env.find((e: string) => e.startsWith('GIT_SSH_COMMAND='));
    expect(sshEnv).toBeUndefined();
  });

  it('still mounts .claude directory', async () => {
    await familiar.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const binds: string[] = createArgs.HostConfig.Binds;
    const claudeBind = binds.find((b: string) => b.includes('.claude'));
    expect(claudeBind).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // Git lifecycle delegation to BaseFamiliar
  // -------------------------------------------------------------------------

  it('calls execRemoteCapture for one-time git config', async () => {
    await familiar.start(makeRequest());

    expect(execRemoteCaptureSpy).toHaveBeenCalledWith(
      expect.stringContaining('git config --global core.sshCommand'),
    );
    expect(execRemoteCaptureSpy).toHaveBeenCalledWith(
      expect.stringContaining('git config --global user.email'),
    );
  });

  it('calls syncFromRemote with /app', async () => {
    await familiar.start(makeRequest());

    expect(syncFromRemoteSpy).toHaveBeenCalledWith('/app', expect.any(String));
  });

  it('calls setupTaskBranch with /app and content-addressable branch', async () => {
    await familiar.start(makeRequest());

    expect(setupTaskBranchSpy).toHaveBeenCalledWith(
      '/app',
      expect.objectContaining({ actionId: 'action-1' }),
      expect.any(Object),
      expect.objectContaining({
        branchName: expect.stringMatching(/^experiment\/action-1-[0-9a-f]{8}$/),
      }),
    );
  });

  it('sets handle.branch from setupTaskBranch', async () => {
    const handle = await familiar.start(makeRequest());
    expect(handle.branch).toMatch(/^experiment\/action-1-[0-9a-f]{8}$/);
  });

  // -------------------------------------------------------------------------
  // Task execution via docker exec CLI
  // -------------------------------------------------------------------------

  it('spawns task command via docker exec as host user', async () => {
    const { spawn } = await import('node:child_process');
    await familiar.start(makeRequest());

    // The last spawn call should be the task execution
    expect(spawn).toHaveBeenCalledWith(
      'docker',
      expect.arrayContaining(['exec', '-i']),
      expect.objectContaining({ detached: true }),
    );

    // Verify it uses the container ID and runs the task command
    const lastCall = (spawn as any).mock.calls[(spawn as any).mock.calls.length - 1];
    const dockerArgs: string[] = lastCall[1];
    expect(dockerArgs).toContain('exec');
    expect(dockerArgs).toContain('-i');
    // Should contain the task command somewhere
    const bashArg = dockerArgs[dockerArgs.length - 1];
    expect(bashArg).toContain('echo hello');
  });

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  it('calls handleProcessExit on task child close', async () => {
    await familiar.start(makeRequest({ requestId: 'req-exit', actionId: 'act-exit' }));

    // Find the task child (last one created)
    const taskChild = taskChildren[taskChildren.length - 1];
    taskChild.emit('close', 0, null);

    // Allow async handler to run
    await new Promise((r) => setTimeout(r, 50));

    expect(handleProcessExitSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ actionId: 'act-exit' }),
      '/app',
      0,
      expect.objectContaining({ branch: expect.stringMatching(/^experiment\/act-exit-[0-9a-f]{8}$/) }),
    );
  });

  it('stops container after handleProcessExit completes', async () => {
    await familiar.start(makeRequest());

    const mc = mockState.containers[0];
    const taskChild = taskChildren[taskChildren.length - 1];
    taskChild.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 50));

    expect(mc.container.stop).toHaveBeenCalledWith({ t: 5 });
  });

  it('passes non-zero exit code to handleProcessExit', async () => {
    await familiar.start(makeRequest());

    const taskChild = taskChildren[taskChildren.length - 1];
    taskChild.emit('close', 1, null);

    await new Promise((r) => setTimeout(r, 50));

    expect(handleProcessExitSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      '/app',
      1,
      expect.any(Object),
    );
  });

  // -------------------------------------------------------------------------
  // Claude tasks
  // -------------------------------------------------------------------------

  describe('claude action type', () => {
    it('sets claudeSessionId on handle', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test', repoUrl: 'https://github.com/test/repo.git' },
      });
      const handle = await familiar.start(request);
      expect(handle.claudeSessionId).toBeDefined();
      expect(handle.claudeSessionId).toMatch(/^[0-9a-f-]+$/);
    });

    it('does not set claudeSessionId for command actions', async () => {
      const handle = await familiar.start(makeRequest());
      expect(handle.claudeSessionId).toBeUndefined();
    });

    it('passes ANTHROPIC_API_KEY to container environment', async () => {
      const familiarWithKey = new DockerFamiliar({
        workspaceDir: '/tmp',
        claudeConfigDir: '/tmp',
        sshDir: '/tmp',
        repoInImage: true,
        anthropicApiKey: 'sk-test-key-123',
      });

      await familiarWithKey.start(makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test', repoUrl: 'https://github.com/test/repo.git' },
      }));

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;
      expect(env).toContainEqual('ANTHROPIC_API_KEY=sk-test-key-123');
    });

    it('getTerminalSpec returns docker start + exec claude --resume for claude tasks', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test', repoUrl: 'https://github.com/test/repo.git' },
      });
      const handle = await familiar.start(request);
      const spec = familiar.getTerminalSpec(handle);
      const cid = mockState.containers[0].container.id;

      expect(spec).toBeDefined();
      expect(spec!.command).toBe('bash');
      const bashCmd = spec!.args![1];
      expect(bashCmd).toContain(`docker start ${cid}`);
      expect(bashCmd).toContain(`docker exec -it ${cid} claude --resume ${handle.claudeSessionId}`);
    });
  });

  // -------------------------------------------------------------------------
  // Container lifecycle
  // -------------------------------------------------------------------------

  it('kill stops and removes container', async () => {
    const handle = await familiar.start(makeRequest());

    const mc = mockState.containers[0];
    await familiar.kill(handle);

    expect(mc.container.stop).toHaveBeenCalledWith({ t: 5 });
    expect(mc.container.remove).toHaveBeenCalled();
  });

  it('getTerminalSpec returns docker start + exec bash for command tasks', async () => {
    const handle = await familiar.start(makeRequest());
    const spec = familiar.getTerminalSpec(handle);
    const cid = mockState.containers[0].container.id;
    expect(spec).toEqual({
      command: 'bash',
      args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} /bin/bash`],
    });
  });

  it('getTerminalSpec returns null for unknown handle', () => {
    const spec = familiar.getTerminalSpec({ executionId: 'nonexistent', taskId: 'x' });
    expect(spec).toBeNull();
  });

  // -------------------------------------------------------------------------
  // repoInImage modes
  // -------------------------------------------------------------------------

  describe('repoInImage: false (default, uses DockerPool)', () => {
    it('calls DockerPool to create cached image when repoInImage is false', async () => {
      let callCount = 0;
      const origCreate = mockState.createContainer!;
      mockState.createContainer = vi.fn().mockImplementation((...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          const mc = createMockContainer('container-clone');
          mockState.containers.push(mc);
          (mc.container as any).wait = vi.fn().mockResolvedValue({ StatusCode: 0 });
          (mc.container as any).commit = vi.fn().mockResolvedValue(undefined);
          return Promise.resolve(mc.container);
        }
        return origCreate(...args);
      });

      const poolFamiliar = new DockerFamiliar({
        workspaceDir: '/tmp',
        claudeConfigDir: '/tmp',
        sshDir: '/tmp',
        repoInImage: false,
      });

      await poolFamiliar.start(makeRequest({
        inputs: { command: 'echo test', repoUrl: 'https://github.com/test/repo.git' },
      }));

      // 2 containers: clone (DockerPool) + task
      expect(mockState.createContainer).toHaveBeenCalledTimes(2);

      const cloneArgs = mockState.createContainer!.mock.calls[0][0];
      expect(cloneArgs.Entrypoint).toEqual(['/bin/sh']);
      expect(cloneArgs.Cmd[1]).toContain('git clone https://github.com/test/repo.git /app');

      const taskArgs = mockState.createContainer!.mock.calls[1][0];
      expect(taskArgs.Cmd).toEqual(['tail', '-f', '/dev/null']);
    });
  });

  describe('repoInImage: true (skip DockerPool)', () => {
    it('uses image directly without calling DockerPool', async () => {
      await familiar.start(makeRequest());

      expect(mockState.createContainer).toHaveBeenCalledTimes(1);

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      expect(createArgs.Image).toBe('invoker-agent:latest');
    });
  });

  // -------------------------------------------------------------------------
  // getRestoredTerminalSpec
  // -------------------------------------------------------------------------

  describe('getRestoredTerminalSpec', () => {
    const baseMeta: PersistedTaskMeta = {
      taskId: 'task-docker-1',
      familiarType: 'docker',
      containerId: 'container-abc123',
    };

    it('returns docker exec bash spec when no session', () => {
      const spec = familiar.getRestoredTerminalSpec(baseMeta);
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain('docker start container-abc123');
      expect(spec.args![1]).toContain('/bin/bash');
      expect(spec.args![1]).not.toContain('claude --resume');
    });

    it('returns docker exec claude --resume spec with session', () => {
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        claudeSessionId: 'session-docker-1',
      });
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain('docker start container-abc123');
      expect(spec.args![1]).toContain('claude --resume session-docker-1');
      expect(spec.args![1]).toContain('--dangerously-skip-permissions');
    });

    it('throws when no container ID provided', () => {
      expect(() =>
        familiar.getRestoredTerminalSpec({
          taskId: 'task-no-container',
          familiarType: 'docker',
        }),
      ).toThrow(/No container ID found/);
    });
  });

  // -------------------------------------------------------------------------
  // Docker daemon availability check
  // -------------------------------------------------------------------------

  describe('Docker daemon availability check', () => {
    it('throws when Docker daemon is not reachable', async () => {
      mockState.ping!.mockRejectedValueOnce(
        new Error('connect ENOENT /var/run/docker.sock'),
      );

      const f = new DockerFamiliar({ workspaceDir: '/tmp', repoInImage: true });
      const request = makeRequest();
      await expect(f.start(request)).rejects.toThrow(
        'Docker daemon is not reachable',
      );
    });
  });
});
