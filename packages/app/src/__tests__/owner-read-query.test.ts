import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { runHeadlessClientCommand } from '../headless-client.js';

describe('owner read query', () => {
  it('delegates ui-perf reads without resetting owner stats by default', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    const queryPayloads: Array<Record<string, unknown>> = [];
    bus.onRequest('headless.query', async (payload: unknown) => {
      queryPayloads.push(payload as Record<string, unknown>);
      return {
        ownerMode: 'gui',
        maxRendererEventLoopLagMs: 22,
        maxRendererLongTaskMs: 33,
        planningTypingLagReports: 1,
        maxPlanningTypingLagMs: 55,
        maxPlanningTypingLagContext: {
          scenario: 'many-chats-many-messages-typing',
          activeSurface: 'planning',
        },
      };
    });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let written = '';
    try {
      const exitCode = await runHeadlessClientCommand(['query', 'ui-perf', '--output', 'json'], {
        messageBus: bus,
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless: vi.fn(async () => 0),
      });
      expect(exitCode).toBe(0);
      written = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    } finally {
      stdout.mockRestore();
    }

    expect(queryPayloads).toEqual([{ kind: 'ui-perf', reset: false }]);
    const payload = JSON.parse(written) as Record<string, unknown>;
    expect(payload).toEqual(expect.objectContaining({
      ownerMode: 'gui',
      maxRendererEventLoopLagMs: 22,
      maxRendererLongTaskMs: 33,
      planningTypingLagReports: 1,
      maxPlanningTypingLagMs: 55,
    }));
  });
});
