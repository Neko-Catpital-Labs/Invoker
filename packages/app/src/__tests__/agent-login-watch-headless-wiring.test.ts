import { describe, expect, it } from 'vitest';
import { resolveHeadlessAgentLoginWatchConfig } from '../headless.js';

describe('agent-login-watch headless wiring', () => {
  it('maps configured SSH targets and intervalMinutes into worker dependencies', () => {
    const config = resolveHeadlessAgentLoginWatchConfig({
      agentLoginWatch: {
        intervalMinutes: 5,
      },
      remoteTargets: {
        do1: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
        },
      },
    });

    expect(config).toEqual({
      enabled: true,
      intervalMs: 5 * 60_000,
      remoteTargets: [{
        name: 'do1',
        connection: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/test-key',
          port: 2222,
        },
      }],
    });
  });

  it('defaults to an empty remote target list when config is omitted', () => {
    const config = resolveHeadlessAgentLoginWatchConfig({});

    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(60 * 60_000);
    expect(config.remoteTargets).toEqual([]);
  });
});
