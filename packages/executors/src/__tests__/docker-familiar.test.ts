import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
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
    inputs: { command: 'echo hello' },
    callbackUrl: 'http://localhost:4000/api/worker/response',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

/** Minimal stream-like emitter returned by container.logs(). */
function createMockLogStream(): EventEmitter {
  return new EventEmitter();
}

/** Creates a mock container object. */
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

/** Shared state for the mock Docker instance. */
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

// Mock writeFileSync so we don't write to disk, but still track calls
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
  // Dynamic import so mocks are in place first
  let DockerFamiliar: typeof import('../docker-familiar.js').DockerFamiliar;
  let familiar: InstanceType<typeof DockerFamiliar>;

  beforeEach(async () => {
    mockState.containers = [];

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

    familiar = new DockerFamiliar({
      workspaceDir: '/tmp',
      callbackPort: 4000,
      claudeConfigDir: '/tmp',
      sshDir: '/tmp',
    });
  });

  afterEach(async () => {
    // Resolve any pending waits so destroyAll doesn't hang
    for (const mc of mockState.containers) {
      mc.waitResolve({ StatusCode: 0 });
    }
    await familiar.destroyAll();
  });

  // -------------------------------------------------------------------------

  it('start creates container with correct volume mounts for command tasks', async () => {
    const request = makeRequest();
    await familiar.start(request);

    expect(mockState.createContainer).toHaveBeenCalledTimes(1);

    const createArgs = mockState.createContainer!.mock.calls[0][0];

    // Image name
    expect(createArgs.Image).toBe('invoker-agent:latest');

    // Volume binds
    const binds: string[] = createArgs.HostConfig.Binds;
    expect(binds).toContainEqual(expect.stringContaining('/tmp:/app'));
    // Claude config mounted read-write (no :ro suffix on .claude)
    const claudeBind = binds.find((b: string) => b.includes('.claude'));
    expect(claudeBind).toBeDefined();
    expect(claudeBind).not.toContain(':ro');
    // SSH still read-only
    expect(binds).toContainEqual(expect.stringContaining(':/home/invoker/.ssh:ro'));

    // Network mode
    expect(createArgs.HostConfig.NetworkMode).toBe('host');

    // Cmd should be set for command tasks
    expect(createArgs.Cmd).toEqual(['/bin/sh', '-c', 'echo hello']);
  });

  it('onOutput streams container logs', async () => {
    const request = makeRequest();
    const handle = await familiar.start(request);

    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    // Simulate log output from the container
    const mc = mockState.containers[0];
    mc.logStream.emit('data', Buffer.from('line 1\n'));
    mc.logStream.emit('data', Buffer.from('line 2\n'));

    // Filter out system log lines to check container output
    const containerOutput = output.filter((line) => !line.includes('[DockerFamiliar]') && !line.includes('[docker]'));
    expect(containerOutput).toEqual(['line 1\n', 'line 2\n']);

    // System logs should also be present in the output stream
    const systemLogs = output.filter((line) => line.includes('[DockerFamiliar]') || line.includes('[docker]'));
    expect(systemLogs.length).toBeGreaterThan(0);
  });

  it('onComplete fires with WorkResponse on container exit', async () => {
    const request = makeRequest({ requestId: 'req-exit', actionId: 'act-exit' });
    const handle = await familiar.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    // Simulate container exit with code 0
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

  it('kill stops and removes container', async () => {
    const request = makeRequest();
    const handle = await familiar.start(request);

    const mc = mockState.containers[0];

    // Container is still running (wait not resolved), so kill should stop it
    await familiar.kill(handle);

    expect(mc.container.stop).toHaveBeenCalledWith({ t: 5 });
    expect(mc.container.remove).toHaveBeenCalled();
  });

  it('destroyAll kills all active containers', async () => {
    await familiar.start(
      makeRequest({ requestId: 'req-a', actionId: 'act-a' }),
    );
    await familiar.start(
      makeRequest({ requestId: 'req-b', actionId: 'act-b' }),
    );

    expect(mockState.containers).toHaveLength(2);

    // Containers are still running (waits not resolved), so destroyAll stops them
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

  // ── Claude CLI tests ──────────────────────────────────────────

  describe('claude action type', () => {
    it('creates container with claude CLI command', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'analyze this code' },
      });
      await familiar.start(request);

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const cmd: string[] = createArgs.Cmd;

      expect(cmd[0]).toBe('claude');
      expect(cmd).toContain('--session-id');
      expect(cmd).toContain('--dangerously-skip-permissions');
      expect(cmd).toContain('-p');
      expect(cmd).toContain('analyze this code');
    });

    it('sets claudeSessionId on handle for claude actions', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await familiar.start(request);

      expect(handle.claudeSessionId).toBeDefined();
      expect(handle.claudeSessionId).toMatch(/^[0-9a-f-]+$/);
    });

    it('does not set claudeSessionId for command actions', async () => {
      const request = makeRequest();
      const handle = await familiar.start(request);

      expect(handle.claudeSessionId).toBeUndefined();
    });

    it('passes ANTHROPIC_API_KEY to container environment', async () => {
      const familiarWithKey = new DockerFamiliar({
        workspaceDir: '/tmp',
        claudeConfigDir: '/tmp',
        sshDir: '/tmp',
        anthropicApiKey: 'sk-test-key-123',
      });

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      await familiarWithKey.start(request);

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;
      expect(env).toContainEqual('ANTHROPIC_API_KEY=sk-test-key-123');
    });

    it('includes claudeSessionId in completion response', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
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

    it('does not auto-remove container after exit', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await familiar.start(request);

      const responsePromise = new Promise<WorkResponse>((resolve) => {
        familiar.onComplete(handle, (res) => resolve(res));
      });

      const mc = mockState.containers[0];
      mc.waitResolve({ StatusCode: 0 });

      await responsePromise;

      // Container should NOT be auto-removed after exit
      expect(mc.container.remove).not.toHaveBeenCalled();
    });

    it('getTerminalSpec returns docker start + exec claude --resume for claude tasks', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
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

    it('prepends upstream context to prompt', async () => {
      const request = makeRequest({
        actionType: 'claude',
        inputs: {
          prompt: 'do the thing',
          upstreamContext: [
            { taskId: 'dep-1', description: 'setup task', summary: 'done', commitHash: 'abc123' },
          ],
        },
      });
      await familiar.start(request);

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const cmd: string[] = createArgs.Cmd;
      const promptIdx = cmd.indexOf('-p');
      const prompt = cmd[promptIdx + 1];

      expect(prompt).toContain('Upstream task: dep-1');
      expect(prompt).toContain('Commit: abc123');
      expect(prompt).toContain('do the thing');
    });
  });

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
      // Temporarily make ping reject
      mockState.ping!.mockRejectedValueOnce(
        new Error('connect ENOENT /var/run/docker.sock'),
      );

      const familiar = new DockerFamiliar({ workspaceDir: '/tmp' });
      const request = {
        requestId: 'req-1',
        actionId: 'ping-test',
        actionType: 'command' as const,
        inputs: { command: 'echo hi', description: 'test' },
        callbackUrl: '',
        timestamps: { createdAt: new Date().toISOString() },
      };
      await expect(familiar.start(request)).rejects.toThrow(
        'Docker daemon is not reachable',
      );
    });
  });
});
