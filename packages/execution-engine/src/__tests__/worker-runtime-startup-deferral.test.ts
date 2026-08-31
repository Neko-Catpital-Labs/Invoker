import { describe, expect, it, vi } from 'vitest';

import { createWorkerRuntime } from '../worker-runtime.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

describe('worker runtime startup scheduling', () => {
  it('does not execute a startup tick inline before sibling runtimes can start', async () => {
    const ticks: string[] = [];
    const runtime = createWorkerRuntime({
      kind: 'slow-first-worker',
      logger,
      installSignalHandlers: false,
      onTick: () => {
        ticks.push('startup');
      },
    });

    runtime.start();

    expect(runtime.isRunning()).toBe(true);
    expect(ticks).toEqual([]);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(ticks).toEqual(['startup']);
    await runtime.stop({ settleTimeoutMs: 100 });
  });
});
