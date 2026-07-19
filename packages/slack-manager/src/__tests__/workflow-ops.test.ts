import { describe, it, expect, vi } from 'vitest';
import { createRunWorkflowOp } from '../workflow-ops.js';
import { InvokerDownError, type InvokerClient } from '../invoker-client.js';

const noop = (): void => {};

function makeClient(overrides: Partial<InvokerClient> = {}): InvokerClient {
  const base: InvokerClient = {
    ping: vi.fn(async () => true),
    isHealthy: vi.fn(async () => true),
    listWorkflows: vi.fn(async () => []),
    getWorkflowBundle: vi.fn(async () => ({ workflow: undefined, tasks: [] })),
    getWorkflowStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0 })),
    getTaskOutput: vi.fn(async () => ''),
    exec: vi.fn(async () => {}),
    run: vi.fn(async () => 'wf-x'),
    launch: vi.fn(async () => true),
    withRecovery: vi.fn(async (fn: () => Promise<unknown>) => fn()) as InvokerClient['withRecovery'],
    subscribe: vi.fn(() => () => {}),
    onReconnect: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe('createRunWorkflowOp', () => {
  it('recreate all → lists workflows then exec recreate per id with onProgress', async () => {
    const client = makeClient({ listWorkflows: vi.fn(async () => [{ id: 'wf-1' }, { id: 'wf-2' }]) });
    const onProgress = vi.fn();
    const run = createRunWorkflowOp(client, noop);

    const res = await run({ operation: 'recreate', target: { all: true } }, onProgress);

    expect(client.listWorkflows).toHaveBeenCalledTimes(1);
    expect(client.exec).toHaveBeenNthCalledWith(1, ['recreate', 'wf-1']);
    expect(client.exec).toHaveBeenNthCalledWith(2, ['recreate', 'wf-2']);
    expect(res).toEqual({ ok: true, summary: 'recreate: 2 ok' });
    // one progress per id plus a final flush
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ current: 'wf-1', total: 2 }));
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ done: 2, total: 2, ok: 2, failed: 0 }));
  });

  it('cancel maps to the workflow-scoped cancel-workflow command', async () => {
    const client = makeClient({ listWorkflows: vi.fn(async () => [{ id: 'wf-9' }]) });
    await createRunWorkflowOp(client, noop)({ operation: 'cancel', target: { workflow: 'wf-9' } });
    expect(client.exec).toHaveBeenCalledWith(['cancel-workflow', 'wf-9']);
  });

  it('status → queries per-workflow status and builds a summary (no mutation)', async () => {
    const client = makeClient({
      listWorkflows: vi.fn(async () => [{ id: 'wf-1' }]),
      getWorkflowStatus: vi.fn(async () => ({ total: 3, completed: 1, failed: 0, closed: 0, running: 1, pending: 1 })),
    });
    const res = await createRunWorkflowOp(client, noop)({ operation: 'status', target: { all: true } });
    expect(client.exec).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('`wf-1`: 1 running, 1 pending, 1 done, 0 failed');
  });

  it('resolves a single workflow by name', async () => {
    const client = makeClient({ listWorkflows: vi.fn(async () => [{ id: 'wf-1', name: 'login' }]) });
    await createRunWorkflowOp(client, noop)({ operation: 'retry', target: { workflow: 'login' } });
    expect(client.exec).toHaveBeenCalledWith(['retry', 'wf-1']);
  });

  it('returns a not-found result for an unknown target', async () => {
    const client = makeClient({ listWorkflows: vi.fn(async () => [{ id: 'wf-1' }]) });
    const res = await createRunWorkflowOp(client, noop)({ operation: 'recreate', target: { workflow: 'nope' } });
    expect(res).toEqual({ ok: false, summary: 'No workflow matching `nope`.' });
    expect(client.exec).not.toHaveBeenCalled();
  });

  it('records per-workflow failures without aborting the batch', async () => {
    const client = makeClient({
      listWorkflows: vi.fn(async () => [{ id: 'wf-1' }, { id: 'wf-2' }]),
      exec: vi.fn(async (args: string[]) => { if (args[1] === 'wf-1') throw new Error('boom'); }),
    });
    const res = await createRunWorkflowOp(client, noop)({ operation: 'recreate', target: { all: true } });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('recreate: 1 ok, 1 failed');
    expect(res.summary).toContain('wf-1: boom');
  });

  it('returns the down summary when Invoker stays down', async () => {
    const client = makeClient({ withRecovery: vi.fn(async () => { throw new InvokerDownError('down'); }) as InvokerClient['withRecovery'] });
    const res = await createRunWorkflowOp(client, noop)({ operation: 'recreate', target: { all: true } });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('Invoker is down');
    expect(res.summary).toContain('@Invoker restart');
    expect(res.summary).not.toMatch(/Reply `restart`/);
  });
});
