import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBus } from '@invoker/transport';

import { runHeadlessClientCommand } from '../headless-client.js';
import { openMainProcessDatabase } from '../viewer-db-boundary.js';

/**
 * `worker start/stop <kind>` only changes the persisted `desiredEnabled` row
 * that `startAutoStartedWorkers()` reads on boot. That row is reachable with
 * no owner process running, so the CLI must not refuse the command just
 * because nothing answers the owner ping.
 */
describe('worker CLI offline control', () => {
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

  const readDesiredState = async (kind: string): Promise<boolean | undefined> => {
    const persistence = await openMainProcessDatabase({
      dbPath: join(dbDir, 'invoker.db'),
      detachedViewer: false,
      readOnly: true,
      exclusiveLocking: false,
    });
    try {
      return persistence.getWorkerDesiredState(kind)?.desiredEnabled;
    } finally {
      persistence.close();
    }
  };

  it('records `worker stop` as disabled when no owner process is running', async () => {
    const bus = new LocalBus();
    const deps = makeDeps(bus);

    await expect(runHeadlessClientCommand(['worker', 'stop', 'autofix'], deps)).resolves.toBe(0);

    expect(await readDesiredState('autofix')).toBe(false);
    expect(deps.runElectronHeadless).not.toHaveBeenCalled();
  });

  it('records `worker start` as enabled when no owner process is running', async () => {
    const bus = new LocalBus();
    const deps = makeDeps(bus);

    await expect(runHeadlessClientCommand(['worker', 'start', 'autofix'], deps)).resolves.toBe(0);

    expect(await readDesiredState('autofix')).toBe(true);
    expect(deps.runElectronHeadless).not.toHaveBeenCalled();
  });

  it('rejects an unknown worker kind instead of writing a junk row', async () => {
    const bus = new LocalBus();

    await expect(runHeadlessClientCommand(['worker', 'stop', 'not-a-worker'], makeDeps(bus)))
      .rejects.toThrow(/Unknown worker kind: "not-a-worker"/);

    expect(await readDesiredState('not-a-worker')).toBeUndefined();
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
