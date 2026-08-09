import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupLocalInvokerHome } from '../workers/disk-headroom-reclaim.js';

const tempDirs: string[] = [];

type ProcessWithNoAsar = NodeJS.Process & { noAsar?: boolean };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function getNoAsar(): boolean | undefined {
  return (process as ProcessWithNoAsar).noAsar;
}

function makeInvokerHome(): { home: string; userHome: string } {
  const userHome = mkdtempSync(join(tmpdir(), 'invoker-disk-reclaim-asar-noasar-'));
  tempDirs.push(userHome);
  const home = join(userHome, '.invoker');
  mkdirSync(home, { recursive: true });
  return { home, userHome };
}

describe('cleanupLocalInvokerHome Electron asar guard repro', () => {
  it('leaves process.noAsar falsy after cleanupLocalInvokerHome finishes', async () => {
    const { home, userHome } = makeInvokerHome();

    const result = await cleanupLocalInvokerHome({ invokerHome: home, userHome });

    expect(result.ok).toBe(true);
    expect(getNoAsar()).toBeFalsy();
  });

  it('enables process.noAsar during the local disk sweep', async () => {
    const { home, userHome } = makeInvokerHome();
    let observedNoAsar: boolean | undefined;
    const observeBeginLine = (message: string) => {
      if (message.includes('[disk-headroom-cleanup] local begin')) {
        observedNoAsar = getNoAsar();
      }
    };

    const result = await cleanupLocalInvokerHome({
      invokerHome: home,
      userHome,
      logger: {
        info: observeBeginLine,
        warn: observeBeginLine,
        error: () => {},
        debug: () => {},
      } as any,
    });

    expect(result.ok).toBe(true);
    expect(observedNoAsar).toBe(true);
  });
});
