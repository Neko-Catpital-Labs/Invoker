import { describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { SharedMutationOwnerTimeoutError, runHeadlessClientCommand } from '../headless-client.js';

describe('headless-client', () => {
  it('delegates mutating commands to an existing standalone owner without electron fallback', async () => {
    const bus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.exec', ownerHandler);
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'standalone' }));

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

  it('delegates mutating commands to an existing GUI owner without bootstrapping standalone', async () => {
    const bus = new LocalBus();
    const guiOwnerHandler = vi.fn(async () => ({ ok: true }));

    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.exec', guiOwnerHandler);

    const exitCode = await runHeadlessClientCommand(['retry', 'wf-1', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(guiOwnerHandler).toHaveBeenCalledTimes(1);
  });

  it('uses a longer no-track delegation timeout for an already-running standalone owner under load', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'standalone' }));
    bus.onRequest('headless.exec', async () => {
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      return { ok: true };
    });

    const exitCode = await runHeadlessClientCommand(['retry', 'wf-1', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
  }, 15_000);

  // --- Regression: standalone-owner scope for headless.run ---

  it('delegates headless.run to an existing standalone owner', async () => {
    const bus = new LocalBus();
    const runHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.run', runHandler);
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'standalone' }));

    const exitCode = await runHeadlessClientCommand(['run', '/tmp/plan.yaml', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(runHandler).toHaveBeenCalledTimes(1);
    expect(runHandler).toHaveBeenCalledWith(expect.objectContaining({ planPath: expect.stringContaining('plan.yaml') }));
  });

  // --- Regression: standalone-owner scope for headless.resume ---

  it('delegates headless.resume to an existing standalone owner', async () => {
    const bus = new LocalBus();
    const resumeHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.resume', resumeHandler);
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'standalone' }));

    const exitCode = await runHeadlessClientCommand(['resume', 'wf-42', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(resumeHandler).toHaveBeenCalledTimes(1);
    expect(resumeHandler).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'wf-42' }));
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

  it('refreshes the message bus around bootstrap when no owner is initially reachable', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));

    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-2', mode: 'standalone' }));
    secondBus.onRequest('headless.exec', ownerHandler);

    const ensureStandaloneOwner = vi.fn(async () => {});
    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(firstBus)
      .mockResolvedValueOnce(secondBus);

    const exitCode = await runHeadlessClientCommand(['rebase', 'wf-2/root', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).toHaveBeenCalledTimes(1);
    expect(ensureStandaloneOwner).toHaveBeenCalledWith(firstBus);
    expect(refreshMessageBus).toHaveBeenCalledTimes(2);
    expect(ownerHandler).toHaveBeenCalledTimes(1);
  });

  it('passes the refreshed bus into bootstrap after an owner-timeout retry', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    let bootstrapCalls = 0;

    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-2', mode: 'standalone' }));
    secondBus.onRequest('headless.run', async () => ({ workflowId: 'wf-bootstrap', tasks: [] }));

    const ensureStandaloneOwner = vi.fn(async (_bus?: unknown) => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) {
        throw new SharedMutationOwnerTimeoutError();
      }
    });
    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(secondBus)
      .mockResolvedValueOnce(secondBus)
      .mockResolvedValue(secondBus);

    const exitCode = await runHeadlessClientCommand(['run', '/tmp/plan.yaml', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).toHaveBeenNthCalledWith(1, secondBus);
    expect(ensureStandaloneOwner).toHaveBeenNthCalledWith(2, secondBus);
  });

  it('uses a longer no-track delegation timeout after bootstrap under load', async () => {
    const bus = new LocalBus();
    const ensureStandaloneOwner = vi.fn(async () => {
      bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-3', mode: 'standalone' }));
      bus.onRequest('headless.exec', async () => {
        await new Promise((resolve) => setTimeout(resolve, 9_000));
        return { ok: true };
      });
    });

    const exitCode = await runHeadlessClientCommand(['rebase', 'wf-9/root', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('retries bootstrap once after a stale-bus timeout', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));
    let bootstrapCalls = 0;

    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-4', mode: 'standalone' }));
    secondBus.onRequest('headless.exec', ownerHandler);

    const ensureStandaloneOwner = vi.fn(async () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) {
        throw new SharedMutationOwnerTimeoutError();
      }
    });
    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(firstBus)
      .mockResolvedValueOnce(secondBus)
      .mockResolvedValue(secondBus);

    const exitCode = await runHeadlessClientCommand(['recreate', 'wf-22', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).toHaveBeenCalledTimes(2);
    expect(ownerHandler).toHaveBeenCalledTimes(1);
  });

  it('retries post-bootstrap delegation until a restarted owner is reachable', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    let pingCalls = 0;
    let execCalls = 0;

    const ensureStandaloneOwner = vi.fn(async () => {});
    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(secondBus)
      .mockResolvedValue(secondBus);

    secondBus.onRequest('headless.owner-ping', async () => {
      pingCalls += 1;
      return pingCalls >= 2 ? { ok: true, ownerId: 'owner-5', mode: 'standalone' } : null;
    });
    secondBus.onRequest('headless.exec', async () => {
      execCalls += 1;
      return { ok: true };
    });

    const exitCode = await runHeadlessClientCommand(['recreate', 'wf-23', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).toHaveBeenCalledTimes(1);
    expect(execCalls).toBe(1);
    expect(pingCalls).toBeGreaterThanOrEqual(2);
  });

  it('re-bootstraps after repeated owner loss during post-bootstrap no-track delegation', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    const thirdBus = new LocalBus();
    let bootstrapCalls = 0;
    let refreshCalls = 0;
    let thirdBusExecCalls = 0;

    const ensureStandaloneOwner = vi.fn(async () => {
      bootstrapCalls += 1;
    });
    const refreshMessageBus = vi.fn(async () => {
      refreshCalls += 1;
      return refreshCalls <= 90 ? secondBus : thirdBus;
    });

    secondBus.onRequest('headless.owner-ping', async () => null);
    thirdBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-8', mode: 'standalone' }));
    thirdBus.onRequest('headless.exec', async () => {
      thirdBusExecCalls += 1;
      return { ok: true };
    });

    const exitCode = await runHeadlessClientCommand(['recreate', 'wf-24', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(bootstrapCalls).toBeGreaterThanOrEqual(2);
    expect(thirdBusExecCalls).toBe(1);
  }, 30_000);

  it('refreshes and retries queue queries when owner ping succeeds before query service is ready', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    let queueCalls = 0;

    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-6', mode: 'standalone' }));
    secondBus.onRequest('headless.query', async () => {
      queueCalls += 1;
      if (queueCalls === 1) {
        return await new Promise(() => {});
      }
      return { running: [], queued: [], runningCount: 0, maxConcurrency: 5 };
    });

    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(secondBus)
      .mockResolvedValue(secondBus);

    const exitCode = await runHeadlessClientCommand(['query', 'queue', '--output', 'json'], {
      messageBus: firstBus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(queueCalls).toBe(2);
    expect(refreshMessageBus).toHaveBeenCalled();
  }, 15_000);

  it('uses the current GUI owner directly without refreshing or bootstrapping standalone', async () => {
    const firstBus = new LocalBus();
    let firstExecCalls = 0;

    firstBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    firstBus.onRequest('headless.exec', async () => {
      firstExecCalls += 1;
      return { ok: true };
    });

    const ensureStandaloneOwner = vi.fn(async () => {});
    const refreshMessageBus = vi.fn(async () => firstBus);

    const exitCode = await runHeadlessClientCommand(['recreate', 'wf-3', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    expect(refreshMessageBus).not.toHaveBeenCalled();
    expect(firstExecCalls).toBe(1);
  }, 15_000);

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
  }, 30_000);

  it('delegates query queue to an existing owner without electron fallback', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async () => ({
      maxConcurrency: 4,
      runningCount: 1,
      running: [{ taskId: 'wf-1/root', description: 'root task' }],
      queued: [],
    }));

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runElectronHeadless = vi.fn(async () => 0);

    const exitCode = await runHeadlessClientCommand(['query', 'queue', '--output', 'json'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(runElectronHeadless).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith('{"maxConcurrency":4,"runningCount":1,"running":[{"taskId":"wf-1/root","description":"root task"}],"queued":[]}\n');
    stdout.mockRestore();
  });
});
