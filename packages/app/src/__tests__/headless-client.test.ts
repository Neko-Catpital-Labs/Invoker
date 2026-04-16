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

    const exitCode = await runHeadlessClientCommand(['retry', 'wf-1', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner,
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(ownerHandler).toHaveBeenCalledWith({
      args: ['retry', 'wf-1'],
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

    const exitCode = await runHeadlessClientCommand(['retry', 'wf-2', '--no-track'], {
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

  it('delegates query ui-perf to an existing owner without electron fallback', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => ({
      maxRendererEventLoopLagMs: 123,
      maxRendererLongTaskMs: 456,
    }));

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runElectronHeadless = vi.fn(async () => 0);

    const exitCode = await runHeadlessClientCommand(['query', 'ui-perf', '--output', 'json'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(runElectronHeadless).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith('{"maxRendererEventLoopLagMs":123,"maxRendererLongTaskMs":456}\n');
    stdout.mockRestore();
  });

  it('does not silently fall back for query ui-perf when no owner is present', async () => {
    await expect(
      runHeadlessClientCommand(['query', 'ui-perf', '--output', 'json'], {
        messageBus: new LocalBus(),
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless: vi.fn(async () => 0),
      }),
    ).rejects.toThrow(/requires a running shared owner process/);
  });
});
