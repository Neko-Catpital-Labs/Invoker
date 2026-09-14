import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface SpendCircuitBreakerTripRecord {
  readonly workerKind: string;
  readonly trippedAt: string;
  readonly windowStartMs: number;
  readonly nowMs: number;
  readonly windowTokens: number;
  readonly tokenBudget: number;
}

export type SpendCircuitBreakerState = Readonly<Record<string, SpendCircuitBreakerTripRecord>>;

export function defaultSpendCircuitBreakerPath(): string {
  return process.env.INVOKER_SPEND_CIRCUIT_BREAKER_FILE
    ?? join(homedir(), '.invoker', 'spend-circuit-breaker.json');
}

export function loadSpendCircuitBreakerState(path: string): SpendCircuitBreakerState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    return raw as SpendCircuitBreakerState;
  } catch {
    return {};
  }
}

export function saveSpendCircuitBreakerState(path: string, state: SpendCircuitBreakerState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function recordSpendCircuitBreakerTrip(
  path: string,
  record: SpendCircuitBreakerTripRecord,
): SpendCircuitBreakerState {
  const state = loadSpendCircuitBreakerState(path);
  const next = { ...state, [record.workerKind]: record };
  saveSpendCircuitBreakerState(path, next);
  return next;
}

export function clearSpendCircuitBreakerTrip(path: string, workerKind: string): SpendCircuitBreakerState {
  const state = loadSpendCircuitBreakerState(path);
  if (!(workerKind in state)) return state;
  const next = { ...state };
  delete (next as Record<string, unknown>)[workerKind];
  saveSpendCircuitBreakerState(path, next);
  return next;
}
