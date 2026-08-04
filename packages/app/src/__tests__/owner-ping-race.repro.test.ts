import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');
const HEADLESS_CLIENT = path.resolve(__dirname, '..', 'headless-client.ts');
const MAIN_DISCOVER_OWNER_CALL = /discoverOwner\(ownerBus,\s*(\d+)\)/;
const HEADLESS_LITERAL_DISCOVER_OWNER_CALL = /discoverOwner\([^,]+,\s*(\d+)\)/g;

function mainDiscoverOwnerTimeoutMs(): number {
  const source = readFileSync(MAIN, 'utf8');
  const match = source.match(MAIN_DISCOVER_OWNER_CALL);
  return Number(match![1]);
}

function headlessLiteralDiscoverOwnerTimeoutsMs(): number[] {
  const source = readFileSync(HEADLESS_CLIENT, 'utf8');
  return [...source.matchAll(HEADLESS_LITERAL_DISCOVER_OWNER_CALL)].map((match) => Number(match[1]));
}

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
  it('finds the discoverStandaloneOwnerForGui discoverOwner call in main.ts', () => {
    const source = readFileSync(MAIN, 'utf8');
    expect(source.length, 'main.ts should be readable').toBeGreaterThan(0);
    const match = source.match(MAIN_DISCOVER_OWNER_CALL);
    expect(match, 'discoverOwner(ownerBus, ...) call site not found in main.ts').not.toBeNull();
    expect(Number(match![1]), 'discoverOwner(ownerBus, ...) timeout should be a numeric literal').not.toBeNaN();
  });

  it('finds the two literal discoverOwner call sites in headless-client.ts', () => {
    const source = readFileSync(HEADLESS_CLIENT, 'utf8');
    expect(source.length, 'headless-client.ts should be readable').toBeGreaterThan(0);
    const matches = [...source.matchAll(HEADLESS_LITERAL_DISCOVER_OWNER_CALL)];
    expect(matches.length, 'expected 2 literal discoverOwner(...) call sites in headless-client.ts').toBe(2);
    for (const match of matches) {
      expect(Number(match[1]), 'discoverOwner(...) timeout should be a numeric literal').not.toBeNaN();
    }
  });

  it.fails('discoverStandaloneOwnerForGui in main.ts does not use the 500ms outlier budget', () => {
    const timeoutMs = mainDiscoverOwnerTimeoutMs();
    expect(
      timeoutMs,
      `discoverStandaloneOwnerForGui pings with ${timeoutMs}ms, an outlier next to every other discoverOwner call site (1000-2000ms elsewhere)`,
    ).toBeGreaterThanOrEqual(1000);
  });

  it.fails('the two discoverOwner call sites in headless-client.ts do not use the 500ms outlier budget', () => {
    for (const timeoutMs of headlessLiteralDiscoverOwnerTimeoutsMs()) {
      expect(
        timeoutMs,
        `discoverOwner call in headless-client.ts pings with ${timeoutMs}ms, an outlier next to every other discoverOwner call site (1000-2000ms elsewhere)`,
      ).toBeGreaterThanOrEqual(1000);
    }
  });
});
