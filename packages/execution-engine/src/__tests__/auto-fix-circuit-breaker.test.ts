import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearCircuitBreaker,
  isCircuitBreakerPaused,
  loadCircuitBreakerState,
  tripCircuitBreaker,
} from '../auto-fix-circuit-breaker.js';

describe('auto-fix circuit breaker', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'invoker-circuit-breaker-'));
    path = join(dir, 'auto-fix-pause.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports not paused when no pause file exists', () => {
    const state = loadCircuitBreakerState(path);
    expect(isCircuitBreakerPaused(state, Date.now())).toBe(false);
  });

  it('tripping the breaker pauses until the window elapses, then resumes', () => {
    const now = new Date('2026-08-14T06:00:00.000Z');
    tripCircuitBreaker(path, { now, reason: 'usage-limit', pauseMs: 6 * 60 * 60 * 1000 });

    const state = loadCircuitBreakerState(path);
    expect(state.reason).toBe('usage-limit');
    expect(isCircuitBreakerPaused(state, now.getTime() + 1000)).toBe(true);
    expect(isCircuitBreakerPaused(state, now.getTime() + 6 * 60 * 60 * 1000 + 1)).toBe(false);
  });

  it('a later trip re-arms the window from its own time, not the first trip', () => {
    const first = new Date('2026-08-14T06:00:00.000Z');
    tripCircuitBreaker(path, { now: first, reason: 'usage-limit', pauseMs: 60 * 60 * 1000 });

    const second = new Date('2026-08-14T06:50:00.000Z');
    tripCircuitBreaker(path, { now: second, reason: 'usage-limit', pauseMs: 60 * 60 * 1000 });

    const state = loadCircuitBreakerState(path);
    // Still "paused" at the first window's original expiry, because the
    // second failure (still inside that window) re-armed it further out.
    expect(isCircuitBreakerPaused(state, first.getTime() + 60 * 60 * 1000 + 1000)).toBe(true);
    expect(isCircuitBreakerPaused(state, second.getTime() + 60 * 60 * 1000 + 1000)).toBe(false);
  });

  it('clearCircuitBreaker lets a human override the pause immediately', () => {
    tripCircuitBreaker(path, { now: new Date(), reason: 'usage-limit', pauseMs: 24 * 60 * 60 * 1000 });
    clearCircuitBreaker(path);

    const state = loadCircuitBreakerState(path);
    expect(isCircuitBreakerPaused(state, Date.now())).toBe(false);
  });

  it('does not treat a corrupt pause file as paused', () => {
    writeFileSync(path, '{ this is not valid json');
    const state = loadCircuitBreakerState(path);
    expect(isCircuitBreakerPaused(state, Date.now())).toBe(false);
  });
});
