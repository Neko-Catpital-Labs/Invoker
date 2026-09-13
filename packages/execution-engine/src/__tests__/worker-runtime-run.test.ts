import { describe, it, expect, vi } from 'vitest';
import { createWorkerRuntime } from '../worker-runtime.js';

describe('WorkerRuntime.run', () => {
  it('passes the supplied CLI args through the tick context', async () => {
    const onTick = vi.fn();
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const runtime = createWorkerRuntime({
      kind: 'test-run-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
    });

    await runtime.run(['delete-all-retry']);

    expect(onTick).toHaveBeenCalledOnce();
    expect(onTick.mock.calls[0][0].args).toEqual(['delete-all-retry']);
  });
});
