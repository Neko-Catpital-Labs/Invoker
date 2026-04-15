import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { runHeadlessClientCommand } from '../headless-client.js';

describe('headless-client', () => {
  it('delegates mutating commands to an existing owner without electron fallback', async () => {
    const bus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.exec', ownerHandler);
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));

    const runElectronHeadless = vi.fn(async () => 0);
    const ensureStandaloneOwner = vi.fn(async () => {});

    const exitCode = await runHeadlessClientCommand(['restart', 'wf-1', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner,
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(ownerHandler).toHaveBeenCalledWith({
      args: ['restart', 'wf-1'],
      noTrack: true,
      waitForApproval: false,
    });
    expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    expect(runElectronHeadless).not.toHaveBeenCalled();
  });

  it('bootstraps a standalone owner once when no owner is present, then delegates', async () => {
    const bus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));
    const ensureStandaloneOwner = vi.fn(async () => {
      bus.onRequest('headless.exec', ownerHandler);
      bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'standalone' }));
    });

    const exitCode = await runHeadlessClientCommand(['restart', 'wf-2', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).toHaveBeenCalledTimes(1);
    expect(ownerHandler).toHaveBeenCalledTimes(1);
  });

  it('falls back to the electron runtime for non-mutating commands', async () => {
    const runElectronHeadless = vi.fn(async () => 0);
    const exitCode = await runHeadlessClientCommand(['query', 'workflows'], {
      messageBus: new LocalBus(),
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(runElectronHeadless).toHaveBeenCalledWith(['query', 'workflows']);
  });
});
