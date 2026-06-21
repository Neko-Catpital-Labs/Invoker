import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

/**
 * Regression guard for INV-192: a standalone owner must register its owner
 * discovery (headless.owner-ping) and exec handlers before it starts
 * launch-dispatch polling. If polling starts first, the owner can own the IPC
 * socket while owner-ping still returns NO_HANDLER, so peer clients connect but
 * cannot resolve a standalone owner and mutating commands fail closed.
 */
describe('standalone owner handler ordering', () => {
  it('registers owner discovery and exec handlers before starting launch-dispatch polling', () => {
    const source = readFileSync(MAIN, 'utf8');

    const ownerPingIdx = source.indexOf("messageBus.onRequest('headless.owner-ping'");
    const execIdx = source.indexOf("messageBus.onRequest('headless.exec'");
    const dispatcherIdx = source.indexOf('startStandaloneLaunchDispatcher({');

    expect(ownerPingIdx, 'standalone headless.owner-ping handler not found').toBeGreaterThan(-1);
    expect(execIdx, 'standalone headless.exec handler not found').toBeGreaterThan(-1);
    expect(dispatcherIdx, 'startStandaloneLaunchDispatcher call not found').toBeGreaterThan(-1);

    expect(
      ownerPingIdx,
      'INV-192: startStandaloneLaunchDispatcher must run after headless.owner-ping is registered',
    ).toBeLessThan(dispatcherIdx);
    expect(
      execIdx,
      'INV-192: startStandaloneLaunchDispatcher must run after headless.exec is registered',
    ).toBeLessThan(dispatcherIdx);
  });
});
