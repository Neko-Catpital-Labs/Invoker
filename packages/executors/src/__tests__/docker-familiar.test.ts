import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { PersistedTaskMeta } from '../familiar.js';

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

function createMockLogStream(): EventEmitter {
  return new EventEmitter();
}

function createMockContainer(id = 'container-abc123') {
  const logStream = createMockLogStream();

  let waitResolve: ((value: { StatusCode: number }) => void) | null = null;
  const waitPromise = new Promise<{ StatusCode: number }>((resolve) => {
    waitResolve = resolve;
  });

  const container = {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn().mockResolvedValue(logStream),
    wait: vi.fn().mockReturnValue(waitPromise),
  };

  return { container, logStream, waitResolve: waitResolve! };
}

// ---------------------------------------------------------------------------
// Module-level dockerode mock
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DockerFamiliar', () => {
  let DockerFamiliar: typeof import('../docker-familiar.js').DockerFamiliar;
  let familiar: InstanceType<typeof DockerFamiliar>;

  beforeEach(async () => {
    mockState.containers = [];

    // First createContainer call is from DockerPool.ensureImage (clone).
    // Subsequent calls are the actual task container.
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

    // repoInImage: true to skip DockerPool clone in most tests
    familiar = new DockerFamiliar({
      workspaceDir: '/tmp',
      callbackPort: 4000,
      claudeConfigDir: '/tmp',
      sshDir: '/tmp',
      repoInImage: true,
    });
  });

  afterEach(async () => {
    for (const mc of mockState.containers) {
      mc.waitResolve({ StatusCode: 0 });
    }
    await familiar.destroyAll();
  });

  // -------------------------------------------------------------------------
  // Isolation: no workspaceDir bind mount
  // -------------------------------------------------------------------------

  it('does NOT bind-mount workspaceDir into container', async () => {
    const request = makeRequest();
    await familiar.start(request);

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const binds: string[] = createArgs.HostConfig.Binds;

    // workspaceDir (/tmp) should NOT appear as /app mount
    const appBinds = binds.filter((b: string) => b.endsWith(':/app') || b.includes(':/app:'));
    expect(appBinds).toHaveLength(0);
  });

  it('still mounts .claude and .ssh directories', async () => {
    const request = makeRequest();
    await familiar.start(request);

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const binds: string[] = createArgs.HostConfig.Binds;

    const claudeBind = binds.find((b: string) => b.includes('.claude'));
    expect(claudeBind).toBeDefined();
    expect(claudeBind).not.toContain(':ro');
    expect(binds).toContainEqual(expect.stringContaining(':/home/invoker/.ssh:ro'));
  });

  // -------------------------------------------------------------------------
  // Git wrapper
  // -------------------------------------------------------------------------

  it('wraps command with git lifecycle script', async () => {
    const request = makeRequest();
    await familiar.start(request);

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const cmd: string[] = createArgs.Cmd;

    expect(cmd[0]).toBe('/bin/bash');
    expect(cmd[1]).toBe('-c');
    const script = cmd[2];
    expect(script).toContain('git fetch origin');
    expect(script).toContain('git checkout -B');
    expect(script).toContain('invoker/action-1');
    expect(script).toContain('echo hello');
    expect(script).toContain('git add -A');
    expect(script).toContain('git commit --allow-empty');
    expect(script).toContain('git push -u origin');
    expect(script).toContain('exit $TASK_EXIT');
  });

  it('sets handle.branch to the computed branch name', async () => {
    const request = makeRequest();
    const handle = await familiar.start(request);
    expect(handle.branch).toBe('invoker/action-1');
  });

  // -------------------------------------------------------------------------
  // Claude tasks
  // -------------------------------------------------------------------------

  describe('claude action type', () => {
    it('wraps claude CLI with git lifecycle but skips git add/commit (claude auto-commits)', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'analyze this code', repoUrl: 'https://github.com/test/repo.git' },
      });
      await familiar.start(request);

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const script: string = createArgs.Cmd[2];

      expect(script).toContain('claude');
      expect(script).toContain('--session-id');
      expect(script).toContain('git fetch origin');
      expect(script).toContain('git push -u origin');
      // Should NOT contain git add/commit for claude tasks
      expect(script).not.toContain('git add -A');
      expect(script).not.toContain('git commit');
    });

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
  // Completion
  // -------------------------------------------------------------------------

  it('onComplete fires with WorkResponse on container exit', async () => {
    const request = makeRequest({ requestId: 'req-exit', actionId: 'act-exit' });
    const handle = await familiar.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    const mc = mockState.containers[0];
    mc.waitResolve({ StatusCode: 0 });

    const response = await responsePromise;
    expect(response.requestId).toBe('req-exit');
    expect(response.actionId).toBe('act-exit');
    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);
  });

  it('onComplete reports failed status on non-zero exit', async () => {
    const request = makeRequest({ requestId: 'req-fail', actionId: 'act-fail' });
    const handle = await familiar.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    const mc = mockState.containers[0];
    mc.waitResolve({ StatusCode: 1 });

    const response = await responsePromise;
    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).toBe(1);
  });

  it('includes claudeSessionId in completion response', async () => {
    const request = makeRequest({
      actionType: 'claude',
      inputs: { prompt: 'test', repoUrl: 'https://github.com/test/repo.git' },
    });
    const handle = await familiar.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    const mc = mockState.containers[0];
    mc.waitResolve({ StatusCode: 0 });

    const response = await responsePromise;
    expect(response.outputs.claudeSessionId).toBe(handle.claudeSessionId);
  });

  // -------------------------------------------------------------------------
  // Container lifecycle
  // -------------------------------------------------------------------------

  it('onOutput streams container logs', async () => {
    const request = makeRequest();
    const handle = await familiar.start(request);

    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    const mc = mockState.containers[0];
    mc.logStream.emit('data', Buffer.from('line 1\n'));
    mc.logStream.emit('data', Buffer.from('line 2\n'));

    const containerOutput = output.filter((line) => !line.includes('[DockerFamiliar]') && !line.includes('[docker]'));
    expect(containerOutput).toEqual(['line 1\n', 'line 2\n']);
  });

  it('kill stops and removes container', async () => {
    const request = makeRequest();
    const handle = await familiar.start(request);

    const mc = mockState.containers[0];
    await familiar.kill(handle);

    expect(mc.container.stop).toHaveBeenCalledWith({ t: 5 });
    expect(mc.container.remove).toHaveBeenCalled();
  });

  it('destroyAll kills all active containers', async () => {
    await familiar.start(makeRequest({ requestId: 'req-a', actionId: 'act-a' }));
    await familiar.start(makeRequest({ requestId: 'req-b', actionId: 'act-b' }));

    expect(mockState.containers).toHaveLength(2);

    await familiar.destroyAll();

    for (const mc of mockState.containers) {
      expect(mc.container.stop).toHaveBeenCalled();
      expect(mc.container.remove).toHaveBeenCalled();
    }
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
      // DockerPool clone containers need auto-resolving wait
      let callCount = 0;
      const origCreate = mockState.createContainer!;
      mockState.createContainer = vi.fn().mockImplementation((...args: any[]) => {
        callCount++;
        if (callCount === 1) {
          // Clone container: auto-resolve wait immediately
          const mc = createMockContainer(`container-clone`);
          mockState.containers.push(mc);
          mc.container.wait = vi.fn().mockResolvedValue({ StatusCode: 0 });
          mc.container.commit = vi.fn().mockResolvedValue(undefined);
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

      expect(mockState.createContainer).toHaveBeenCalledTimes(2);

      const cloneArgs = mockState.createContainer!.mock.calls[0][0];
      expect(cloneArgs.Entrypoint).toEqual(['git']);
      expect(cloneArgs.Cmd).toEqual(['clone', 'https://github.com/test/repo.git', '/app']);

      const taskArgs = mockState.createContainer!.mock.calls[1][0];
      expect(taskArgs.Cmd[0]).toBe('/bin/bash');
    });
  });

  describe('repoInImage: true (skip DockerPool)', () => {
    it('uses image directly without calling DockerPool', async () => {
      await familiar.start(makeRequest());

      // Only 1 container: the task container (no clone)
      expect(mockState.createContainer).toHaveBeenCalledTimes(1);

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      expect(createArgs.Image).toBe('invoker-agent:latest');
    });
  });

  // -------------------------------------------------------------------------
  // buildWrappedCommand
  // -------------------------------------------------------------------------

  describe('buildWrappedCommand', () => {
    it('generates correct script for command tasks', () => {
      const request = makeRequest({ inputs: { command: 'pnpm test', baseBranch: 'master' } });
      const cmd = familiar.buildWrappedCommand(
        ['/bin/sh', '-c', 'pnpm test'],
        'invoker/test-task',
        request,
      );

      expect(cmd[0]).toBe('/bin/bash');
      expect(cmd[1]).toBe('-c');
      const script = cmd[2];
      expect(script).toContain('git config user.email');
      expect(script).toContain('git fetch origin');
      expect(script).toContain("git checkout -B 'invoker/test-task' 'origin/master'");
      expect(script).toContain('git add -A');
      expect(script).toContain('git commit --allow-empty');
      expect(script).toContain("git push -u origin 'invoker/test-task'");
      expect(script).toContain('exit $TASK_EXIT');
    });

    it('generates correct script for claude tasks (no git add/commit)', () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'fix it', baseBranch: 'main' },
      });
      const cmd = familiar.buildWrappedCommand(
        ['claude', '--session-id', 'abc', '-p', 'fix it'],
        'invoker/fix-task',
        request,
      );

      const script = cmd[2];
      expect(script).toContain('claude');
      expect(script).toContain('git push');
      expect(script).not.toContain('git add -A');
      expect(script).not.toContain('git commit');
    });

    it('merges upstream branches for fan-in', () => {
      const request = makeRequest({
        inputs: {
          command: 'echo test',
          upstreamBranches: ['invoker/dep-a', 'invoker/dep-b', 'invoker/dep-c'],
        },
      });
      const cmd = familiar.buildWrappedCommand(
        ['/bin/sh', '-c', 'echo test'],
        'invoker/fanin-task',
        request,
      );

      const script = cmd[2];
      // First upstream is the base for checkout
      expect(script).toContain("git checkout -B 'invoker/fanin-task' 'invoker/dep-a'");
      // Additional upstreams are merged
      expect(script).toContain("git merge --no-edit 'invoker/dep-b'");
      expect(script).toContain("git merge --no-edit 'invoker/dep-c'");
    });

    it('falls back to origin/HEAD when no base branch', () => {
      const request = makeRequest({ inputs: { command: 'echo test' } });
      const cmd = familiar.buildWrappedCommand(
        ['/bin/sh', '-c', 'echo test'],
        'invoker/no-base',
        request,
      );

      const script = cmd[2];
      expect(script).toContain("git checkout -B 'invoker/no-base' 'origin/HEAD'");
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
