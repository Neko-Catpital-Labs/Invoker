import { describe, it, expect } from 'vitest';
import {
  resolveAgentLoginWatchWorkerConfig,
  DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MINUTES,
} from '../config.js';
import { validateInvokerConfig } from '../config-validation.js';

describe('agentLoginWatch config', () => {
  it('accepts omitted agentLoginWatch block', () => {
    expect(validateInvokerConfig({})).toEqual({});
  });

  it('accepts a valid intervalMinutes', () => {
    const config = validateInvokerConfig({
      agentLoginWatch: { intervalMinutes: 30 },
    });
    expect(config.agentLoginWatch?.intervalMinutes).toBe(30);
  });

  it('rejects intervalMinutes of 0', () => {
    expect(() => validateInvokerConfig({
      agentLoginWatch: { intervalMinutes: 0 },
    })).toThrow(/agentLoginWatch.intervalMinutes must be an integer > 0/);
  });

  it('rejects negative intervalMinutes', () => {
    expect(() => validateInvokerConfig({
      agentLoginWatch: { intervalMinutes: -5 },
    })).toThrow(/agentLoginWatch.intervalMinutes must be an integer > 0/);
  });

  it('rejects non-integer intervalMinutes', () => {
    expect(() => validateInvokerConfig({
      agentLoginWatch: { intervalMinutes: 1.5 },
    })).toThrow(/agentLoginWatch.intervalMinutes must be an integer > 0/);
  });
});

describe('resolveAgentLoginWatchWorkerConfig', () => {
  it('defaults to the standard interval when the block is absent', () => {
    const resolved = resolveAgentLoginWatchWorkerConfig({} as never);
    expect(resolved.intervalMs).toBe(DEFAULT_AGENT_LOGIN_WATCH_INTERVAL_MINUTES * 60_000);
  });

  it('resolves a configured intervalMinutes to milliseconds', () => {
    const resolved = resolveAgentLoginWatchWorkerConfig({
      agentLoginWatch: { intervalMinutes: 5 },
    } as never);
    expect(resolved.intervalMs).toBe(5 * 60_000);
  });
});
