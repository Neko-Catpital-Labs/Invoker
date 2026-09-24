import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';

function captureProcessOutput() {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    stderr += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    restore() {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

function ownerBus(execHandler: (request: unknown) => Promise<unknown>): LocalBus {
  const bus = new LocalBus();
  bus.onRequest('headless.owner-ping', async () => ({ ok: true, ownerId: 'owner-1', mode: 'gui' }));
  bus.onRequest('headless.exec', execHandler);
  return bus;
}

const STARTED = {
  sessionId: 'als-1',
  provider: 'codex',
  status: 'awaiting_user',
  url: 'https://auth.openai.com/device',
  userCode: 'ABCD-EFGH',
  message: 'Open https://auth.openai.com/device and approve the codex login.',
  ok: true,
};

describe('invoker-cli agent-login', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates the subcommand to the live owner and prints the login url and code', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ args: ['agent-login', 'start', 'codex'], noTrack: true });
      return STARTED;
    });

    const code = await main(['agent-login', 'start', 'codex'], { createMessageBus: () => ownerBus(execHandler) });
    output.restore();

    expect(code).toBe(0);
    expect(execHandler).toHaveBeenCalledTimes(1);
    expect(output.stdout).toContain('session als-1 (codex): awaiting_user');
    expect(output.stdout).toContain('url: https://auth.openai.com/device');
    expect(output.stdout).toContain('code: ABCD-EFGH');
  });

  it('forwards the code subcommand and prints the installed status', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async (request: unknown) => {
      expect(request).toEqual({ args: ['agent-login', 'code', 'als-1', 'ABCD-EFGH'], noTrack: true });
      return {
        sessionId: 'als-1',
        provider: 'codex',
        status: 'installed',
        message: 'The new codex login passed its test call and is installed.',
        ok: true,
      };
    });

    const code = await main(['agent-login', 'code', 'als-1', 'ABCD-EFGH'], { createMessageBus: () => ownerBus(execHandler) });
    output.restore();

    expect(code).toBe(0);
    expect(output.stdout).toContain('session als-1 (codex): installed');
    expect(output.stdout).not.toContain('url:');
  });

  it('prints the typed json object without the delegation ok flag', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => STARTED);

    const code = await main(['agent-login', 'start', 'codex', '--output', 'json'], {
      createMessageBus: () => ownerBus(execHandler),
    });
    output.restore();

    expect(code).toBe(0);
    expect(JSON.parse(output.stdout)).toEqual({
      sessionId: 'als-1',
      provider: 'codex',
      status: 'awaiting_user',
      url: 'https://auth.openai.com/device',
      userCode: 'ABCD-EFGH',
      message: 'Open https://auth.openai.com/device and approve the codex login.',
    });
  });

  it('rejects an invalid --output format before contacting the owner', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => STARTED);

    const code = await main(['agent-login', 'status', 'als-1', '--output', 'yaml'], {
      createMessageBus: () => ownerBus(execHandler),
    });
    output.restore();

    expect(code).toBe(1);
    expect(execHandler).not.toHaveBeenCalled();
    expect(output.stderr).toContain('Must be text|json');
  });

  it('requires a subcommand', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => STARTED);

    const code = await main(['agent-login'], { createMessageBus: () => ownerBus(execHandler) });
    output.restore();

    expect(code).toBe(1);
    expect(execHandler).not.toHaveBeenCalled();
    expect(output.stderr).toContain('Usage: invoker-cli agent-login');
  });

  it('drops any extra field the owner response carries, including a token', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => ({
      ...STARTED,
      token: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789',
      authJson: '{"OPENAI_API_KEY":"sk-secret"}',
    }));

    const code = await main(['agent-login', 'start', 'codex', '--output', 'json'], {
      createMessageBus: () => ownerBus(execHandler),
    });
    output.restore();

    expect(code).toBe(0);
    expect(output.stdout).not.toContain('sk-ant-oat');
    expect(output.stdout).not.toContain('OPENAI_API_KEY');
    expect(Object.keys(JSON.parse(output.stdout)).sort()).toEqual(
      ['message', 'provider', 'sessionId', 'status', 'url', 'userCode'],
    );
  });

  it('refuses to guess when the owner returns a response it cannot read', async () => {
    const output = captureProcessOutput();
    const execHandler = vi.fn(async () => ({ ok: true }));

    const code = await main(['agent-login', 'status', 'als-1'], { createMessageBus: () => ownerBus(execHandler) });
    output.restore();

    expect(code).toBe(1);
    expect(output.stderr).toContain('missing sessionId string');
  });
});
