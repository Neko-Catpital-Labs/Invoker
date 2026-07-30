import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

function findOwnerServeBlock(source: string): { start: number; end: number } {
  const start = source.indexOf("if (command === 'owner-serve') {");
  const open = source.indexOf('{', start);
  let end = -1;
  if (open > -1) {
    let depth = 0;
    for (let idx = open; idx < source.length; idx += 1) {
      if (source[idx] === '{') {
        depth += 1;
      } else if (source[idx] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = idx;
          break;
        }
      }
    }
  }
  return { start, end };
}

describe('standalone owner web surface wiring', () => {

  it('starts the headless web surface for owner-serve before entering the idle loop', () => {
    const source = readFileSync(MAIN, 'utf8');

    const ownerServeGuard = findOwnerServeBlock(source);
    const autoStartedWorkersIdx = source.indexOf('workerRuntimeController.startAutoStartedWorkers();');
    const launchDispatcherIdx = source.indexOf(
      'standaloneLaunchDispatcherController = startStandaloneLaunchDispatcher({',
    );
    const startWebSurfaceIdx = source.indexOf('headlessWebBridge = startWebSurfaceForHeadless(');
    const runHeadlessIdx = source.indexOf('await runHeadless(cliArgs, headlessDeps);');

    expect(ownerServeGuard.start, 'owner-serve guard not found').toBeGreaterThan(-1);
    expect(ownerServeGuard.end, 'owner-serve guard close not found').toBeGreaterThan(-1);
    expect(autoStartedWorkersIdx, 'worker auto-start initialization not found').toBeGreaterThan(-1);
    expect(launchDispatcherIdx, 'standalone launch dispatcher initialization not found').toBeGreaterThan(-1);
    expect(startWebSurfaceIdx, 'headless owner web surface startup not found').toBeGreaterThan(-1);
    expect(runHeadlessIdx, 'runHeadless call not found').toBeGreaterThan(-1);

    expect(ownerServeGuard.start, 'owner-serve guard must wrap the headless web surface startup').toBeLessThan(
      startWebSurfaceIdx,
    );
    expect(startWebSurfaceIdx, 'headless owner web surface startup must stay inside the owner-serve guard').toBeLessThan(
      ownerServeGuard.end,
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

  it('registers recovery worker mutation channels before auto-starting workers', () => {
    const source = readFileSync(MAIN, 'utf8');

    const retryRegistrationIdx = source.indexOf("workflowMutationDispatcher.has('invoker:retry-task')");
    const fixRegistrationIdx = source.indexOf("workflowMutationDispatcher.has('invoker:fix-with-agent')");
    const autoStartedWorkersIdx = source.indexOf('workerRuntimeController.startAutoStartedWorkers();');

    expect(retryRegistrationIdx, 'standalone retry-task dispatcher registration not found').toBeGreaterThan(-1);
    expect(fixRegistrationIdx, 'standalone fix-with-agent dispatcher registration not found').toBeGreaterThan(-1);
    expect(autoStartedWorkersIdx, 'worker auto-start initialization not found').toBeGreaterThan(-1);
    expect(retryRegistrationIdx).toBeLessThan(autoStartedWorkersIdx);
    expect(fixRegistrationIdx).toBeLessThan(autoStartedWorkersIdx);
  });
});
