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

  it('does not start a reentrant run before the active tick returns', async () => {
    const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    let runtime!: ReturnType<typeof createWorkerRuntime>;
    let insideFirstTick = false;
    let reentrantTickStartedInsideFirstTick = false;

    const onTick = vi.fn((ctx) => {
      if (ctx.tickNumber === 1) {
        insideFirstTick = true;
        void runtime.run(['follow-up']);
        insideFirstTick = false;
        return;
      }
      if (insideFirstTick) {
        reentrantTickStartedInsideFirstTick = true;
      }
    });
    runtime = createWorkerRuntime({
      kind: 'test-run-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
    });

    await runtime.run(['first']);

    expect(onTick).toHaveBeenCalledTimes(2);
    expect(onTick.mock.calls[0][0].args).toEqual(['first']);
    expect(onTick.mock.calls[1][0].args).toEqual(['follow-up']);
    expect(reentrantTickStartedInsideFirstTick).toBe(false);
  });
});
