import { describe, it, expect } from 'vitest';
import { collectRecoveryWorkerStatus } from '../recovery-worker-observability.js';

// Guards the focus-switch memoization: collectRecoveryWorkerStatus must not re-run the synchronous
// recovery aggregate on the main thread on every poll and refocus; it caches per persistence for a TTL.
interface CountRow {
  eventType: string;
  count: number;
  lastCreatedAt: string | null;
}

function makeCountingPersistence() {
  let countCalls = 0;
  let recentCalls = 0;
  return {
    get countCalls() {
      return countCalls;
    },
    get recentCalls() {
      return recentCalls;
    },
    countEventsByTypes(eventTypes: readonly string[]): CountRow[] {
      countCalls += 1;
      return eventTypes.map((eventType) => ({
        eventType,
        count: 42,
        lastCreatedAt: '2026-07-01T00:00:00.000Z',
      }));
    },
    getEventsByTypes(): [] {
      recentCalls += 1;
      return [];
    },
  };
}

describe('collectRecoveryWorkerStatus memoization', () => {
  it('serves repeated polls within the TTL from cache (one SQLite aggregate)', () => {
    const persistence = makeCountingPersistence();

    const first = collectRecoveryWorkerStatus(persistence, { now: 1_000, ttlMs: 10_000 });
    const second = collectRecoveryWorkerStatus(persistence, { now: 1_500, ttlMs: 10_000 });
    const third = collectRecoveryWorkerStatus(persistence, { now: 9_999, ttlMs: 10_000 });

    // Refocus herd + 2s polls within the window must not re-query.
    expect(persistence.countCalls).toBe(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(first.scans).toBe(42);
  });

  it('recomputes once the TTL elapses', () => {
    const persistence = makeCountingPersistence();

    collectRecoveryWorkerStatus(persistence, { now: 0, ttlMs: 10_000 });
    collectRecoveryWorkerStatus(persistence, { now: 10_001, ttlMs: 10_000 });

    expect(persistence.countCalls).toBe(2);
  });

  it('bypasses the cache when ttlMs is 0', () => {
    const persistence = makeCountingPersistence();

    collectRecoveryWorkerStatus(persistence, { now: 0, ttlMs: 0 });
    collectRecoveryWorkerStatus(persistence, { now: 0, ttlMs: 0 });

    expect(persistence.countCalls).toBe(2);
  });
});
