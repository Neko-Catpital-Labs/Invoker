import { describe, expect, it } from 'vitest';
import { resolveHeadlessAgentLoginWatchConfig } from '../headless.js';
import { DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MINUTES } from '../config.js';

describe('resolveHeadlessAgentLoginWatchConfig', () => {
  it('maps configured intervalMinutes and SSH targets into worker dependencies', () => {
    const config = resolveHeadlessAgentLoginWatchConfig({
      agentLoginWatch: {
        intervalMinutes: 7,
      },
      remoteTargets: {
        do1: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/do1-key',
          port: 2222,
        },
      },
    });

    expect(config).toEqual({
      enabled: true,
      intervalMs: 7 * 60_000,
      remoteTargets: [{
        name: 'do1',
        connection: {
          host: '203.0.113.10',
          user: 'invoker',
          sshKeyPath: '/tmp/do1-key',
          port: 2222,
        },
      }],
    });
  });

  it('defaults interval and targets when config is omitted', () => {
    const config = resolveHeadlessAgentLoginWatchConfig({});

    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MINUTES * 60_000);
    expect(config.remoteTargets).toEqual([]);
  });
});
