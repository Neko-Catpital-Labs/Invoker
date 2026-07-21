import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocalBus } from '@invoker/transport';

import { runHeadlessClientCommand } from '../headless-client.js';

/**
 * `query workers` must report the owner's runtime liveness when an owner is
 * running. The generic `cli-query` path cannot: the owner rebuilds the
 * snapshot from persistence there, so every worker reads back as stopped.
 */
describe('query workers against a live owner', () => {
  const savedStandalone = process.env.INVOKER_HEADLESS_STANDALONE;
  const savedDbDir = process.env.INVOKER_DB_DIR;
  let dbDir: string;
  let stdout: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  const makeDeps = (bus: LocalBus) => ({
    messageBus: bus,
    ensureStandaloneOwner: vi.fn(async () => {}),
    runElectronHeadless: vi.fn(async () => 0),
  });

  beforeEach(() => {
    delete process.env.INVOKER_HEADLESS_STANDALONE;
    dbDir = mkdtempSync(join(tmpdir(), 'worker-live-status-'));
    process.env.INVOKER_DB_DIR = dbDir;
    stdout = '';
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
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

  it('reports the running lifecycle the owner reports', async () => {
    const bus = new LocalBus();
    bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
    bus.onRequest('headless.query', async (request: { kind: string }) => {
      expect(request.kind).toBe('workers');
      return {
        generatedAt: '2026-07-21T00:00:00.000Z',
        workers: [
          { kind: 'autofix', lifecycle: 'running', policy: 'enabled', desiredEnabled: true, running: true },
          { kind: 'ci-failure', lifecycle: 'stopped', policy: 'enabled', desiredEnabled: false, running: false },
        ],
      };
    });

    await expect(runHeadlessClientCommand(['query', 'workers'], makeDeps(bus))).resolves.toBe(0);

    expect(stdout).toContain('autofix: running');
    expect(stdout).toContain('ci-failure: stopped');
  });

  it('falls back to the local snapshot when no owner answers', async () => {
    const bus = new LocalBus();

    await expect(runHeadlessClientCommand(['query', 'workers'], makeDeps(bus))).resolves.toBe(0);

    expect(stdout).toContain('autofix');
  });
});
