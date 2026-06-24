import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '@invoker/transport';

import { SharedMutationOwnerTimeoutError, electronCommandArgs, runHeadlessClientCommand } from '../headless-client.js';

describe('headless-client', () => {
  const savedStandalone = process.env.INVOKER_HEADLESS_STANDALONE;
  beforeEach(() => {
    delete process.env.INVOKER_HEADLESS_STANDALONE;
  });
  afterEach(() => {
    if (savedStandalone === undefined) {
      delete process.env.INVOKER_HEADLESS_STANDALONE;
    } else {
      process.env.INVOKER_HEADLESS_STANDALONE = savedStandalone;
    }
  });

  it('passes Linux headless stability flags before the app entry point', () => {
    const args = electronCommandArgs(['query', 'workflows'], 'linux');
    const mainIndex = args.findIndex((arg) => arg.endsWith('/main.js'));

    expect(mainIndex).toBeGreaterThan(0);
    expect(args.slice(0, mainIndex)).toEqual([
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-gpu-compositing',
      '--disable-gpu-sandbox',
      '--disable-software-rasterizer',
    ]);
    expect(args.slice(mainIndex + 1)).toEqual(['--headless', 'query', 'workflows']);
  });

  it('delegates mutating commands to a standalone-capable owner endpoint', async () => {
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
    expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
      args: ['retry', 'wf-1'],
      noTrack: true,
      waitForApproval: false,
    }));
    expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    expect(runElectronHeadless).not.toHaveBeenCalled();
  });

  it('delegates an auto-fix command, preserving the --auto-fix flag and stripping --no-track', async () => {
    const bus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.exec', ownerHandler);
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-af', mode: 'standalone' }));

    const exitCode = await runHeadlessClientCommand(['fix', 'wf-1/task-1', 'claude', '--auto-fix', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
      args: ['fix', 'wf-1/task-1', 'claude', '--auto-fix'],
      noTrack: true,
      waitForApproval: false,
    }));
  });

  it('delegates recreate-downstream as a mutating command through headless.exec, honoring --no-track', async () => {
    const bus = new LocalBus();
    const ownerHandler = vi.fn(async () => ({ ok: true }));
    bus.onRequest('headless.exec', ownerHandler);
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-rd', mode: 'standalone' }));

    const exitCode = await runHeadlessClientCommand(['recreate-downstream', 'wf-1/A', '--no-track'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ownerHandler).toHaveBeenCalledTimes(1);
    expect(ownerHandler).toHaveBeenCalledWith(expect.objectContaining({
      args: ['recreate-downstream', 'wf-1/A'],
      noTrack: true,
      waitForApproval: false,
    }));
  });

  it('delegates mutations to an existing GUI owner', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    const guiOwnerHandler = vi.fn(async () => ({ ok: true }));
    const daemonOwnerHandler = vi.fn(async () => ({ ok: true }));

    firstBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-gui', mode: 'gui' }));
    firstBus.onRequest('headless.exec', guiOwnerHandler);
    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-daemon', mode: 'standalone' }));
    secondBus.onRequest('headless.exec', daemonOwnerHandler);

    const ensureStandaloneOwner = vi.fn(async () => {});
    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(firstBus)
      .mockResolvedValue(secondBus);

    const exitCode = await runHeadlessClientCommand(['retry', 'wf-1', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    expect(refreshMessageBus).not.toHaveBeenCalled();
    expect(guiOwnerHandler).toHaveBeenCalledTimes(1);
    expect(daemonOwnerHandler).not.toHaveBeenCalled();
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

  // --- Regression: owner endpoint scope for headless.run ---

  it('delegates headless.run to a standalone-capable owner endpoint', async () => {
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

    const exitCode = await runHeadlessClientCommand(['rebase-retry', 'wf-2/root', '--no-track'], {
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

  it('uses a refreshed standalone owner without bootstrapping', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    const runHandler = vi.fn(async () => ({ workflowId: 'wf-bootstrap', tasks: [] }));

    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-2', mode: 'standalone' }));
    secondBus.onRequest('headless.run', runHandler);

    const ensureStandaloneOwner = vi.fn(async () => {});
    const refreshMessageBus = vi.fn()
      .mockResolvedValueOnce(secondBus)
      .mockResolvedValue(secondBus);

    const exitCode = await runHeadlessClientCommand(['run', '/tmp/plan.yaml', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    expect(refreshMessageBus).toHaveBeenCalledTimes(1);
    expect(runHandler).toHaveBeenCalledTimes(1);
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

    const exitCode = await runHeadlessClientCommand(['rebase-retry', 'wf-9/root', '--no-track'], {
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

  it('refreshes past a non-mutation owner before delegating a mutation', async () => {
    const firstBus = new LocalBus();
    const secondBus = new LocalBus();
    const firstExecHandler = vi.fn(async () => ({ ok: true }));
    const secondExecHandler = vi.fn(async () => ({ ok: true }));

    firstBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'observer' }));
    firstBus.onRequest('headless.exec', firstExecHandler);
    secondBus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-2', mode: 'standalone' }));
    secondBus.onRequest('headless.exec', secondExecHandler);

    const ensureStandaloneOwner = vi.fn(async () => {});
    const refreshMessageBus = vi.fn(async () => secondBus);

    const exitCode = await runHeadlessClientCommand(['recreate', 'wf-3', '--no-track'], {
      messageBus: firstBus,
      ensureStandaloneOwner,
      refreshMessageBus,
      runElectronHeadless: vi.fn(async () => 0),
    });

    expect(exitCode).toBe(0);
    expect(ensureStandaloneOwner).not.toHaveBeenCalled();
    expect(refreshMessageBus).toHaveBeenCalled();
    expect(firstExecHandler).not.toHaveBeenCalled();
    expect(secondExecHandler).toHaveBeenCalledTimes(1);
  }, 15_000);

  it('falls back to the host runtime for non-mutating commands', async () => {
    const runElectronHeadless = vi.fn(async () => 0);
    const exitCode = await runHeadlessClientCommand(['query', 'workflows'], {
      messageBus: new LocalBus(),
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(runElectronHeadless).toHaveBeenCalledWith(['query', 'workflows']);
  });

  it('delegates query ui-perf to a reachable owner endpoint', async () => {
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

  it('does not silently fall back for query ui-perf when no owner endpoint is reachable', async () => {
    await expect(
      runHeadlessClientCommand(['query', 'ui-perf', '--output', 'json'], {
        messageBus: new LocalBus(),
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless: vi.fn(async () => 0),
      }),
    ).rejects.toThrow(/requires a running shared owner process/);
  }, 30_000);

  it('delegates query action-graph to a reachable owner endpoint', async () => {
    const bus = new LocalBus();
    const graph = {
      generatedAt: '2026-05-14T12:00:00.000Z',
      stallThresholdMs: 60_000,
      nodes: [],
      edges: [],
    };
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async (payload) => {
      expect(payload).toEqual({ kind: 'action-graph' });
      return graph;
    });

    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const runElectronHeadless = vi.fn(async () => 0);

    const exitCode = await runHeadlessClientCommand(['query', 'action-graph', '--output', 'json'], {
      messageBus: bus,
      ensureStandaloneOwner: vi.fn(async () => {}),
      runElectronHeadless,
    });

    expect(exitCode).toBe(0);
    expect(runElectronHeadless).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(graph)}\n`);
    stdout.mockRestore();
  });

  it('does not silently fall back for query action-graph when no owner endpoint is reachable', async () => {
    await expect(
      runHeadlessClientCommand(['query', 'action-graph', '--output', 'json'], {
        messageBus: new LocalBus(),
        ensureStandaloneOwner: vi.fn(async () => {}),
        runElectronHeadless: vi.fn(async () => 0),
      }),
    ).rejects.toThrow(/query action-graph requires a running shared owner process/);
  }, 30_000);

  it('delegates query queue to a reachable owner endpoint', async () => {
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
