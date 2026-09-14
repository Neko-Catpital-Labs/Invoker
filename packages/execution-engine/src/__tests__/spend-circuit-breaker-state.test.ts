import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearSpendCircuitBreakerTrip,
  loadSpendCircuitBreakerState,
  recordSpendCircuitBreakerTrip,
  type SpendCircuitBreakerTripRecord,
} from '../spend-circuit-breaker-state.js';

const tempDirs: string[] = [];

function makeTempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spend-breaker-state-test-'));
  tempDirs.push(dir);
  return join(dir, 'spend-circuit-breaker.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const record: SpendCircuitBreakerTripRecord = {
  workerKind: 'e2e-autofix',
  trippedAt: '2026-09-04T03:00:00.000Z',
  windowStartMs: 1000,
  nowMs: 2000,
  windowTokens: 500_000,
  tokenBudget: 100_000,
};

describe('spend circuit breaker state', () => {
  it('returns an empty state when no file exists yet', () => {
    expect(loadSpendCircuitBreakerState(makeTempPath())).toEqual({});
  });

  it('persists a trip record and reads it back durably, keyed by worker kind', () => {
    const path = makeTempPath();

    recordSpendCircuitBreakerTrip(path, record);
    const reloaded = loadSpendCircuitBreakerState(path);

    expect(reloaded['e2e-autofix']).toEqual(record);
  });

  it('records trips for two different workers independently', () => {
    const path = makeTempPath();

    recordSpendCircuitBreakerTrip(path, record);
    recordSpendCircuitBreakerTrip(path, { ...record, workerKind: 'pr-admin-bypass-land' });

    const state = loadSpendCircuitBreakerState(path);

    expect(Object.keys(state).sort()).toEqual(['e2e-autofix', 'pr-admin-bypass-land']);
  });

  it('clears only the named worker kind, leaving others tripped', () => {
    const path = makeTempPath();
    recordSpendCircuitBreakerTrip(path, record);
    recordSpendCircuitBreakerTrip(path, { ...record, workerKind: 'pr-admin-bypass-land' });

    clearSpendCircuitBreakerTrip(path, 'e2e-autofix');

    const state = loadSpendCircuitBreakerState(path);
    expect(state['e2e-autofix']).toBeUndefined();
    expect(state['pr-admin-bypass-land']).toBeDefined();
  });

  it('treats a corrupt state file as empty rather than throwing', () => {
    const path = makeTempPath();
    recordSpendCircuitBreakerTrip(path, record);
    writeFileSync(path, 'not json{{{');

    expect(loadSpendCircuitBreakerState(path)).toEqual({});
  });
});
