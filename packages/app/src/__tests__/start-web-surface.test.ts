import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveWebToken,
  resolveWebHost,
  resolveWebPort,
  startHeadlessWebSurface,
} from '../web/start-web-surface.js';

const ENV_KEYS = ['INVOKER_WEB_TOKEN', 'INVOKER_WEB_HOST', 'INVOKER_WEB_PORT'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('web surface configuration resolution', () => {
  it('prefers env token over config and is undefined when neither is set', () => {
    expect(resolveWebToken({})).toBeUndefined();
    expect(resolveWebToken({ webToken: 'cfg' })).toBe('cfg');
    process.env.INVOKER_WEB_TOKEN = 'env';
    expect(resolveWebToken({ webToken: 'cfg' })).toBe('env');
  });

  it('resolves host/port with env precedence and sane defaults', () => {
    expect(resolveWebHost({})).toBe('127.0.0.1');
    expect(resolveWebHost({ webHost: '0.0.0.0' })).toBe('0.0.0.0');
    process.env.INVOKER_WEB_HOST = '10.0.0.1';
    expect(resolveWebHost({ webHost: '0.0.0.0' })).toBe('10.0.0.1');

    expect(resolveWebPort({})).toBe(4200);
    expect(resolveWebPort({ webPort: 5000 })).toBe(5000);
    process.env.INVOKER_WEB_PORT = '6000';
    expect(resolveWebPort({ webPort: 5000 })).toBe(6000);
  });
});

describe('startHeadlessWebSurface token gate', () => {
  it('returns null and starts no server when no token is configured', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const subscribe = vi.fn();
    const result = startHeadlessWebSurface({
      logger: logger as never,
      orchestrator: {} as never,
      persistence: {} as never,
      messageBus: { subscribe } as never,
      agentRegistry: {} as never,
      mutations: {} as never,
      deleteWorkflow: vi.fn(),
      detachWorkflow: vi.fn(),
      loadConfig: () => ({}),
      config: {},
      appRootDir: '/tmp',
    });
    expect(result).toBeNull();
    // No token => no task.delta subscription, no server wiring.
    expect(subscribe).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });
});
