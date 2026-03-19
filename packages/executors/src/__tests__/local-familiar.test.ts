import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { PersistedTaskMeta } from '../familiar.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
import { existsSync } from 'node:fs';
import { LocalFamiliar } from '../local-familiar.js';

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

function mockGitLifecycle(instance: LocalFamiliar): void {
  vi.spyOn(instance as any, 'execGitSimple').mockImplementation(async (...a: any[]) => {
    const args = a[0] as string[];
    if (args[0] === 'branch' && args[1] === '--show-current') return 'master';
    return '';
  });
  vi.spyOn(instance as any, 'syncFromRemote').mockResolvedValue(undefined);
  vi.spyOn(instance as any, 'setupTaskBranch').mockResolvedValue(undefined);
  vi.spyOn(instance as any, 'recordTaskResult').mockResolvedValue(null);
  vi.spyOn(instance as any, 'restoreBranch').mockResolvedValue(undefined);
  vi.spyOn(instance as any, 'pushBranchToRemote').mockResolvedValue(undefined);
}

describe('LocalFamiliar', () => {
  let familiar: LocalFamiliar;

  beforeEach(() => {
    familiar = new LocalFamiliar();
    mockGitLifecycle(familiar);
  });

  afterEach(async () => {
    await familiar.destroyAll();
  });

  it('start: spawns process and returns handle', async () => {
    const handle = await familiar.start(makeRequest());
    expect(handle).toBeDefined();
    expect(handle.executionId).toBeDefined();
    expect(typeof handle.executionId).toBe('string');
    expect(handle.taskId).toBe('action-1');
  });

  it('onOutput: captures stdout', async () => {
    const request = makeRequest({ inputs: { command: 'echo hello' } });
    const handle = await familiar.start(request);

    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    await new Promise<void>((resolve) => {
      familiar.onComplete(handle, () => resolve());
    });

    expect(output.join('')).toContain('hello');
  });

  it('onOutput: captures stderr', async () => {
    const request = makeRequest({ inputs: { command: 'echo error-msg >&2' } });
    const handle = await familiar.start(request);

    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    await new Promise<void>((resolve) => {
      familiar.onComplete(handle, () => resolve());
    });

    expect(output.join('')).toContain('error-msg');
  });

  it('onComplete: returns exit code 0 on success', async () => {
    const request = makeRequest({ inputs: { command: 'echo hello' } });
    const handle = await familiar.start(request);

    const response = await new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);
    expect(response.requestId).toBe('req-1');
    expect(response.actionId).toBe('action-1');
  });

  it('onComplete: returns correct exit code on failure', async () => {
    const request = makeRequest({ inputs: { command: 'exit 42' } });
    const handle = await familiar.start(request);

    const response = await new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).toBe(42);
  });

  it('sendInput: writes to process stdin', async () => {
    const request = makeRequest({ inputs: { command: 'cat' } });
    const handle = await familiar.start(request);

    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    // Send input then close stdin so cat exits
    familiar.sendInput(handle, 'hello from stdin\n');

    // Give a small delay for data to flow, then close stdin
    await new Promise((r) => setTimeout(r, 100));
    familiar.sendInput(handle, '');

    // Close stdin to let cat finish
    const entry = (familiar as any).entries.get(handle.executionId);
    entry?.process.stdin?.end();

    await new Promise<void>((resolve) => {
      familiar.onComplete(handle, () => resolve());
    });

    expect(output.join('')).toContain('hello from stdin');
  });

  it('kill: terminates running process', async () => {
    const request = makeRequest({ inputs: { command: 'sleep 60' } });
    const handle = await familiar.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      familiar.onComplete(handle, (res) => resolve(res));
    });

    await familiar.kill(handle);
    const response = await responsePromise;

    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).not.toBe(0);
  });

  it('destroyAll: kills all running processes', async () => {
    const handle1 = await familiar.start(
      makeRequest({
        requestId: 'req-1',
        actionId: 'action-1',
        inputs: { command: 'sleep 60' },
      }),
    );
    const handle2 = await familiar.start(
      makeRequest({
        requestId: 'req-2',
        actionId: 'action-2',
        inputs: { command: 'sleep 60' },
      }),
    );

    const responses: WorkResponse[] = [];

    const p1 = new Promise<void>((resolve) => {
      familiar.onComplete(handle1, (res) => {
        responses.push(res);
        resolve();
      });
    });
    const p2 = new Promise<void>((resolve) => {
      familiar.onComplete(handle2, (res) => {
        responses.push(res);
        resolve();
      });
    });

    await familiar.destroyAll();
    await Promise.all([p1, p2]);

    expect(responses).toHaveLength(2);
    for (const res of responses) {
      expect(res.status).toBe('failed');
    }
  });

  // ── Reconciliation tests ──────────────────────────────────────

  describe('reconciliation action type', () => {
    it('returns needs_input status', async () => {
      const request = makeRequest({
        actionType: 'reconciliation',
        inputs: { experimentResults: [] },
      });
      const handle = await familiar.start(request);

      const response = await new Promise<WorkResponse>((resolve) => {
        familiar.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('needs_input');
      expect(response.outputs.summary).toBe('Select winning experiment');
      expect(response.requestId).toBe('req-1');
      expect(response.actionId).toBe('action-1');
    });

    it('does not spawn a child process', async () => {
      const request = makeRequest({
        actionType: 'reconciliation',
        inputs: { experimentResults: [] },
      });
      const handle = await familiar.start(request);

      // Access internal state to verify no process was spawned
      const entry = (familiar as any).entries.get(handle.executionId);
      expect(entry).toBeDefined();
      expect(entry.process).toBeNull();
    });

    it('onComplete fires after onComplete listener is registered', async () => {
      const request = makeRequest({
        actionType: 'reconciliation',
        inputs: { experimentResults: [] },
      });
      const handle = await familiar.start(request);

      // The setTimeout(0) in the implementation means the callback fires
      // after the current microtask, giving us time to register.
      const response = await new Promise<WorkResponse>((resolve) => {
        familiar.onComplete(handle, (res) => resolve(res));
      });

      // If the listener fired before registration, this promise would never resolve.
      // Reaching here proves the deferred emit works correctly.
      expect(response.status).toBe('needs_input');
    });
  });

  // ── Claude CLI tests ──────────────────────────────────────────

  describe('claude action type', () => {
    it('invokes configured claude command with -p flag', async () => {
      // Use /bin/echo as the claude command so it echoes its arguments
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test prompt' },
      });
      const handle = await claudeFamiliar.start(request);

      const output: string[] = [];
      claudeFamiliar.onOutput(handle, (data) => output.push(data));

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('completed');
      expect(response.outputs.exitCode).toBe(0);
      // Verify -p flag and prompt are passed
      const combined = output.join('');
      expect(combined).toContain('-p');
      expect(combined).toContain('test prompt');
      expect(combined).toContain('--dangerously-skip-permissions');

      await claudeFamiliar.destroyAll();
    });

    it('falls back to echo when command not found and fallback enabled', async () => {
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '__nonexistent_claude_binary__',
        claudeFallback: true,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'hello world' },
      });
      const handle = await claudeFamiliar.start(request);

      const output: string[] = [];
      claudeFamiliar.onOutput(handle, (data) => output.push(data));

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('completed');
      expect(output.join('')).toContain('Claude prompt: hello world');

      await claudeFamiliar.destroyAll();
    });

    it('captures exit code and output', async () => {
      // Use /bin/echo to verify output capture and exit code
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'analyze this code' },
      });
      const handle = await claudeFamiliar.start(request);

      const output: string[] = [];
      claudeFamiliar.onOutput(handle, (data) => output.push(data));

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('completed');
      expect(response.outputs.exitCode).toBe(0);
      expect(output.join('')).toContain('analyze this code');
      expect(output.join('')).toContain('--dangerously-skip-permissions');

      await claudeFamiliar.destroyAll();
    });
  });

  // ── Spawn error handling tests ──────────────────────────────

  describe('spawn error handling', () => {
    it('emits failed response for non-ENOENT spawn errors (no hang)', async () => {
      // /dev/null exists but is not executable — triggers EACCES
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/dev/null',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      const response = await new Promise<WorkResponse>((resolve) => {
        familiar.onComplete.call(claudeFamiliar, handle, (res: WorkResponse) => resolve(res));
      });

      expect(response.status).toBe('failed');
      expect(response.outputs.exitCode).toBe(1);
      expect(response.outputs.error).toContain('Spawn error');

      await claudeFamiliar.destroyAll();
    }, 5_000);

    it('emits failed response for non-existent command without fallback', async () => {
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '__nonexistent_binary__',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('failed');
      expect(response.outputs.exitCode).toBe(1);
      expect(response.outputs.error).toContain('Spawn error');

      await claudeFamiliar.destroyAll();
    }, 5_000);
  });

  // ── Terminal spec tests ──────────────────────────────────────

  describe('getTerminalSpec', () => {
    it('returns cwd from workspace path', async () => {
      const request = makeRequest({
        inputs: { command: 'echo hello', workspacePath: '/tmp' },
      });
      const handle = await familiar.start(request);
      const spec = familiar.getTerminalSpec(handle);
      expect(spec).toEqual({ cwd: '/tmp' });
    });

    it('falls back to process.cwd() when no workspace path', async () => {
      const request = makeRequest({ inputs: { command: 'echo hello' } });
      const handle = await familiar.start(request);
      const spec = familiar.getTerminalSpec(handle);
      expect(spec).toEqual({ cwd: process.cwd() });
    });

    it('returns null for unknown handle', () => {
      const spec = familiar.getTerminalSpec({ executionId: 'nonexistent', taskId: 'x' });
      expect(spec).toBeNull();
    });

    it('returns claude --resume spec for claude tasks', async () => {
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);
      const spec = claudeFamiliar.getTerminalSpec(handle);

      expect(spec).toBeDefined();
      expect(spec!.command).toBe('claude');
      expect(spec!.args).toHaveLength(2);
      expect(spec!.args![0]).toBe('--resume');
      expect(spec!.args![1]).toMatch(/^[0-9a-f-]+$/); // UUID format

      await claudeFamiliar.destroyAll();
    });
  });

  describe('claudeSessionId on handle', () => {
    it('exposes claudeSessionId on handle for claude tasks', async () => {
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      expect(handle.claudeSessionId).toBeDefined();
      expect(typeof handle.claudeSessionId).toBe('string');
      expect(handle.claudeSessionId).toMatch(/^[0-9a-f-]+$/);

      await claudeFamiliar.destroyAll();
    });

    it('does not set claudeSessionId for command tasks', async () => {
      const request = makeRequest({ inputs: { command: 'echo hello' } });
      const handle = await familiar.start(request);

      expect(handle.claudeSessionId).toBeUndefined();
    });

    it('includes claudeSessionId in WorkResponse outputs', async () => {
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeFamiliar.onComplete(handle, (res) => resolve(res));
      });

      expect(response.outputs.claudeSessionId).toBe(handle.claudeSessionId);

      await claudeFamiliar.destroyAll();
    });
  });

  // ── Death log tests ────────────────────────────────────────────

  describe('death log emission', () => {
    it('emits death log to output stream on non-zero exit', async () => {
      const request = makeRequest({ inputs: { command: 'exit 42' } });
      const handle = await familiar.start(request);

      const output: string[] = [];
      familiar.onOutput(handle, (data) => output.push(data));

      await new Promise<void>((resolve) => {
        familiar.onComplete(handle, () => resolve());
      });

      const combined = output.join('');
      expect(combined).toContain('[local] Process exited');
      expect(combined).toContain('exitCode=42');
    });

    it('emits death log with signal info when killed', async () => {
      const request = makeRequest({ inputs: { command: 'sleep 60' } });
      const handle = await familiar.start(request);

      const output: string[] = [];
      familiar.onOutput(handle, (data) => output.push(data));

      const responsePromise = new Promise<WorkResponse>((resolve) => {
        familiar.onComplete(handle, (res) => resolve(res));
      });

      await familiar.kill(handle);
      await responsePromise;

      const combined = output.join('');
      expect(combined).toContain('[local] Process exited');
      expect(combined).toMatch(/signal=SIG(TERM|KILL)/);
    });

    it('emits death log on successful exit', async () => {
      const request = makeRequest({ inputs: { command: 'echo hello' } });
      const handle = await familiar.start(request);

      const output: string[] = [];
      familiar.onOutput(handle, (data) => output.push(data));

      await new Promise<void>((resolve) => {
        familiar.onComplete(handle, () => resolve());
      });

      const combined = output.join('');
      expect(combined).toContain('[local] Process exited');
      expect(combined).toContain('exitCode=0');
    });

    it('completion fires even when recordTaskResult throws', async () => {
      const claudeFamiliar = new LocalFamiliar({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });
      mockGitLifecycle(claudeFamiliar);

      // Override recordTaskResult to throw
      (claudeFamiliar as any).recordTaskResult = async () => {
        throw new Error('Simulated recordTaskResult failure');
      };

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test' },
      });
      const handle = await claudeFamiliar.start(request);

      const output: string[] = [];
      claudeFamiliar.onOutput(handle, (data) => output.push(data));

      const response = await Promise.race([
        new Promise<WorkResponse>((resolve) => {
          claudeFamiliar.onComplete(handle, (res) => resolve(res));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('onComplete never fired — task hung')), 5000),
        ),
      ]);

      expect(response.status).toBe('failed');
      expect(response.outputs.exitCode).toBe(1);
      expect(output.join('')).toContain('recordTaskResult');

      await claudeFamiliar.destroyAll();
    }, 10_000);
  });

  // ── Heartbeat tests ────────────────────────────────────────────

  describe('heartbeat', () => {
    it('forces completion when close handler fails silently', async () => {
      const heartbeatFamiliar = new LocalFamiliar({ heartbeatIntervalMs: 200 });
      mockGitLifecycle(heartbeatFamiliar);

      const request = makeRequest({ inputs: { command: 'echo fast' } });
      const handle = await heartbeatFamiliar.start(request);

      // Sabotage: remove close listener so completion never fires normally
      const entry = (heartbeatFamiliar as any).entries.get(handle.executionId);
      const child = entry.process;
      child.removeAllListeners('close');
      entry.completed = false;

      const response = await Promise.race([
        new Promise<WorkResponse>((resolve) => {
          heartbeatFamiliar.onComplete(handle, (res) => resolve(res));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('heartbeat did not detect orphan')), 5000),
        ),
      ]);

      expect(response.status).toBe('failed');
      expect(response.outputs.error).toContain('heartbeat');

      await heartbeatFamiliar.destroyAll();
    }, 10_000);
  });

  describe('getRestoredTerminalSpec', () => {
    const baseMeta: PersistedTaskMeta = {
      taskId: 'task-1',
      familiarType: 'local',
    };

    afterEach(() => {
      vi.mocked(existsSync).mockReset();
    });

    it('returns cwd spec when workspace exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        workspacePath: '/tmp/test-workspace',
      });
      expect(spec).toEqual({ cwd: '/tmp/test-workspace' });
    });

    it('returns claude --resume spec with cwd when session exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        workspacePath: '/tmp/test-workspace',
        claudeSessionId: 'session-abc',
      });
      expect(spec).toEqual({
        command: 'claude',
        args: ['--resume', 'session-abc', '--dangerously-skip-permissions'],
        cwd: '/tmp/test-workspace',
      });
    });

    it('throws when workspace path does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);
      expect(() =>
        familiar.getRestoredTerminalSpec({
          ...baseMeta,
          workspacePath: '/tmp/deleted-workspace',
        }),
      ).toThrow(/no longer exists/);
    });

    it('returns spec with undefined cwd when no workspace path provided', () => {
      const spec = familiar.getRestoredTerminalSpec(baseMeta);
      expect(spec).toEqual({ cwd: undefined });
    });

    it('returns claude --resume spec without cwd when no workspace path', () => {
      const spec = familiar.getRestoredTerminalSpec({
        ...baseMeta,
        claudeSessionId: 'session-xyz',
      });
      expect(spec).toEqual({
        command: 'claude',
        args: ['--resume', 'session-xyz', '--dangerously-skip-permissions'],
        cwd: undefined,
      });
    });
  });

  describe('concurrent workspace serialization', () => {
    it('serializes concurrent starts in the same workspace', async () => {
      const setupOrder: string[] = [];
      const sharedCwd = process.cwd();

      const familiar = new LocalFamiliar({ claudeCommand: 'echo' });
      mockGitLifecycle(familiar);
      vi.spyOn(familiar as any, 'syncFromRemote').mockResolvedValue(undefined);
      vi.mocked((familiar as any).setupTaskBranch).mockImplementation(
        async (_cwd: string, request: any) => {
          const id = request.actionId;
          setupOrder.push(`enter-${id}`);
          await new Promise(r => setTimeout(r, 50));
          setupOrder.push(`exit-${id}`);
          return 'master';
        },
      );

      const req1: any = {
        requestId: 'r1', actionId: 'task-1', actionType: 'command',
        inputs: { command: 'echo 1', workspacePath: sharedCwd },
        callbackUrl: '', timestamps: { createdAt: new Date().toISOString() },
      };
      const req2: any = {
        requestId: 'r2', actionId: 'task-2', actionType: 'command',
        inputs: { command: 'echo 2', workspacePath: sharedCwd },
        callbackUrl: '', timestamps: { createdAt: new Date().toISOString() },
      };

      // Start both concurrently
      await Promise.all([
        familiar.start(req1),
        familiar.start(req2),
      ]);

      // The order should show that task-2 doesn't enter until task-1 exits
      expect(setupOrder[0]).toBe('enter-task-1');
      expect(setupOrder[1]).toBe('exit-task-1');
      expect(setupOrder[2]).toBe('enter-task-2');
      expect(setupOrder[3]).toBe('exit-task-2');

      await familiar.destroyAll();
    });
  });

  // ── emitComplete idempotency ──────────────────────────────────

  describe('emitComplete idempotency', () => {
    it('second emitComplete call is ignored — onComplete fires only once', async () => {
      const request = makeRequest({ inputs: { command: 'echo hello' } });
      const handle = await familiar.start(request);

      const responses: WorkResponse[] = [];
      familiar.onComplete(handle, (res) => responses.push(res));

      const entry = (familiar as any).entries.get(handle.executionId);
      const firstResponse: WorkResponse = {
        requestId: 'req-1', actionId: 'action-1', status: 'failed',
        outputs: { exitCode: 1, error: 'first' },
      };
      const secondResponse: WorkResponse = {
        requestId: 'req-1', actionId: 'action-1', status: 'completed',
        outputs: { exitCode: 0 },
      };

      (familiar as any).emitComplete(handle.executionId, firstResponse);
      (familiar as any).emitComplete(handle.executionId, secondResponse);

      expect(responses).toHaveLength(1);
      expect(responses[0].status).toBe('failed');
      expect(entry.completionResponse.status).toBe('failed');
    });
  });

  // ── spawn error uses emitComplete ─────────────────────────────

  describe('spawn error completion', () => {
    it('spawn error sets completionResponse for late subscribers', async () => {
      const request = makeRequest({
        actionId: 'spawn-err',
        inputs: { command: '/nonexistent/binary/xyz_does_not_exist' },
      });

      const handle = await familiar.start(request);

      const response = await Promise.race([
        new Promise<WorkResponse>((resolve) => {
          familiar.onComplete(handle, (res) => resolve(res));
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no completion received')), 5000),
        ),
      ]);

      expect(response.status).toBe('failed');

      // Late subscriber should also receive the response via replay
      const entry = (familiar as any).entries.get(handle.executionId);
      expect(entry.completionResponse).toBeDefined();
      expect(entry.completionResponse.status).toBe('failed');
    }, 10_000);
  });
});
