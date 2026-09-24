import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentLoginSessionStatusView } from '../agent-login-session.js';
import { runHeadless, type HeadlessDeps } from '../headless.js';

const startAgentLogin = vi.fn();
const submitAgentLoginCode = vi.fn();
const getAgentLoginStatus = vi.fn();

vi.mock('../agent-login-session.js', () => ({
  startAgentLogin: (...args: unknown[]) => startAgentLogin(...args),
  submitAgentLoginCode: (...args: unknown[]) => submitAgentLoginCode(...args),
  getAgentLoginStatus: (...args: unknown[]) => getAgentLoginStatus(...args),
}));

function view(overrides: Partial<AgentLoginSessionStatusView> = {}): AgentLoginSessionStatusView {
  return {
    sessionId: 'als-1',
    provider: 'codex',
    status: 'awaiting_user',
    loginUrl: 'https://auth.openai.com/device',
    code: 'ABCD-EFGH',
    createdAt: 1_000,
    updatedAt: 1_000,
    expiresAt: 901_000,
    ...overrides,
  };
}

function captureStdout() {
  let stdout = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  return {
    get text() { return stdout; },
    restore() { spy.mockRestore(); },
  };
}

const deps = {} as HeadlessDeps;

describe('runHeadless agent-login dispatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    startAgentLogin.mockReset();
    submitAgentLoginCode.mockReset();
    getAgentLoginStatus.mockReset();
  });

  it('routes agent-login start to the login session module and returns the typed result', async () => {
    startAgentLogin.mockResolvedValue(view());
    const stdout = captureStdout();

    const result = await runHeadless(['agent-login', 'start', 'codex'], deps);
    stdout.restore();

    expect(startAgentLogin).toHaveBeenCalledWith('codex');
    expect(result).toEqual({
      sessionId: 'als-1',
      provider: 'codex',
      status: 'awaiting_user',
      url: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      message: 'Open https://auth.openai.com/device and approve the codex login.',
    });
    expect(stdout.text).toContain('session als-1 (codex): awaiting_user');
    expect(stdout.text).toContain('url: https://auth.openai.com/device');
  });

  it('routes agent-login start --host with remote targets from config', async () => {
    startAgentLogin.mockResolvedValue(view());
    const stdout = captureStdout();
    const result = await runHeadless(['agent-login', 'start', 'codex', '--host', 'do1'], {
      invokerConfig: {
        remoteTargets: {
          do1: { host: '203.0.113.10', user: 'invoker', sshKeyPath: '/tmp/do1-key', port: 2222 },
          do2: { host: '203.0.113.11', user: 'invoker', sshKeyPath: '/tmp/do2-key' },
        },
      },
    } as HeadlessDeps);
    stdout.restore();

    expect(startAgentLogin).toHaveBeenCalledWith('codex', {
      remoteTargets: [
        { name: 'do1', connection: { host: '203.0.113.10', user: 'invoker', sshKeyPath: '/tmp/do1-key', port: 2222 } },
        { name: 'do2', connection: { host: '203.0.113.11', user: 'invoker', sshKeyPath: '/tmp/do2-key', port: undefined } },
      ],
    }, 'do1');
    expect(result.status).toBe('awaiting_user');
  });

  it('routes agent-login code through the waiting session', async () => {
    getAgentLoginStatus.mockReturnValue(view({ status: 'awaiting_code' }));
    submitAgentLoginCode.mockResolvedValue(view({ status: 'installed', loginUrl: undefined, code: undefined }));
    const stdout = captureStdout();

    const result = await runHeadless(['agent-login', 'code', 'als-1', 'ABCD-EFGH'], deps);
    stdout.restore();

    expect(submitAgentLoginCode).toHaveBeenCalledWith('als-1', 'ABCD-EFGH');
    expect(result).toMatchObject({ sessionId: 'als-1', status: 'installed' });
  });

  it('prints the json shape when --output json is passed', async () => {
    getAgentLoginStatus.mockReturnValue(view({ status: 'awaiting_code' }));
    const stdout = captureStdout();

    await runHeadless(['agent-login', 'status', 'als-1', '--output', 'json'], deps);
    stdout.restore();

    expect(JSON.parse(stdout.text)).toEqual({
      sessionId: 'als-1',
      provider: 'codex',
      status: 'awaiting_code',
      url: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      message: 'Open https://auth.openai.com/device, then send the code back with "agent-login code als-1 <code>".',
    });
  });

  it('rejects an unknown subcommand instead of falling through to the unknown-command error', async () => {
    await expect(runHeadless(['agent-login', 'bogus'], deps)).rejects.toThrow(/Unknown agent-login subcommand/);
  });
});
