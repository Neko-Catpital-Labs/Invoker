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
 * Fix applied:
 * - isTimeout and isNoHandler are now exported from headless-delegation
 * - Callers can distinguish timeout (owner busy) from no-handler (owner dead)
 */

import { describe, it, expect } from 'vitest';
import {
  isDelegated,
  isTimeout,
  isNoHandler,
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

  it('isTimeout and isNoHandler distinguish timeout from no-handler', () => {
    const timeout: DelegationOutcome = { kind: 'timeout' };
    const noHandler: DelegationOutcome = { kind: 'no-handler' };
    const delegated: DelegationOutcome = { kind: 'delegated' };

    expect(isTimeout(timeout)).toBe(true);
    expect(isTimeout(noHandler)).toBe(false);
    expect(isTimeout(delegated)).toBe(false);

    expect(isNoHandler(timeout)).toBe(false);
    expect(isNoHandler(noHandler)).toBe(true);
    expect(isNoHandler(delegated)).toBe(false);
  });
});
