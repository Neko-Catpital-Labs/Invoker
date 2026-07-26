import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

describe('standalone owner web surface wiring', () => {
  it('starts the headless web surface for owner-serve before entering the idle loop', () => {
    const source = readFileSync(MAIN, 'utf8');

    const ownerServeGuardIdx = source.indexOf("if (command === 'owner-serve') {");
    const startWebSurfaceIdx = source.indexOf('headlessWebBridge = startWebSurfaceForHeadless(');
    const runHeadlessIdx = source.indexOf('await runHeadless(cliArgs, headlessDeps);');

    expect(ownerServeGuardIdx, 'owner-serve guard not found').toBeGreaterThan(-1);
    expect(startWebSurfaceIdx, 'headless owner web surface startup not found').toBeGreaterThan(-1);
    expect(runHeadlessIdx, 'runHeadless call not found').toBeGreaterThan(-1);

    expect(startWebSurfaceIdx, 'owner-serve must start the web surface before the idle loop begins').toBeLessThan(runHeadlessIdx);
    expect(ownerServeGuardIdx, 'owner-serve guard must wrap the headless web surface startup').toBeLessThan(startWebSurfaceIdx);
  });
});
