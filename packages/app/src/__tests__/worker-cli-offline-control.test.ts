import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBus } from '@invoker/transport';

import { runHeadlessClientCommand } from '../headless-client.js';

/**
 * Repro for the owner-only worker control lockout.
 *
 * `worker stop <kind>` only changes the persisted `desiredEnabled` row that
 * `startAutoStartedWorkers()` reads on boot. That row is reachable offline,
 * but the CLI refuses the command whenever no owner process answers the ping,
 * so an operator cannot disable a worker while the app is down.
 */
describe('worker CLI offline control (repro)', () => {
  const savedStandalone = process.env.INVOKER_HEADLESS_STANDALONE;
  const savedDbDir = process.env.INVOKER_DB_DIR;
  let dbDir: string;

  const makeDeps = (bus: LocalBus) => ({
    messageBus: bus,
    ensureStandaloneOwner: vi.fn(async () => {}),
    runElectronHeadless: vi.fn(async () => 0),
  });

  beforeEach(() => {
    delete process.env.INVOKER_HEADLESS_STANDALONE;
    dbDir = mkdtempSync(join(tmpdir(), 'worker-offline-control-'));
    process.env.INVOKER_DB_DIR = dbDir;
  });

  afterEach(() => {
    if (savedStandalone === undefined) {
      delete process.env.INVOKER_HEADLESS_STANDALONE;
    } else {
      process.env.INVOKER_HEADLESS_STANDALONE = savedStandalone;
    }
    if (savedDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = savedDbDir;
    }
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('currently refuses `worker stop` when no owner process is running', async () => {
    const bus = new LocalBus();
    const deps = makeDeps(bus);

    await expect(runHeadlessClientCommand(['worker', 'stop', 'autofix'], deps))
      .rejects.toThrow(/No running Invoker owner found to stop the "autofix" worker/);

    expect(deps.runElectronHeadless).not.toHaveBeenCalled();
  });

  it('currently refuses `worker start` when no owner process is running', async () => {
    const bus = new LocalBus();
    const deps = makeDeps(bus);

    await expect(runHeadlessClientCommand(['worker', 'start', 'autofix'], deps))
      .rejects.toThrow(/No running Invoker owner found to start the "autofix" worker/);

    expect(deps.runElectronHeadless).not.toHaveBeenCalled();
  });

  it('still delegates worker control to a reachable owner', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.gui-mutation', async (request: { channel: string; args: string[] }) => {
      expect(request).toEqual({ channel: 'invoker:stop-worker', args: ['autofix'] });
      return { kind: 'autofix', desiredEnabled: false, lifecycle: 'stopped' };
    });

    await expect(runHeadlessClientCommand(['worker', 'stop', 'autofix'], makeDeps(bus))).resolves.toBe(0);
  });
});
