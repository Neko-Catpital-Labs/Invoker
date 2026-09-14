import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

describe('standalone owner web surface wiring', () => {

  it('starts the headless web surface for owner-serve before entering the idle loop', () => {
    const source = readFileSync(MAIN, 'utf8');

    const ownerServeGuardIdx = source.indexOf("if (command === 'owner-serve') {");
    const ownerServeGuardOpenBraceIdx = source.indexOf('{', ownerServeGuardIdx);
    let ownerServeGuardCloseBraceIdx = -1;
    if (ownerServeGuardOpenBraceIdx > -1) {
      let depth = 0;
      for (let idx = ownerServeGuardOpenBraceIdx; idx < source.length; idx += 1) {
        if (source[idx] === '{') {
          depth += 1;
        } else if (source[idx] === '}') {
          depth -= 1;
          if (depth === 0) {
            ownerServeGuardCloseBraceIdx = idx;
            break;
          }
        }
      }
    }
    const autoStartedWorkersIdx = source.indexOf('workerRuntimeController.startAutoStartedWorkers();');
    const launchDispatcherIdx = source.indexOf(
      'standaloneLaunchDispatcherController = startStandaloneLaunchDispatcher({',
    );
    const startWebSurfaceIdx = source.indexOf('headlessWebBridge = startWebSurfaceForHeadless(');
    const runHeadlessIdx = source.indexOf('await runHeadless(cliArgs, headlessDeps);');

    expect(ownerServeGuardIdx, 'owner-serve guard not found').toBeGreaterThan(-1);
    expect(ownerServeGuardOpenBraceIdx, 'owner-serve guard opening brace not found').toBeGreaterThan(-1);
    expect(ownerServeGuardCloseBraceIdx, 'owner-serve guard closing brace not found').toBeGreaterThan(-1);
    expect(autoStartedWorkersIdx, 'worker auto-start initialization not found').toBeGreaterThan(-1);
    expect(launchDispatcherIdx, 'standalone launch dispatcher initialization not found').toBeGreaterThan(-1);
    expect(startWebSurfaceIdx, 'headless owner web surface startup not found').toBeGreaterThan(-1);
    expect(runHeadlessIdx, 'runHeadless call not found').toBeGreaterThan(-1);

    expect(ownerServeGuardIdx, 'owner-serve guard must wrap the headless web surface startup').toBeLessThan(
      startWebSurfaceIdx,
    );
    expect(startWebSurfaceIdx, 'headless owner web surface startup must stay inside the owner-serve guard').toBeLessThan(
      ownerServeGuardCloseBraceIdx,
    );
    expect(startWebSurfaceIdx, 'owner-serve must start the web surface BEFORE auto-starting workers').toBeLessThan(
      autoStartedWorkersIdx,
    );
    expect(startWebSurfaceIdx, 'owner-serve must start the web surface BEFORE the launch dispatcher').toBeLessThan(
      launchDispatcherIdx,
    );
    expect(startWebSurfaceIdx, 'owner-serve must start the web surface before the idle loop begins').toBeLessThan(
      runHeadlessIdx,
    );
  });

  it('passes deferFirstPollUntil to the launch dispatcher for owner-serve', () => {
    const source = readFileSync(MAIN, 'utf8');
    const deferOptionIdx = source.indexOf('deferFirstPollUntil: headlessWebBridge?.whenReady');
    expect(deferOptionIdx, 'launch dispatcher must receive deferFirstPollUntil option').toBeGreaterThan(-1);
  });

  it('awaits whenReady inside the owner-serve guard before workers/dispatcher/recovery', () => {
    const source = readFileSync(MAIN, 'utf8');

    const ownerServeGuardIdx = source.indexOf("if (command === 'owner-serve') {");
    const ownerServeGuardOpenBraceIdx = source.indexOf('{', ownerServeGuardIdx);
    let ownerServeGuardCloseBraceIdx = -1;
    if (ownerServeGuardOpenBraceIdx > -1) {
      let depth = 0;
      for (let idx = ownerServeGuardOpenBraceIdx; idx < source.length; idx += 1) {
        if (source[idx] === '{') {
          depth += 1;
        } else if (source[idx] === '}') {
          depth -= 1;
          if (depth === 0) {
            ownerServeGuardCloseBraceIdx = idx;
            break;
          }
        }
      }
    }

    const startWebSurfaceIdx = source.indexOf('headlessWebBridge = startWebSurfaceForHeadless(');
    const awaitWhenReadyIdx = source.indexOf('await headlessWebBridge.whenReady');
    const autoStartedWorkersIdx = source.indexOf('workerRuntimeController.startAutoStartedWorkers();');
    const launchDispatcherIdx = source.indexOf(
      'standaloneLaunchDispatcherController = startStandaloneLaunchDispatcher({',
    );
    const recoverMutationsIdx = source.indexOf('void recoverWorkflowMutationsOnStartup({');

    expect(startWebSurfaceIdx, 'headless owner web surface startup not found').toBeGreaterThan(-1);
    expect(
      awaitWhenReadyIdx,
      'F3 fix: owner-serve must await headlessWebBridge.whenReady to ensure HTTP binds ' +
      'before any sync boot work — source-line ordering alone is not enough',
    ).toBeGreaterThan(-1);
    expect(autoStartedWorkersIdx, 'worker auto-start initialization not found').toBeGreaterThan(-1);
    expect(launchDispatcherIdx, 'standalone launch dispatcher initialization not found').toBeGreaterThan(-1);
    expect(recoverMutationsIdx, 'recoverWorkflowMutationsOnStartup not found').toBeGreaterThan(-1);

    expect(
      startWebSurfaceIdx,
      'startWebSurfaceForHeadless must come before await whenReady',
    ).toBeLessThan(awaitWhenReadyIdx);
    expect(
      awaitWhenReadyIdx,
      'await whenReady must be inside the owner-serve guard',
    ).toBeLessThan(ownerServeGuardCloseBraceIdx);
    expect(
      awaitWhenReadyIdx,
      'F3 fix: await whenReady must come BEFORE startAutoStartedWorkers ' +
      '(ensures HTTP binds before sync scheduler drains block the event loop)',
    ).toBeLessThan(autoStartedWorkersIdx);
    expect(
      awaitWhenReadyIdx,
      'F3 fix: await whenReady must come BEFORE startStandaloneLaunchDispatcher ' +
      '(ensures HTTP binds before dispatcher poll blocks the event loop)',
    ).toBeLessThan(launchDispatcherIdx);
    expect(
      awaitWhenReadyIdx,
      'F3 fix: await whenReady must come BEFORE recoverWorkflowMutationsOnStartup ' +
      '(ensures HTTP binds before any boot-time scheduler work)',
    ).toBeLessThan(recoverMutationsIdx);
  });
});
