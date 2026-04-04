import { describe, it, expect, vi } from 'vitest';
import type { MessageBus } from '@invoker/transport';
import { tryDelegateRun } from '../headless.js';

describe('headless delegation fallback', () => {
  it('falls back when peer has no headless.run handler', async () => {
    const unsubscribe = vi.fn();
    const bus = {
      subscribe: vi.fn().mockReturnValue(unsubscribe),
      request: vi.fn().mockRejectedValue(new Error('No request handler registered for channel: headless.run')),
    } as unknown as MessageBus;

    await expect(tryDelegateRun('/tmp/plan.yaml', bus)).resolves.toBe(false);
    expect(bus.subscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });
});
