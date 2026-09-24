import { describe, expect, it, vi } from 'vitest';

import type { AgentLoginSessionStatusView } from '../agent-login-session.js';
import {
  AGENT_LOGIN_SUBCOMMANDS,
  AgentLoginCommandError,
  findHeadlessCommandDefinition,
  formatAgentLoginCommandResult,
  parseAgentLoginCommand,
  runAgentLoginCommand,
  toAgentLoginCommandResult,
  type AgentLoginSessionModule,
} from '../headless-command-registry.js';
import {
  isHeadlessMutatingCommand,
  isHeadlessReadOnlyCommand,
} from '../headless-command-classification.js';

const SECRET_TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

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

function fakeModule(overrides: Partial<AgentLoginSessionModule> = {}): AgentLoginSessionModule {
  return {
    startAgentLogin: vi.fn(async () => view()),
    submitAgentLoginCode: vi.fn(async () => view({ status: 'installed' })),
    getAgentLoginStatus: vi.fn(() => view({ status: 'awaiting_code' })),
    ...overrides,
  };
}

describe('agent-login headless command registration', () => {
  it('registers agent-login as an owner-delegated mutating command', () => {
    expect(findHeadlessCommandDefinition('agent-login')).toEqual({ name: 'agent-login', kind: 'write' });
    expect(isHeadlessMutatingCommand(['agent-login', 'start', 'codex'])).toBe(true);
    expect(isHeadlessReadOnlyCommand(['agent-login', 'status', 'als-1'])).toBe(false);
  });

  it('exposes exactly the three documented subcommands', () => {
    expect([...AGENT_LOGIN_SUBCOMMANDS]).toEqual(['start', 'code', 'status']);
  });
});

describe('agent-login argument validation', () => {
  it('requires a subcommand', () => {
    expect(() => parseAgentLoginCommand([])).toThrow(AgentLoginCommandError);
    expect(() => parseAgentLoginCommand([])).toThrow(/requires a subcommand/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => parseAgentLoginCommand(['logout'])).toThrow(/Unknown agent-login subcommand "logout"/);
  });

  it('rejects an unknown provider and a missing provider', () => {
    expect(() => parseAgentLoginCommand(['start', 'gemini'])).toThrow(/Unknown agent-login provider "gemini"/);
    expect(() => parseAgentLoginCommand(['start'])).toThrow(/requires a provider/);
  });

  it('accepts both supported providers', () => {
    expect(parseAgentLoginCommand(['start', 'claude'])).toEqual({
      subcommand: 'start',
      provider: 'claude',
      output: 'text',
    });
    expect(parseAgentLoginCommand(['start', 'codex', '--output', 'json'])).toEqual({
      subcommand: 'start',
      provider: 'codex',
      output: 'json',
    });
    expect(parseAgentLoginCommand(['start', 'codex', '--host', 'do1'])).toEqual({
      subcommand: 'start',
      provider: 'codex',
      output: 'text',
      host: 'do1',
    });
  });

  it('requires a session id and a code for the code subcommand', () => {
    expect(() => parseAgentLoginCommand(['code'])).toThrow(/requires a session id/);
    expect(() => parseAgentLoginCommand(['code', 'als-1'])).toThrow(/requires a login code/);
    expect(parseAgentLoginCommand(['code', 'als-1', 'ABCD-EFGH'])).toEqual({
      subcommand: 'code',
      sessionId: 'als-1',
      code: 'ABCD-EFGH',
      output: 'text',
    });
  });

  it('requires a session id for the status subcommand', () => {
    expect(() => parseAgentLoginCommand(['status'])).toThrow(/requires a session id/);
    expect(parseAgentLoginCommand(['status', 'als-1'])).toEqual({
      subcommand: 'status',
      sessionId: 'als-1',
      output: 'text',
    });
  });

  it('rejects extra positional arguments and unknown options', () => {
    expect(() => parseAgentLoginCommand(['status', 'als-1', 'extra'])).toThrow(/too many arguments/);
    expect(() => parseAgentLoginCommand(['start', 'codex', '--force'])).toThrow(/Unknown agent-login option "--force"/);
    expect(() => parseAgentLoginCommand(['start', 'codex', '--output', 'yaml'])).toThrow(/Invalid --output format/);
    expect(() => parseAgentLoginCommand(['start', 'codex', '--host'])).toThrow(/requires a host/);
    expect(() => parseAgentLoginCommand(['status', 'als-1', '--host', 'do1'])).toThrow(/Unknown agent-login option "--host"/);
  });
});

