/**
 * Repro: Concurrent CLI headless run false "owner not running"
 *
 * Symptom: Two overlapping `electron --headless run` against a live owner:
 * one hit `[delegation] timeout channel=headless.run timeoutMs=5000` then
 * `Mutation command "run" requires a running owner process.` The other succeeded.
 * Owner stayed up, writer lock stayed with the owner pid.
 *
 * Root cause: 5s headless.run timeout is mapped to "owner not running" instead
 * of "owner busy/timeout". A busy owner is not a dead owner.
 *
 * Invariant: A live owner must not be reported dead because an IPC/delegation
 * wait timed out.
 *
 * TODO(chaos-f-fix): These tests are marked it.fails because the current
 * implementation does not export isTimeout/isNoHandler helpers that callers
 * can use to distinguish timeout from no-handler outcomes.
 *
 * After the fix applies:
 * - isTimeout and isNoHandler will be exported from headless-delegation
 * - Callers can distinguish timeout (owner busy) from no-handler (owner dead)
 * - Tests will pass and should be changed from it.fails to it
 */

import { describe, it, expect } from 'vitest';
import {
  isDelegated,
  type DelegationOutcome,
} from '../headless-delegation.js';

describe('delegation timeout vs dead owner classification', () => {
  it('isDelegated correctly identifies delegated outcomes', () => {
    const timeout: DelegationOutcome = { kind: 'timeout' };
    const noHandler: DelegationOutcome = { kind: 'no-handler' };
    const delegated: DelegationOutcome = { kind: 'delegated' };

    expect(isDelegated(timeout)).toBe(false);
    expect(isDelegated(noHandler)).toBe(false);
    expect(isDelegated(delegated)).toBe(true);
  });

  it.fails('isTimeout and isNoHandler should be exported for caller-side distinction', async () => {
    const mod = await import('../headless-delegation.js') as Record<string, unknown>;

    expect(typeof mod.isTimeout).toBe('function');
    expect(typeof mod.isNoHandler).toBe('function');

    const timeout: DelegationOutcome = { kind: 'timeout' };
    const noHandler: DelegationOutcome = { kind: 'no-handler' };

    expect((mod.isTimeout as (o: DelegationOutcome) => boolean)(timeout)).toBe(true);
    expect((mod.isTimeout as (o: DelegationOutcome) => boolean)(noHandler)).toBe(false);
    expect((mod.isNoHandler as (o: DelegationOutcome) => boolean)(timeout)).toBe(false);
    expect((mod.isNoHandler as (o: DelegationOutcome) => boolean)(noHandler)).toBe(true);
  });
});
