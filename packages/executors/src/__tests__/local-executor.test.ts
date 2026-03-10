import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import { LocalExecutor } from '../local-executor.js';

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

describe('LocalExecutor', () => {
  let executor: LocalExecutor;

  beforeEach(() => {
    executor = new LocalExecutor();
  });

  afterEach(async () => {
    await executor.destroyAll();
  });

  it('start: spawns process and returns handle', async () => {
    const handle = await executor.start(makeRequest());
    expect(handle).toBeDefined();
    expect(handle.executionId).toBeDefined();
    expect(typeof handle.executionId).toBe('string');
    expect(handle.taskId).toBe('action-1');
  });

  it('onOutput: captures stdout', async () => {
    const request = makeRequest({ inputs: { command: 'echo hello' } });
    const handle = await executor.start(request);

    const output: string[] = [];
    executor.onOutput(handle, (data) => output.push(data));

    await new Promise<void>((resolve) => {
      executor.onComplete(handle, () => resolve());
    });

    expect(output.join('')).toContain('hello');
  });

  it('onOutput: captures stderr', async () => {
    const request = makeRequest({ inputs: { command: 'echo error-msg >&2' } });
    const handle = await executor.start(request);

    const output: string[] = [];
    executor.onOutput(handle, (data) => output.push(data));

    await new Promise<void>((resolve) => {
      executor.onComplete(handle, () => resolve());
    });

    expect(output.join('')).toContain('error-msg');
  });

  it('onComplete: returns exit code 0 on success', async () => {
    const request = makeRequest({ inputs: { command: 'echo hello' } });
    const handle = await executor.start(request);

    const response = await new Promise<WorkResponse>((resolve) => {
      executor.onComplete(handle, (res) => resolve(res));
    });

    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);
    expect(response.requestId).toBe('req-1');
    expect(response.actionId).toBe('action-1');
  });

  it('onComplete: returns correct exit code on failure', async () => {
    const request = makeRequest({ inputs: { command: 'exit 42' } });
    const handle = await executor.start(request);

    const response = await new Promise<WorkResponse>((resolve) => {
      executor.onComplete(handle, (res) => resolve(res));
    });

    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).toBe(42);
  });

  it('sendInput: writes to process stdin', async () => {
    const request = makeRequest({ inputs: { command: 'cat' } });
    const handle = await executor.start(request);

    const output: string[] = [];
    executor.onOutput(handle, (data) => output.push(data));

    // Send input then close stdin so cat exits
    executor.sendInput(handle, 'hello from stdin\n');

    // Give a small delay for data to flow, then close stdin
    await new Promise((r) => setTimeout(r, 100));
    executor.sendInput(handle, '');

    // Close stdin to let cat finish
    const entry = (executor as any).processes.get(handle.executionId);
    entry?.process.stdin?.end();

    await new Promise<void>((resolve) => {
      executor.onComplete(handle, () => resolve());
    });

    expect(output.join('')).toContain('hello from stdin');
  });

  it('kill: terminates running process', async () => {
    const request = makeRequest({ inputs: { command: 'sleep 60' } });
    const handle = await executor.start(request);

    const responsePromise = new Promise<WorkResponse>((resolve) => {
      executor.onComplete(handle, (res) => resolve(res));
    });

    await executor.kill(handle);
    const response = await responsePromise;

    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).not.toBe(0);
  });

  it('destroyAll: kills all running processes', async () => {
    const handle1 = await executor.start(
      makeRequest({
        requestId: 'req-1',
        actionId: 'action-1',
        inputs: { command: 'sleep 60' },
      }),
    );
    const handle2 = await executor.start(
      makeRequest({
        requestId: 'req-2',
        actionId: 'action-2',
        inputs: { command: 'sleep 60' },
      }),
    );

    const responses: WorkResponse[] = [];

    const p1 = new Promise<void>((resolve) => {
      executor.onComplete(handle1, (res) => {
        responses.push(res);
        resolve();
      });
    });
    const p2 = new Promise<void>((resolve) => {
      executor.onComplete(handle2, (res) => {
        responses.push(res);
        resolve();
      });
    });

    await executor.destroyAll();
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
      const handle = await executor.start(request);

      const response = await new Promise<WorkResponse>((resolve) => {
        executor.onComplete(handle, (res) => resolve(res));
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
      const handle = await executor.start(request);

      // Access internal state to verify no process was spawned
      const entry = (executor as any).processes.get(handle.executionId);
      expect(entry).toBeDefined();
      expect(entry.process).toBeNull();
    });

    it('onComplete fires after onComplete listener is registered', async () => {
      const request = makeRequest({
        actionType: 'reconciliation',
        inputs: { experimentResults: [] },
      });
      const handle = await executor.start(request);

      const response = await new Promise<WorkResponse>((resolve) => {
        executor.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('needs_input');
    });
  });

  // ── Claude CLI tests ──────────────────────────────────────────

  describe('claude action type', () => {
    it('invokes configured claude command with -p flag', async () => {
      // Use /bin/echo as the claude command so it echoes its arguments
      const claudeExecutor = new LocalExecutor({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'test prompt' },
      });
      const handle = await claudeExecutor.start(request);

      const output: string[] = [];
      claudeExecutor.onOutput(handle, (data) => output.push(data));

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeExecutor.onComplete(handle, (res) => resolve(res));
      });

      // /bin/echo was invoked with args ['-p', 'test prompt', '--output-format', 'json']
      expect(response.status).toBe('completed');
      expect(response.outputs.exitCode).toBe(0);
      const combined = output.join('');
      expect(combined).toContain('-p');
      expect(combined).toContain('test prompt');
      expect(combined).toContain('--output-format');
      expect(combined).toContain('json');

      await claudeExecutor.destroyAll();
    });

    it('falls back to echo when command not found and fallback enabled', async () => {
      const claudeExecutor = new LocalExecutor({
        claudeCommand: '__nonexistent_claude_binary__',
        claudeFallback: true,
      });

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'hello world' },
      });
      const handle = await claudeExecutor.start(request);

      const output: string[] = [];
      claudeExecutor.onOutput(handle, (data) => output.push(data));

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeExecutor.onComplete(handle, (res) => resolve(res));
      });

      expect(response.status).toBe('completed');
      expect(output.join('')).toContain('Claude prompt: hello world');

      await claudeExecutor.destroyAll();
    });

    it('captures exit code and output', async () => {
      // Use /bin/echo to verify output capture and exit code
      const claudeExecutor = new LocalExecutor({
        claudeCommand: '/bin/echo',
        claudeFallback: false,
      });

      const request = makeRequest({
        actionType: 'claude',
        inputs: { prompt: 'analyze this code' },
      });
      const handle = await claudeExecutor.start(request);

      const output: string[] = [];
      claudeExecutor.onOutput(handle, (data) => output.push(data));

      const response = await new Promise<WorkResponse>((resolve) => {
        claudeExecutor.onComplete(handle, (res) => resolve(res));
      });

      // /bin/echo with args ['-p', 'analyze this code', '--output-format', 'json']
      expect(response.status).toBe('completed');
      expect(response.outputs.exitCode).toBe(0);
      expect(output.join('')).toContain('analyze this code');
      expect(output.join('')).toContain('--output-format');
      expect(output.join('')).toContain('json');

      await claudeExecutor.destroyAll();
    });
  });
});
