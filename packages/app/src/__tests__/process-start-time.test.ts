import { describe, expect, it } from 'vitest';

import { parseEtimeSeconds, pidWasRecycledSince, readProcessStartTimeMs } from '../process-start-time.js';

describe('process start time', () => {
  it('parses ps etime formats', () => {
    expect(parseEtimeSeconds('05:42')).toBe(342);
    expect(parseEtimeSeconds('01:02:03')).toBe(3723);
    expect(parseEtimeSeconds('2-01:02:03')).toBe(2 * 86_400 + 3723);
    expect(parseEtimeSeconds('')).toBeNull();
    expect(parseEtimeSeconds('garbage')).toBeNull();
  });

  it('reads this process start time as earlier than now', () => {
    const startedAtMs = readProcessStartTimeMs(process.pid);
    if (process.platform === 'win32') {
      expect(startedAtMs).toBeNull();
      return;
    }
    expect(startedAtMs).not.toBeNull();
    expect(startedAtMs!).toBeLessThanOrEqual(Date.now());
  });

  it('flags a process that started after the lock as recycled', () => {
    const lockCreatedAtMs = 1_000_000;
    expect(pidWasRecycledSince(123, lockCreatedAtMs, () => lockCreatedAtMs + 60_000)).toBe(true);
  });

  it('stays conservative within skew, on unknown start time, and unknown lock time', () => {
    const lockCreatedAtMs = 1_000_000;
    expect(pidWasRecycledSince(123, lockCreatedAtMs, () => lockCreatedAtMs + 1_000)).toBe(false);
    expect(pidWasRecycledSince(123, lockCreatedAtMs, () => null)).toBe(false);
    expect(pidWasRecycledSince(123, null, () => lockCreatedAtMs + 60_000)).toBe(false);
  });
});
