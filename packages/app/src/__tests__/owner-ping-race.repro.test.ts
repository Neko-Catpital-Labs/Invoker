import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');
const HEADLESS_CLIENT = path.resolve(__dirname, '..', 'headless-client.ts');

/**
 * Repro for a production log where a GUI process pinged a live standalone
 * owner during startup:
 *
 *   [delegation] headless.owner-ping:10189:...:c00c96 send timeoutMs=500
 *   [delegation] headless.owner-ping:10189:...:c00c96 response elapsedMs=501 ownerId=owner-10257... mode=standalone
 *
 * The response arrived 1ms past its own timeoutMs budget and happened to
 * still win the Promise.race that day. A 500ms budget for a same-machine
 * IPC round trip (right as a second Electron process is spinning up and
 * competing for the event loop) is thin enough that ordinary jitter can
 * just as easily cross it the other way: a live, responsive owner gets
 * reported as unreachable, which can cascade into
 * discoverStandaloneOwnerForGui/ensureStandaloneOwnerForGui believing no
 * owner exists and spawning a redundant standalone owner process.
 *
 * discoverOwner's ping budget is passed as a literal at each call site
 * rather than through an exported constant, so — matching this repo's
 * existing pattern for asserting on logic embedded in main.ts (see
 * standalone-owner-handler-ordering.test.ts) — this checks the literal
 * values directly in source rather than exercising tryPingHeadlessOwner
 * with a value the test invents itself.
 *
 * it.fails: these 3 call sites still use the 500ms outlier budget on
 * master; this slice only proves the bug. The next slice widens them to
 * 1500ms and flips these to plain `it`.
 */
describe('owner-ping timeout race', () => {
  it('discoverStandaloneOwnerForGui in main.ts does not use the 500ms outlier budget', () => {
    const source = readFileSync(MAIN, 'utf8');
    const match = source.match(/discoverOwner\(ownerBus,\s*(\d+)\)/);
    expect(match, 'discoverOwner(ownerBus, ...) call site not found in main.ts').not.toBeNull();
    const timeoutMs = Number(match![1]);
    expect(
      timeoutMs,
      `discoverStandaloneOwnerForGui pings with ${timeoutMs}ms, an outlier next to every other discoverOwner call site (1000-2000ms elsewhere)`,
    ).toBeGreaterThanOrEqual(1000);
  });

  it('the two discoverOwner call sites in headless-client.ts do not use the 500ms outlier budget', () => {
    const source = readFileSync(HEADLESS_CLIENT, 'utf8');
    const matches = [...source.matchAll(/discoverOwner\([^,]+,\s*(\d+)\)/g)];
    expect(matches.length, 'expected 2 discoverOwner(...) call sites in headless-client.ts').toBe(2);
    for (const m of matches) {
      const timeoutMs = Number(m[1]);
      expect(
        timeoutMs,
        `discoverOwner call in headless-client.ts pings with ${timeoutMs}ms, an outlier next to every other discoverOwner call site (1000-2000ms elsewhere)`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });
});