describe('agent-login command execution', () => {
  it('start calls the session module and returns the typed JSON shape', async () => {
    const loginSessions = fakeModule();
    const result = await runAgentLoginCommand(['start', 'codex'], loginSessions);

    expect(loginSessions.startAgentLogin).toHaveBeenCalledWith('codex');
    expect(result).toEqual({
      sessionId: 'als-1',
      provider: 'codex',
      status: 'awaiting_user',
      url: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      message: expect.stringContaining('https://auth.openai.com/device'),
    });
    expect(Object.keys(JSON.parse(formatAgentLoginCommandResult(result, 'json'))).sort()).toEqual([
      'message',
      'provider',
      'sessionId',
      'status',
      'url',
      'userCode',
    ]);
  });

  it('start forwards the selected host and start dependencies to the session module', async () => {
    const loginSessions = fakeModule();
    const deps = {
      remoteTargets: [
        { name: 'do1', connection: { host: 'do1.example.test', user: 'invoker', sshKeyPath: '/tmp/do1-key' } },
      ],
    };
    const result = await runAgentLoginCommand(['start', 'codex', '--host', 'do1'], loginSessions, deps);

    expect(loginSessions.startAgentLogin).toHaveBeenCalledWith('codex', deps, 'do1');
    expect(result.status).toBe('awaiting_user');
  });

  it('omits url and userCode when the session has neither', async () => {
    const loginSessions = fakeModule({
      startAgentLogin: vi.fn(async () => view({ status: 'starting', loginUrl: undefined, code: undefined })),
    });
    const result = await runAgentLoginCommand(['start', 'claude'], loginSessions);

    expect(result).toEqual({
      sessionId: 'als-1',
      provider: 'codex',
      status: 'starting',
      message: 'Starting codex login.',
    });
    expect(JSON.parse(formatAgentLoginCommandResult(result, 'json'))).not.toHaveProperty('url');
  });

  it('status reads the session without submitting anything', async () => {
    const loginSessions = fakeModule({
      getAgentLoginStatus: vi.fn(() => view({ status: 'installed', loginUrl: undefined, code: undefined })),
    });
    const result = await runAgentLoginCommand(['status', 'als-1'], loginSessions);

    expect(loginSessions.getAgentLoginStatus).toHaveBeenCalledWith('als-1');
    expect(loginSessions.submitAgentLoginCode).not.toHaveBeenCalled();
    expect(result.status).toBe('installed');
  });

  it('code forwards the pasted code to the session module', async () => {
    const loginSessions = fakeModule();
    const result = await runAgentLoginCommand(['code', 'als-1', 'ABCD-EFGH', '--output', 'json'], loginSessions);

    expect(loginSessions.submitAgentLoginCode).toHaveBeenCalledWith('als-1', 'ABCD-EFGH');
    expect(result.status).toBe('installed');
  });

  it('rejects code for an unknown session without submitting it', async () => {
    const loginSessions = fakeModule({
      getAgentLoginStatus: vi.fn(() => {
        throw new Error('Unknown agent login session "nope".');
      }),
    });

    await expect(runAgentLoginCommand(['code', 'nope', 'ABCD-EFGH'], loginSessions))
      .rejects.toThrow(/Unknown agent login session "nope"/);
    expect(loginSessions.submitAgentLoginCode).not.toHaveBeenCalled();
  });

  it('rejects code for an expired session without submitting it', async () => {
    const loginSessions = fakeModule({
      getAgentLoginStatus: vi.fn(() => view({
        status: 'failed',
        error: 'Agent login session expired after 15 minutes.',
        loginUrl: undefined,
        code: undefined,
      })),
    });

    await expect(runAgentLoginCommand(['code', 'als-1', 'ABCD-EFGH'], loginSessions))
      .rejects.toThrow(/is not awaiting a code \(status: failed\)/);
    expect(loginSessions.submitAgentLoginCode).not.toHaveBeenCalled();
  });

  it('rejects status for an unknown session', async () => {
    const loginSessions = fakeModule({
      getAgentLoginStatus: vi.fn(() => {
        throw new Error('Unknown agent login session "nope".');
      }),
    });

    await expect(runAgentLoginCommand(['status', 'nope'], loginSessions)).rejects.toThrow(AgentLoginCommandError);
  });

  it('reports a failed login as data, naming the untouched live login', async () => {
    const loginSessions = fakeModule({
      submitAgentLoginCode: vi.fn(async () => view({
        provider: 'claude',
        status: 'failed',
        error: 'Claude login probe failed',
        loginUrl: undefined,
        code: undefined,
      })),
    });
    const result = await runAgentLoginCommand(['code', 'als-1', 'ABCD-EFGH'], loginSessions);

    expect(result.status).toBe('failed');
    expect(result.message).toContain('Claude login probe failed');
    expect(result.message).toContain('left untouched');
  });
});

describe('agent-login output never leaks a token', () => {
  it('drops any extra field the session view carries, including a token', async () => {
    const leakyView = {
      ...view({ status: 'installed' }),
      token: SECRET_TOKEN,
      authJson: '{"OPENAI_API_KEY":"sk-secret"}',
    } as AgentLoginSessionStatusView;
    const loginSessions = fakeModule({ submitAgentLoginCode: vi.fn(async () => leakyView) });

    const result = await runAgentLoginCommand(['code', 'als-1', 'ABCD-EFGH'], loginSessions);
    const rendered = [
      JSON.stringify(result),
      formatAgentLoginCommandResult(result, 'json'),
      formatAgentLoginCommandResult(result, 'text'),
    ].join('\n');

    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('authJson');
    expect(rendered).not.toContain(SECRET_TOKEN);
    expect(rendered).not.toContain('sk-ant-oat');
    expect(rendered).not.toContain('OPENAI_API_KEY');
  });

  it('keeps a token out of the message even when the session error quotes one', () => {
    const result = toAgentLoginCommandResult(view({
      status: 'failed',
      error: 'probe failed',
      loginUrl: undefined,
      code: undefined,
    }));

    expect(formatAgentLoginCommandResult(result, 'text')).not.toContain('sk-ant-oat');
    expect(result.message).toBe(
      'The codex login failed: probe failed. The live login was left untouched.',
    );
  });
});
