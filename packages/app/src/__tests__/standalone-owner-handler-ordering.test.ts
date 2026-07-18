import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

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
