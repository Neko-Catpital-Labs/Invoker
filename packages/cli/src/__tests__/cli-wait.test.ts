import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { main, parseWaitArgs } from '../index.js';
import {
  assertInvokerWakeLineWithinBudget,
  formatInvokerWakeLine,
  INVOKER_WAKE_MAX_BYTES,
  INVOKER_WAKE_PREFIX,
} from '../invoker-wake.js';
import {
  waitForWorkflowTasks,
  workflowTasksSettled,
} from '../mcp-workflow-status.js';

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

describe('invoker-wake payload', () => {
  it('formats a compact INVOKER_WAKE line without tasks or descriptions', () => {
    const line = formatInvokerWakeLine({
      workflowId: 'wf-1',
      settled: true,
      timedOut: false,
      status: {
        total: 2,
        completed: 1,
        failed: 0,
        closed: 0,
        running: 0,
        pending: 0,
        awaitingApproval: 1,
        blocked: 0,
      },
      reviewUrl: 'https://example.test/pr/1',
    });
    expect(line.startsWith(`${INVOKER_WAKE_PREFIX} `)).toBe(true);
    const payload = JSON.parse(line.slice(INVOKER_WAKE_PREFIX.length + 1));
    expect(payload).toEqual({
      workflowId: 'wf-1',
      settled: true,
      timedOut: false,
      status: {
        total: 2,
        completed: 1,
        failed: 0,
        closed: 0,
        running: 0,
        pending: 0,
        awaitingApproval: 1,
        blocked: 0,
      },
      reviewUrl: 'https://example.test/pr/1',
    });
    expect(line).not.toContain('"tasks"');
    expect(line).not.toContain('"description"');
    assertInvokerWakeLineWithinBudget(line);
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(INVOKER_WAKE_MAX_BYTES);
  });

  it('rejects payloads that include task bodies', () => {
    expect(() => assertInvokerWakeLineWithinBudget(
      `${INVOKER_WAKE_PREFIX} ${JSON.stringify({ workflowId: 'wf', tasks: [{ id: 'a', description: 'x' }] })}`,
    )).toThrow(/must not include tasks or descriptions/);
  });
});

describe('waitForWorkflowTasks silence', () => {
  it('does not emit before settle when stdout is unused by the waiter', async () => {
    const output = captureProcessOutput();
    let calls = 0;
    const result = await waitForWorkflowTasks({
      workflowId: 'wf-1',
      maxWaitMs: 1000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
      loadTasks: async () => {
        calls += 1;
        if (calls === 1) return [{ id: 'a', status: 'running' }];
        return [{ id: 'a', status: 'completed' }];
      },
    });
    expect(result.settled).toBe(true);
    expect(output.stdout).toBe('');
    output.restore();
  });

  it('treats human-gate status as settled', () => {
    expect(workflowTasksSettled([{ id: 'a', status: 'awaiting_approval' }])).toBe(true);
  });
});

describe('invoker-cli wait', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses wait flags', () => {
    expect(parseWaitArgs(['wf-9', '--max-wait-ms', '1000', '--poll-interval-ms', '50'])).toEqual({
      workflowId: 'wf-9',
      maxWaitMs: 1000,
      pollIntervalMs: 50,
    });
  });

  it('prints one INVOKER_WAKE line after settle and exits 0', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    let calls = 0;
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => {
      calls += 1;
      if (calls === 1) {
        return { output: JSON.stringify([{ id: 'a', status: 'running' }]) };
      }
      return { output: JSON.stringify([{ id: 'a', status: 'completed' }]) };
    });

    const code = await main(
      ['wait', 'wf-1', '--max-wait-ms', '1000', '--poll-interval-ms', '1'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(0);
    const lines = output.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^INVOKER_WAKE /);
    const payload = JSON.parse(lines[0].slice('INVOKER_WAKE '.length));
    expect(payload.settled).toBe(true);
    expect(payload.timedOut).toBe(false);
    expect(payload.status.completed).toBe(1);
    expect(payload.tasks).toBeUndefined();
    output.restore();
  });

  it('exits 1 when no live owner is reachable', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => {
      throw new Error('no owner');
    });

    const code = await main(['wait', 'wf-1'], { createMessageBus: () => bus });
    expect(code).toBe(1);
    expect(output.stderr).toMatch(/No running Invoker owner/);
    expect(output.stdout).toBe('');
    output.restore();
  });

  it('prints INVOKER_WAKE and exits 1 on timeout without settle', async () => {
    const output = captureProcessOutput();
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => ({
      output: JSON.stringify([{ id: 'a', status: 'running' }]),
    }));

    const code = await main(
      ['wait', 'wf-1', '--max-wait-ms', '5', '--poll-interval-ms', '1'],
      { createMessageBus: () => bus },
    );

    expect(code).toBe(1);
    expect(output.stdout.trim().split('\n')).toHaveLength(1);
    const payload = JSON.parse(output.stdout.trim().slice('INVOKER_WAKE '.length));
    expect(payload.settled).toBe(false);
    expect(payload.timedOut).toBe(true);
    output.restore();
  });
});
