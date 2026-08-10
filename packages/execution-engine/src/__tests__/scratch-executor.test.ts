import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import type { ExecutorHandle } from '../executor.js';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import { ScratchExecutor } from '../scratch-executor.js';

let reqCounter = 0;
function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  const { inputs: inputOverrides, ...restOverrides } = overrides;
  reqCounter += 1;
  return {
    requestId: `req-${reqCounter}`,
    actionId: `action-${reqCounter}`,
    actionType: 'command',
    inputs: { command: 'true', ...inputOverrides },
    callbackUrl: 'http://localhost:3000/callback',
    timestamps: { createdAt: new Date().toISOString() },
    ...restOverrides,
  };
}

function waitForComplete(executor: ScratchExecutor, handle: ExecutorHandle): Promise<WorkResponse> {
  return new Promise((resolve) => {
    executor.onComplete(handle, (res) => resolve(res));
  });
}

describe('ScratchExecutor', () => {
  it('runs a command task in an isolated temp dir with no .git present', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest({ inputs: { command: '[ ! -e .git ]' } });
    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle);

    expect(response.status).toBe('completed');
    expect(handle.workspacePath).toBeTruthy();
    expect(existsSync(handle.workspacePath!)).toBe(true);

    await executor.destroyAll();
  });

  it('does not require repoUrl on the request', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest();
    expect(request.inputs.repoUrl).toBeUndefined();
    const response = await waitForComplete(executor, await executor.start(request));
    expect(response.status).toBe('completed');
    await executor.destroyAll();
  });

  it('gives concurrently started tasks distinct temp dirs', async () => {
    const executor = new ScratchExecutor();
    const requests = Array.from({ length: 6 }, () => makeRequest({ inputs: { command: 'true' } }));
    const handles = await Promise.all(requests.map((r) => executor.start(r)));
    await Promise.all(handles.map((h) => waitForComplete(executor, h)));

    const paths = handles.map((h) => h.workspacePath);
    expect(paths.every((p) => !!p)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);

    await executor.destroyAll();
  });

  it('reports a non-zero exit code as a failed task', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest({ inputs: { command: 'exit 3' } });
    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle);

    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).toBe(3);

    await executor.destroyAll();
  });

  it('destroyAll removes temp dirs from disk', async () => {
    const executor = new ScratchExecutor();
    const request = makeRequest({ inputs: { command: 'true' } });
    const handle = await executor.start(request);
    await waitForComplete(executor, handle);
    const workspacePath = handle.workspacePath!;

    expect(existsSync(workspacePath)).toBe(true);
    await executor.destroyAll();
    expect(existsSync(workspacePath)).toBe(false);
  });
});
