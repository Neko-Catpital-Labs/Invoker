import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CircuitBreakerState {
  pausedUntil: string | null;
  reason: string | null;
  triggeredAt: string | null;
}

const EMPTY_STATE: CircuitBreakerState = { pausedUntil: null, reason: null, triggeredAt: null };

export function defaultCircuitBreakerPath(): string {
  return process.env.INVOKER_AUTO_FIX_PAUSE_FILE
    ?? join(homedir(), '.invoker', 'auto-fix-pause.json');
}

export function loadCircuitBreakerState(path: string): CircuitBreakerState {
  if (!existsSync(path)) return { ...EMPTY_STATE };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      pausedUntil: typeof raw?.pausedUntil === 'string' ? raw.pausedUntil : null,
      reason: typeof raw?.reason === 'string' ? raw.reason : null,
      triggeredAt: typeof raw?.triggeredAt === 'string' ? raw.triggeredAt : null,
    };
  } catch {
    // A corrupt or half-written pause file must not itself become a reason
    // to keep dispatching agents; treat it as "not paused" rather than throw.
    return { ...EMPTY_STATE };
  }
}

export function saveCircuitBreakerState(path: string, state: CircuitBreakerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function isCircuitBreakerPaused(state: CircuitBreakerState, nowMs: number): boolean {
  if (!state.pausedUntil) return false;
  const untilMs = new Date(state.pausedUntil).getTime();
  return Number.isFinite(untilMs) && nowMs < untilMs;
}

export interface TripCircuitBreakerOptions {
  now?: Date;
  reason: string;
  pauseMs: number;
}

/**
 * Trip the breaker for `pauseMs` from `now`. Called again while already
 * paused, this re-arms the pause window from the new failure -- the
 * generic reset-to-open mechanism instead of parsing an exact reset time
 * out of free-text provider error messages (fragile: no timezone, ordinal
 * day suffixes). Failures naturally stop recurring once the underlying
 * cause (e.g. a quota window) actually clears.
 */
export function tripCircuitBreaker(path: string, options: TripCircuitBreakerOptions): CircuitBreakerState {
  const now = options.now ?? new Date();
  const state: CircuitBreakerState = {
    pausedUntil: new Date(now.getTime() + options.pauseMs).toISOString(),
    reason: options.reason,
    triggeredAt: now.toISOString(),
  };
  saveCircuitBreakerState(path, state);
  return state;
}

export function clearCircuitBreaker(path: string): void {
  saveCircuitBreakerState(path, { ...EMPTY_STATE });
}
