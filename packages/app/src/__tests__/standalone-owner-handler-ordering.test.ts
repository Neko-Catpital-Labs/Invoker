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

  it('standalone headless.exec merges runHeadless return into the message-bus ack when unscoped', () => {
    const source = readFileSync(MAIN, 'utf8');
    const execIdx = source.indexOf("messageBus.onRequest('headless.exec'");
    const nextHandler = source.indexOf("messageBus.onRequest('headless.gui-mutation'");
    expect(execIdx, 'standalone headless.exec handler not found').toBeGreaterThan(-1);
    expect(nextHandler, 'headless.gui-mutation handler not found after headless.exec').toBeGreaterThan(execIdx);

    const handler = source.slice(execIdx, nextHandler);
    expect(handler).toMatch(/commandResult = await runHeadless/);
    expect(handler).toMatch(/if \(!workflowId\)/);
    expect(handler).toMatch(/\.\.\.\(commandResult && typeof commandResult === 'object'/);
  });

  it('guards standalone startup worker writes behind readOnlyMode', () => {
    const source = readFileSync(MAIN, 'utf8');

    const dispatcherIdx = source.indexOf('startStandaloneLaunchDispatcher({');
    const migrateIdx = source.lastIndexOf('migrateWorkerDesiredStateFromLegacyConfig(', dispatcherIdx);
    const reconcileIdx = source.lastIndexOf('reconcileTerminalWorkerActionsOnStartup(persistence)', dispatcherIdx);

    expect(migrateIdx, 'standalone migrateWorkerDesiredStateFromLegacyConfig call not found').toBeGreaterThan(-1);
    expect(reconcileIdx, 'standalone reconcileTerminalWorkerActionsOnStartup call not found').toBeGreaterThan(-1);
    expect(dispatcherIdx, 'startStandaloneLaunchDispatcher call not found').toBeGreaterThan(-1);
    expect(reconcileIdx).toBeLessThan(dispatcherIdx);

    const migrateGuardStart = source.lastIndexOf('if (!readOnlyMode) {', migrateIdx);
    const reconcileGuardStart = source.lastIndexOf('if (!readOnlyMode) {', reconcileIdx);

    expect(migrateGuardStart, 'migrateWorkerDesiredStateFromLegacyConfig must be guarded by readOnlyMode').toBeGreaterThan(-1);
    expect(reconcileGuardStart, 'reconcileTerminalWorkerActionsOnStartup must be guarded by readOnlyMode').toBeGreaterThan(-1);

    expect(source.slice(migrateGuardStart, migrateIdx)).not.toMatch(/\n\s*}\n/);
    expect(source.slice(reconcileGuardStart, reconcileIdx)).not.toMatch(/\n\s*}\n/);
  });
});
