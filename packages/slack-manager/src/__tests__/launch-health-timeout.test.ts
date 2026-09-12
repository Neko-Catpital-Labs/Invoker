import { describe, it, expect } from 'vitest';
import { INVOKER_LAUNCH_HEALTH_TIMEOUT_MS } from '../launch-health-timeout.js';

describe('INVOKER_LAUNCH_HEALTH_TIMEOUT_MS', () => {
  it('allows enough time for a large invoker.db cold boot', () => {
    expect(INVOKER_LAUNCH_HEALTH_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000);
  });
});
