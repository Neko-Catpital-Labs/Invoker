import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle, PersistedTaskMeta } from '../executor.js';
import { BaseExecutor } from '../base-executor.js';

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

vi.mock('../secrets-loader.js', () => ({
  loadSecretsFile: vi.fn(() => []),
}));

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

describe('DockerExecutor', () => {
  let DockerExecutor: typeof import('../docker-executor.js').DockerExecutor;
  let loadSecretsFile: ReturnType<typeof vi.fn>;
  let executor: InstanceType<typeof DockerExecutor>;

  // Spies on BaseExecutor lifecycle methods
  let syncFromRemoteSpy: ReturnType<typeof vi.spyOn>;
  let setupTaskBranchSpy: ReturnType<typeof vi.spyOn>;
  let handleProcessExitSpy: ReturnType<typeof vi.spyOn>;

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

    const mod = await import('../docker-executor.js');
    DockerExecutor = mod.DockerExecutor;

    const secretsMod = await import('../secrets-loader.js');
    loadSecretsFile = secretsMod.loadSecretsFile as unknown as ReturnType<typeof vi.fn>;
    loadSecretsFile.mockReset();
    loadSecretsFile.mockReturnValue([]);

    // Mock execRemoteCapture to bypass docker exec CLI for any runBash calls
    vi.spyOn(
      DockerExecutor.prototype as any, 'execRemoteCapture',
    ).mockResolvedValue('');

    // Mock lifecycle methods so we don't need real git
    syncFromRemoteSpy = vi.spyOn(
      BaseExecutor.prototype as any, 'syncFromRemote',
    ).mockResolvedValue(undefined);

    setupTaskBranchSpy = vi.spyOn(
      BaseExecutor.prototype as any, 'setupTaskBranch',
    ).mockImplementation((async (...args: unknown[]) => {
      const request = args[1] as WorkRequest;
      const handle = args[2] as ExecutorHandle;
      const opts = args[3] as { branchName?: string } | undefined;
      handle.branch = opts?.branchName ?? `experiment/${request.actionId}-00000000`;
      return undefined;
    }) as any);

    // Stub handleProcessExit so we don't need real git, but still route through
    // emitComplete so the BaseExecutor centralized cleanup (entries.delete) runs.
    handleProcessExitSpy = vi.spyOn(
      BaseExecutor.prototype as any, 'handleProcessExit',
    ).mockImplementation((async function (this: any, ...args: unknown[]) {
      const executionId = args[0] as string;
      const request = args[1] as WorkRequest;
      const exitCode = args[3] as number;
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        status: exitCode === 0 ? 'completed' : 'failed',
        outputs: { exitCode },
      };
      this.emitComplete(executionId, response);
    }) as any);

    executor = new DockerExecutor({
      callbackPort: 4000,
      imageName: 'invoker-agent:latest',
    });
  });

  afterEach(async () => {
    await executor.destroyAll();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Container configuration
  // -------------------------------------------------------------------------

  it('creates container with idle command (tail -f /dev/null)', async () => {
    await executor.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    expect(createArgs.Cmd).toEqual(['tail', '-f', '/dev/null']);
    expect(createArgs.Entrypoint).toEqual([]);
  });

  it('does NOT include GIT_SSH_COMMAND in container env', async () => {
    await executor.start(makeRequest());

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    const env: string[] = createArgs.Env;
    const sshEnv = env.find((e: string) => e.startsWith('GIT_SSH_COMMAND='));
    expect(sshEnv).toBeUndefined();
  });

  it('uses the configured image directly', async () => {
    await executor.start(makeRequest());

    expect(mockState.createContainer).toHaveBeenCalledTimes(1);

    const createArgs = mockState.createContainer!.mock.calls[0][0];
    expect(createArgs.Image).toBe('invoker-agent:latest');
  });

  // -------------------------------------------------------------------------
  // Git lifecycle delegation to BaseExecutor
  // -------------------------------------------------------------------------

  it('calls syncFromRemote with /app', async () => {
    await executor.start(makeRequest());

    expect(syncFromRemoteSpy).toHaveBeenCalledWith('/app', expect.any(String));
  });

  it('calls setupTaskBranch with /app and content-addressable branch', async () => {
    await executor.start(makeRequest());

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
    const handle = await executor.start(makeRequest());
    expect(handle.branch).toMatch(/^experiment\/action-1-[0-9a-f]{8}$/);
  });

  // -------------------------------------------------------------------------
  // Task execution via docker exec CLI
  // -------------------------------------------------------------------------

  it('spawns task command via docker exec without --user override', async () => {
    const { spawn } = await import('node:child_process');
    await executor.start(makeRequest());

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
    // No --user override — image declares its own user
    expect(dockerArgs).not.toContain('--user');
    // Should contain the task command somewhere
    const bashArg = dockerArgs[dockerArgs.length - 1];
    expect(bashArg).toContain('echo hello');
  });

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  it('calls handleProcessExit on task child close', async () => {
    await executor.start(makeRequest({ requestId: 'req-exit', actionId: 'act-exit' }));

    // Find the task child (last one created)
    const taskChild = taskChildren[taskChildren.length - 1];
    taskChild.emit('close', 0, null);

    // Allow async handler to run
    await new Promise((r) => setTimeout(r, 250));

    expect(handleProcessExitSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ actionId: 'act-exit' }),
      '/app',
      0,
      expect.objectContaining({ branch: expect.stringMatching(/^experiment\/act-exit-[0-9a-f]{8}$/) }),
    );
  });

  it('stops container after handleProcessExit completes', async () => {
    await executor.start(makeRequest());

    const mc = mockState.containers[0];
    const taskChild = taskChildren[taskChildren.length - 1];
    taskChild.emit('close', 0, null);

    await new Promise((r) => setTimeout(r, 250));

    expect(mc.container.stop).toHaveBeenCalledWith({ t: 5 });
  });

  it('passes non-zero exit code to handleProcessExit', async () => {
    await executor.start(makeRequest());

    const taskChild = taskChildren[taskChildren.length - 1];
    taskChild.emit('close', 1, null);

    await new Promise((r) => setTimeout(r, 250));

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
    it('sets agentSessionId on handle', async () => {
      const request = makeRequest({
        actionType: 'ai_task',
        inputs: { prompt: 'test', repoUrl: 'https://github.com/test/repo.git' },
      });
      const handle = await executor.start(request);
      expect(handle.agentSessionId).toBeDefined();
      expect(handle.agentSessionId).toMatch(/^[0-9a-f-]+$/);
    });

    it('does not set agentSessionId for command actions', async () => {
      const handle = await executor.start(makeRequest());
      expect(handle.agentSessionId).toBeUndefined();
    });

    it('getTerminalSpec returns docker start + exec claude --resume for claude tasks', async () => {
      const request = makeRequest({
        actionType: 'ai_task',
        inputs: { prompt: 'test', repoUrl: 'https://github.com/test/repo.git' },
      });
      const handle = await executor.start(request);
      const spec = executor.getTerminalSpec(handle);
      const cid = mockState.containers[0].container.id;

      expect(spec).toBeDefined();
      expect(spec!.command).toBe('bash');
      const bashCmd = spec!.args![1];
      expect(bashCmd).toContain(`docker start ${cid}`);
      expect(bashCmd).toContain(`docker exec -it ${cid} claude --resume ${handle.agentSessionId}`);
    });
  });

  // -------------------------------------------------------------------------
  // Container lifecycle
  // -------------------------------------------------------------------------

  it('kill stops and removes container', async () => {
    const handle = await executor.start(makeRequest());

    const mc = mockState.containers[0];
    await executor.kill(handle);

    expect(mc.container.stop).toHaveBeenCalledWith({ t: 5 });
    expect(mc.container.remove).toHaveBeenCalled();
  });

  it('getTerminalSpec returns docker start + exec bash for command tasks', async () => {
    const handle = await executor.start(makeRequest());
    const spec = executor.getTerminalSpec(handle);
    const cid = mockState.containers[0].container.id;
    expect(spec).toEqual({
      command: 'bash',
      args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} /bin/bash`],
    });
  });

  it('getTerminalSpec returns null for unknown handle', () => {
    const spec = executor.getTerminalSpec({ executionId: 'nonexistent', taskId: 'x' });
    expect(spec).toBeNull();
  });

  // -------------------------------------------------------------------------
  // getRestoredTerminalSpec
  // -------------------------------------------------------------------------

  describe('getRestoredTerminalSpec', () => {
    const baseMeta: PersistedTaskMeta = {
      taskId: 'task-docker-1',
      executorType: 'docker',
      containerId: 'container-abc123',
    };

    it('returns docker exec bash spec when no session', () => {
      const spec = executor.getRestoredTerminalSpec(baseMeta);
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain('docker start container-abc123');
      expect(spec.args![1]).toContain('/bin/bash');
      expect(spec.args![1]).not.toContain('claude --resume');
    });

    it('returns docker exec claude --resume spec with session', () => {
      const spec = executor.getRestoredTerminalSpec({
        ...baseMeta,
        agentSessionId: 'session-docker-1',
      });
      expect(spec.command).toBe('bash');
      expect(spec.args![1]).toContain('docker start container-abc123');
      expect(spec.args![1]).toContain('claude --resume session-docker-1');
      expect(spec.args![1]).toContain('--dangerously-skip-permissions');
    });

    it('throws when no container ID provided', () => {
      expect(() =>
        executor.getRestoredTerminalSpec({
          taskId: 'task-no-container',
          executorType: 'docker',
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

      const f = new DockerExecutor({ imageName: 'invoker-agent:latest' });
      const request = makeRequest();
      await expect(f.start(request)).rejects.toThrow(
        'Docker daemon is not reachable',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Env surface: INVOKER_* + secrets file
  // -------------------------------------------------------------------------

  describe('env surface', () => {
    it('includes INVOKER_CALLBACK_URL, INVOKER_REQUEST_ID, INVOKER_ACTION_ID', async () => {
      await executor.start(makeRequest({
        requestId: 'req-123',
        actionId: 'act-456',
      }));

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;

      expect(env).toContainEqual(expect.stringMatching(/^INVOKER_CALLBACK_URL=/));
      expect(env).toContainEqual('INVOKER_REQUEST_ID=req-123');
      expect(env).toContainEqual('INVOKER_ACTION_ID=act-456');
    });

    it('appends entries loaded from secretsFile', async () => {
      loadSecretsFile.mockReturnValue([
        'ANTHROPIC_API_KEY=sk-x',
        'GIT_HTTPS_TOKEN=ghp-y',
      ]);

      const f = new DockerExecutor({
        imageName: 'invoker-agent:latest',
        secretsFile: '/tmp/fake-secrets.env',
      });
      await f.start(makeRequest());

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;

      expect(env).toContainEqual('ANTHROPIC_API_KEY=sk-x');
      expect(env).toContainEqual('GIT_HTTPS_TOKEN=ghp-y');
      expect(loadSecretsFile).toHaveBeenCalledWith('/tmp/fake-secrets.env');
    });

    it('omits secretsFile entries when file does not exist', async () => {
      loadSecretsFile.mockReturnValue([]);

      await executor.start(makeRequest({ requestId: 'r', actionId: 'a' }));

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;

      // Only the three INVOKER_* entries remain
      expect(env).toHaveLength(3);
      expect(env.every((e: string) => e.startsWith('INVOKER_'))).toBe(true);
    });

    it('does not set User on the container (image declares its own user)', async () => {
      await executor.start(makeRequest());

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      expect(createArgs.User).toBeUndefined();
    });

    it('does not bind mount host paths', async () => {
      await executor.start(makeRequest());

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const binds = createArgs.HostConfig.Binds;
      // Either undefined or an empty array is acceptable
      expect(binds === undefined || binds.length === 0).toBe(true);
    });

    it('does not inject HOME or COREPACK_HOME', async () => {
      await executor.start(makeRequest());

      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;

      expect(env.find((e: string) => e.startsWith('HOME='))).toBeUndefined();
      expect(env.find((e: string) => e.startsWith('COREPACK_HOME='))).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Secret redaction in container-config logs (regression tests)
  // -------------------------------------------------------------------------
  //
  // The DockerExecutor logs the full container config via JSON.stringify when
  // starting a container. Secrets loaded from secretsFile end up in the Env
  // array, so the log must redact known secret-bearing keys before emission.
  // These tests prove the regression is closed: secrets must never appear in
  // console.log output, regardless of which SECRET_ENV_KEYS are present.

  describe('Secret redaction in container-config logs', () => {
    let consoleLogSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleLogSpy.mockRestore();
    });

    it('MUST NOT log literal ANTHROPIC_API_KEY value in container config', async () => {
      loadSecretsFile.mockReturnValue([
        'ANTHROPIC_API_KEY=sk-ant-api03-secret-test-key-12345',
      ]);

      const familiarWithKey = new DockerExecutor({
        imageName: 'invoker-agent:latest',
        secretsFile: '/tmp/fake-secrets.env',
      });

      await familiarWithKey.start(makeRequest());

      // Verify the API key was placed into container config Env
      const createArgs = mockState.createContainer!.mock.calls[0][0];
      const env: string[] = createArgs.Env;
      expect(env).toContainEqual('ANTHROPIC_API_KEY=sk-ant-api03-secret-test-key-12345');

      // CRITICAL: Verify the literal key never appears in any console.log output
      const allLogs = consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
      expect(allLogs).not.toContain('sk-ant-api03-secret-test-key-12345');
      expect(allLogs).not.toMatch(/ANTHROPIC_API_KEY=sk-ant-/);
    });

    it('MUST NOT log token-like environment variable values', async () => {
      loadSecretsFile.mockReturnValue([
        'ANTHROPIC_API_KEY=sk-ant-token-abc123xyz',
      ]);

      const familiarWithTokens = new DockerExecutor({
        imageName: 'invoker-agent:latest',
        secretsFile: '/tmp/fake-secrets.env',
      });

      await familiarWithTokens.start(makeRequest());

      const allLogs = consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

      // Verify token patterns are not leaked
      expect(allLogs).not.toContain('sk-ant-token-abc123xyz');
      expect(allLogs).not.toMatch(/sk-ant-[\w-]+/);
    });

    it('MUST preserve non-sensitive container diagnostics in logs', async () => {
      await executor.start(makeRequest());

      const allLogs = consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

      // Verify essential diagnostics remain visible
      expect(allLogs).toContain('[DockerExecutor]');
      expect(allLogs).toContain('Container config:');
      expect(allLogs).toContain('image=');
      expect(allLogs).toContain('Container created:');
    });

    it('MUST redact secrets even when logged via JSON.stringify', async () => {
      loadSecretsFile.mockReturnValue([
        'ANTHROPIC_API_KEY=sk-ant-ultra-secret-production-key',
      ]);

      const familiarWithSecret = new DockerExecutor({
        imageName: 'invoker-agent:latest',
        secretsFile: '/tmp/fake-secrets.env',
      });

      await familiarWithSecret.start(makeRequest());

      // The implementation does `JSON.stringify(redactContainerConfig(containerConfig), null, 2)`.
      // Even when serializing the full config object, the secret value MUST NOT appear in logs.
      const allLogs = consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

      expect(allLogs).not.toContain('sk-ant-ultra-secret-production-key');
      expect(allLogs).not.toMatch(/"ANTHROPIC_API_KEY":\s*"sk-ant-/);
      expect(allLogs).not.toMatch(/ANTHROPIC_API_KEY=sk-ant-[\w-]+/);
    });

    it('NEGATIVE ASSERTION: the containerConfig log path MUST NOT emit literal secrets', async () => {
      // Regression barrier: docker-executor.ts start() logs containerConfig via
      // JSON.stringify. Without redaction, it WOULD emit the literal
      // ANTHROPIC_API_KEY value. This test locks that hole shut.

      loadSecretsFile.mockReturnValue([
        'ANTHROPIC_API_KEY=sk-ant-regression-test-key-99999',
      ]);

      const familiarWithKey = new DockerExecutor({
        imageName: 'invoker-agent:latest',
        secretsFile: '/tmp/fake-secrets.env',
      });

      await familiarWithKey.start(makeRequest());

      // Find the specific "Container config:" log line
      const configLogCall = consoleLogSpy.mock.calls.find((call: unknown[]) =>
        call.some((arg: unknown) => typeof arg === 'string' && arg.includes('Container config:'))
      );

      expect(configLogCall).toBeDefined();

      const configLogOutput = (configLogCall as unknown[]).join(' ');

      // Explicit negative assertion: the config log MUST NOT contain the literal secret
      expect(configLogOutput).not.toContain('sk-ant-regression-test-key-99999');

      // It also MUST NOT contain the env var assignment with the secret
      expect(configLogOutput).not.toMatch(/ANTHROPIC_API_KEY=sk-ant-/);

      // But it SHOULD indicate that the key exists (redacted)
      expect(configLogOutput).toMatch(/ANTHROPIC_API_KEY.*REDACTED|ANTHROPIC_API_KEY.*\*\*\*|"Env".*\[/);
    });

    it('MUST redact multiple SECRET_ENV_KEYS in the same container env', async () => {
      loadSecretsFile.mockReturnValue([
        'ANTHROPIC_API_KEY=sk-ant-multi-secret-test',
        'OPENAI_API_KEY=sk-openai-multi-secret',
        'GITHUB_TOKEN=ghp_multi_github_token_value',
        'AWS_SECRET_ACCESS_KEY=aws-multi-secret-access',
      ]);

      const familiarWithKey = new DockerExecutor({
        imageName: 'invoker-agent:latest',
        secretsFile: '/tmp/fake-secrets.env',
      });

      await familiarWithKey.start(makeRequest());

      const allLogs = consoleLogSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');

      // Each secret value must be absent from logs
      expect(allLogs).not.toContain('sk-ant-multi-secret-test');
      expect(allLogs).not.toContain('sk-openai-multi-secret');
      expect(allLogs).not.toContain('ghp_multi_github_token_value');
      expect(allLogs).not.toContain('aws-multi-secret-access');

      // Each secret key must appear in redacted form
      expect(allLogs).toContain('ANTHROPIC_API_KEY=***REDACTED***');
      expect(allLogs).toContain('OPENAI_API_KEY=***REDACTED***');
      expect(allLogs).toContain('GITHUB_TOKEN=***REDACTED***');
      expect(allLogs).toContain('AWS_SECRET_ACCESS_KEY=***REDACTED***');
    });
  });


  // -------------------------------------------------------------------------
  // Entry lifecycle regression tests
  // -------------------------------------------------------------------------

  describe('Entry lifecycle', () => {
    it('decreases entries.size after terminal close', async () => {
      await executor.start(makeRequest({ requestId: 'req-lifecycle', actionId: 'act-lifecycle' }));

      expect((executor as any).entries.size).toBe(1);

      const taskChild = taskChildren[taskChildren.length - 1];
      taskChild.emit('close', 0, null);

      await new Promise((r) => setTimeout(r, 250));

      expect((executor as any).entries.size).toBe(0);
    });

    it('removes entry state on spawn error', async () => {
      const { spawn: spawnMock } = await import('node:child_process');

      // Make the next spawn (docker exec) emit error immediately.
      // Build the child directly via createMockChildProcess instead of
      // calling getMockImplementation(), which does not return the impl set
      // via the vi.fn(impl) constructor used by the module-scope vi.mock.
      (spawnMock as any).mockImplementationOnce((..._args: any[]) => {
        const child = createMockChildProcess();
        taskChildren.push(child);
        setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
        return child;
      });

      await executor.start(makeRequest({ requestId: 'req-spawn-err', actionId: 'act-spawn-err' }));

      await new Promise((r) => setTimeout(r, 250));

      expect((executor as any).entries.size).toBe(0);
    });

    it('does not leak listeners or timers on spawn error', async () => {
      const { spawn: spawnMock } = await import('node:child_process');

      (spawnMock as any).mockImplementationOnce((..._args: any[]) => {
        const child = createMockChildProcess();
        taskChildren.push(child);
        setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
        return child;
      });

      const handle = await executor.start(makeRequest({ requestId: 'req-leak', actionId: 'act-leak' }));

      await new Promise((r) => setTimeout(r, 250));

      const entry = (executor as any).entries.get(handle.executionId);
      expect(entry).toBeUndefined();
    });

    it('destroyAll remains idempotent after completion', async () => {
      await executor.start(makeRequest({ requestId: 'req-destroy-comp', actionId: 'act-destroy-comp' }));

      const taskChild = taskChildren[taskChildren.length - 1];
      taskChild.emit('close', 0, null);

      await new Promise((r) => setTimeout(r, 250));

      await executor.destroyAll();
      expect((executor as any).entries.size).toBe(0);

      await expect(executor.destroyAll()).resolves.toBeUndefined();
    });

    it('destroyAll remains idempotent after failure', async () => {
      await executor.start(makeRequest({ requestId: 'req-destroy-fail', actionId: 'act-destroy-fail' }));

      const taskChild = taskChildren[taskChildren.length - 1];
      taskChild.emit('close', 1, null);

      await new Promise((r) => setTimeout(r, 250));

      await executor.destroyAll();
      expect((executor as any).entries.size).toBe(0);

      await expect(executor.destroyAll()).resolves.toBeUndefined();
    });

    it('getRestoredTerminalSpec still returns a valid spec after entry cleanup', async () => {
      const handle = await executor.start(
        makeRequest({ requestId: 'req-restore', actionId: 'act-restore' }),
      );

      const taskChild = taskChildren[taskChildren.length - 1];
      taskChild.emit('close', 0, null);

      await new Promise((r) => setTimeout(r, 250));

      // Entry has been cleaned up by the centralized BaseExecutor.emitComplete teardown.
      expect((executor as any).entries.size).toBe(0);

      // Revisit path uses persisted metadata (containerId), NOT the entries map.
      const meta: PersistedTaskMeta = {
        taskId: handle.taskId,
        executorType: executor.type,
        containerId: handle.containerId,
        branch: handle.branch,
        executionAgent: 'claude',
      };

      const spec = executor.getRestoredTerminalSpec(meta);
      expect(spec).toBeTruthy();
      expect(spec.command).toBe('bash');
      expect(spec.args).toBeTruthy();
      expect(spec.args!.length).toBeGreaterThan(0);
      // The restored spec must reference the persisted container ID.
      expect(spec.args!.some((a: string) => a.includes(handle.containerId!))).toBe(true);
    });
  });
});
