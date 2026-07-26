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
    expect(autoStartedWorkersIdx, 'owner-serve must auto-start workers before exposing the web surface').toBeLessThan(
      startWebSurfaceIdx,
    );
    expect(launchDispatcherIdx, 'owner-serve must start the launch dispatcher before exposing the web surface').toBeLessThan(
      startWebSurfaceIdx,
    );
    expect(startWebSurfaceIdx, 'owner-serve must start the web surface before the idle loop begins').toBeLessThan(
      runHeadlessIdx,
    );
  });
});
