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

  it('routes standalone exec through executeHeadlessExec instead of a local runHeadless wrapper', () => {
    const source = readFileSync(MAIN, 'utf8');
    const ownerBlockStart = source.indexOf('if (standaloneMode && messageBus)');
    const cliRunIdx = source.indexOf('await runHeadless(cliArgs, headlessDeps);');
    expect(ownerBlockStart, 'standalone owner block not found').toBeGreaterThan(-1);
    expect(cliRunIdx, 'CLI runHeadless(cliArgs) not found').toBeGreaterThan(ownerBlockStart);

    const ownerBlock = source.slice(ownerBlockStart, cliRunIdx);
    expect(ownerBlock).toContain('createGuiMutationTaskActions');
    expect(ownerBlock).toContain('standaloneMutationActions.executeHeadlessExec');
    expect(ownerBlock).not.toContain('standaloneRunHeadlessCommand');
    expect(ownerBlock).not.toContain('classifyStandaloneHeadlessExecMutation');
    expect(ownerBlock).not.toMatch(/await runHeadless\(/);
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
