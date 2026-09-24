import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_AGENT_LOGIN_SESSION_TTL_MS,
  getAgentLoginStatus,
  parseClaudeOauthToken,
  parseCodexDeviceAuthOutput,
  parseLoginUrl,
  startAgentLogin,
  stripAnsiColorCodes,
  submitAgentLoginCode,
  type AgentLoginSessionDependencies,
} from '../agent-login-session.js';

const CODEX_HAPPY_SCRIPT = [
  '#!/bin/bash',
  'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
  '  echo "To authenticate, visit: https://example.test/device"',
  '  echo "Enter code: ABCD-1234"',
  '  sleep 0.1',
  '  printf \'{"tokens":{"access_token":"fake-codex-access-token-xyz"}}\' > "$CODEX_HOME/auth.json"',
  '  exit 0',
  'fi',
  'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
  '  if [ -s "$CODEX_HOME/auth.json" ]; then exit 0; fi',
  '  exit 1',
  'fi',
  'exit 1',
  '',
].join('\n');

const CODEX_PROBE_FAILS_SCRIPT = [
  '#!/bin/bash',
  'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
  '  echo "To authenticate, visit: https://example.test/device"',
  '  echo "Enter code: WXYZ-9876"',
  '  sleep 0.1',
  '  printf \'{"tokens":{"access_token":"should-never-be-installed"}}\' > "$CODEX_HOME/auth.json"',
  '  exit 0',
  'fi',
  'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
  '  exit 1',
  'fi',
  'exit 1',
  '',
].join('\n');

const CLAUDE_HAPPY_SCRIPT = [
  '#!/bin/bash',
  'if [ "$1" = "setup-token" ]; then',
  '  echo "Visit this URL to authorize: https://example.test/oauth/authorize?req=demo"',
  '  read -r CODE',
  '  if [ "$CODE" = "GOODCODE" ]; then',
  '    echo "Your Claude Code OAuth token: sk-ant-oat01-abcdefghijklmnop"',
  '  else',
  '    echo "Invalid code."',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "$1" = "-p" ]; then',
  '  if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "sk-ant-oat01-abcdefghijklmnop" ]; then echo ok; exit 0; fi',
  '  exit 1',
  'fi',
  'exit 1',
  '',
].join('\n');

const CLAUDE_PROBE_FAILS_SCRIPT = [
  '#!/bin/bash',
  'if [ "$1" = "setup-token" ]; then',
  '  echo "Visit this URL to authorize: https://example.test/oauth/authorize?req=demo"',
  '  read -r CODE',
  '  if [ "$CODE" = "GOODCODE" ]; then',
  '    echo "Your Claude Code OAuth token: sk-ant-oat01-shouldneverinstall"',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "$1" = "-p" ]; then',
  '  exit 1',
  'fi',
  'exit 1',
  '',
].join('\n');

function createFakeBin(name: 'codex' | 'claude', script: string): string {
  const dir = mkdtempSync(join(tmpdir(), `invoker-agent-login-test-bin-`));
  writeFileSync(join(dir, name), script, { mode: 0o755 });
  return dir;
}

function createFakeBinWithFiles(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), `invoker-agent-login-test-bin-`));
  for (const [name, script] of Object.entries(files)) {
    writeFileSync(join(dir, name), script, { mode: 0o755 });
  }
  return dir;
}

function createSilentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
}

function allLoggedText(logger: ReturnType<typeof createSilentLogger>): string {
  const calls = [...logger.debug.mock.calls, ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls];
  return calls.map((call) => JSON.stringify(call)).join('\n');
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function hashFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('agent-login-session boundary parsers', () => {
  it('strips ANSI colour codes', () => {
    const coloured = '\x1b[32mhello\x1b[0m \x1b[1mworld\x1b[0m';
    expect(stripAnsiColorCodes(coloured)).toBe('hello world');
  });

  it('parses the codex device-auth URL and one-time code out of coloured output', () => {
    const raw = '\x1b[1mVisit:\x1b[0m https://example.test/device\nEnter code: \x1b[33mABCD-1234\x1b[0m\n';
    expect(parseCodexDeviceAuthOutput(raw)).toEqual({ url: 'https://example.test/device', code: 'ABCD-1234' });
  });

  it('returns null when the device-auth output has no code yet', () => {
    expect(parseCodexDeviceAuthOutput('Visit: https://example.test/device\n')).toBeNull();
  });

  it('parses a login URL out of coloured claude setup-token output', () => {
    const raw = '\x1b[2mVisit this URL to authorize:\x1b[0m https://example.test/oauth/authorize?req=demo\n';
    expect(parseLoginUrl(raw)).toBe('https://example.test/oauth/authorize?req=demo');
  });

  it('parses a claude oauth token out of coloured output', () => {
    const raw = 'Your Claude Code OAuth token: \x1b[32msk-ant-oat01-abcdefghijklmnop\x1b[0m\n';
    expect(parseClaudeOauthToken(raw)).toBe('sk-ant-oat01-abcdefghijklmnop');
  });

  it('returns null when no token is present', () => {
    expect(parseClaudeOauthToken('still waiting for the code...\n')).toBeNull();
  });
});

describe('agent-login-session session lifecycle errors', () => {
  it('throws for an unknown session id', () => {
    expect(() => getAgentLoginStatus('does-not-exist')).toThrow(/Unknown agent login session/);
  });

  it('rejects submitAgentLoginCode for a codex session', async () => {
    let currentTime = 1_000;
    const deps: AgentLoginSessionDependencies = {
      now: () => currentTime,
      spawnFn: () => {
        const listeners: Record<string, (arg: unknown) => void> = {};
        return {
          stdout: {
            on: (_event, cb) => {
              cb('To authenticate, visit: https://example.test/device\nEnter code: ABCD-1234\n');
            },
          },
          stderr: { on: () => {} },
          once: (event, cb) => {
            listeners[event] = cb as (arg: unknown) => void;
          },
          kill: () => {},
        };
      },
    };
    const view = await startAgentLogin('codex', deps);
    expect(view.status).toBe('awaiting_user');
    await expect(submitAgentLoginCode(view.sessionId, '000000', deps)).rejects.toThrow(/not awaiting a code/);
  });

  it('expires a session after its TTL and marks it failed', async () => {
    let currentTime = 5_000;
    const deps: AgentLoginSessionDependencies = {
      now: () => currentTime,
      sessionTtlMs: 100,
      spawnFn: () => ({
        stdout: {
          on: (_event, cb) => {
            cb('To authenticate, visit: https://example.test/device\nEnter code: ABCD-1234\n');
          },
        },
        stderr: { on: () => {} },
        once: () => {},
        kill: () => {},
      }),
    };
    const view = await startAgentLogin('codex', deps);
    expect(view.status).toBe('awaiting_user');
    expect(view.expiresAt - view.createdAt).toBe(100);

    currentTime += 200;
    const later = getAgentLoginStatus(view.sessionId, deps);
    expect(later.status).toBe('failed');
    expect(later.error).toMatch(/expired/i);
  });

  it('fails the session when the login CLI never prints a URL in time', async () => {
    const deps: AgentLoginSessionDependencies = {
      parseTimeoutMs: 20,
      spawnFn: () => ({
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        once: () => {},
        kill: () => {},
      }),
    };
    const view = await startAgentLogin('codex', deps);
    expect(view.status).toBe('failed');
    expect(view.error).toMatch(/did not print/);
  });
});

describe('agent-login-session codex flow on a named SSH host', () => {
  let fakeBinDir: string;
  let remoteRoot: string;
  let sshLogPath: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'invoker-agent-login-remote-root-'));
    sshLogPath = join(remoteRoot, 'ssh.log');
    originalPath = process.env.PATH;
    process.env.FAKE_REMOTE_ROOT = remoteRoot;
    process.env.FAKE_SSH_LOG = sshLogPath;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.FAKE_REMOTE_ROOT;
    delete process.env.FAKE_SSH_LOG;
    if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  });

  const fakeSshScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    'target=""',
    'for arg in "$@"; do',
    '  case "$arg" in *@*) target="$arg" ;; esac',
    'done',
    'printf "%s\\n" "$target" >> "$FAKE_SSH_LOG"',
    'remote_root="$FAKE_REMOTE_ROOT/$target"',
    'mkdir -p "$remote_root/home"',
    'export FAKE_SSH_TARGET="$target"',
    'export HOME="$remote_root/home"',
    'cd "$remote_root"',
    'bash -s',
    '',
  ].join('\n');

  function remoteHome(target: string): string {
    return join(remoteRoot, target, 'home');
  }

  it('runs login and probe on the named host with a remote throwaway CODEX_HOME, then installs there only', async () => {
    const codexScript = [
      '#!/bin/bash',
      'set -euo pipefail',
      'printf "%s|%s|%s\\n" "$FAKE_SSH_TARGET" "$1 $2 ${3:-}" "$CODEX_HOME" >> "$FAKE_REMOTE_ROOT/codex.log"',
      'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
      '  echo "To authenticate, visit: https://example.test/device"',
      '  echo "Enter code: ABCD-1234"',
      '  printf \'{"tokens":{"access_token":"remote-codex-token"}}\' > "$CODEX_HOME/auth.json"',
      '  exit 0',
      'fi',
      'if [ "$1" = "exec" ]; then',
      '  [ "$2" = "--skip-git-repo-check" ]',
      '  [ "$3" = "Reply with just the word ok" ]',
      '  [ -s "$CODEX_HOME/auth.json" ]',
      '  echo ok',
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n');
    fakeBinDir = createFakeBinWithFiles({ ssh: fakeSshScript, codex: codexScript });
    process.env.PATH = `${fakeBinDir}:${originalPath}`;

    const primaryHome = remoteHome('invoker@primary.example.test');
    const otherHome = remoteHome('invoker@other.example.test');
    mkdirSync(join(primaryHome, '.codex'), { recursive: true });
    mkdirSync(join(otherHome, '.codex'), { recursive: true });
    const primaryAuth = join(primaryHome, '.codex', 'auth.json');
    const otherAuth = join(otherHome, '.codex', 'auth.json');
    writeFileSync(primaryAuth, '{"tokens":{"access_token":"old-primary"}}');
    writeFileSync(otherAuth, '{"tokens":{"access_token":"old-other"}}');

    const deps: AgentLoginSessionDependencies = {
      logger: createSilentLogger(),
      remoteTargets: [
        { name: 'primary', connection: { host: 'primary.example.test', user: 'invoker', sshKeyPath: '/tmp/primary-key' } },
        { name: 'other', connection: { host: 'other.example.test', user: 'invoker', sshKeyPath: '/tmp/other-key' } },
      ],
    };

    const started = await startAgentLogin('codex', deps, { host: 'primary' });
    expect(started.status).toBe('awaiting_user');
    expect(started.loginUrl).toBe('https://example.test/device');
    expect(started.code).toBe('ABCD-1234');

    await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'installed');
    expect(readFileSync(primaryAuth, 'utf8')).toBe('{"tokens":{"access_token":"remote-codex-token"}}');
    expect(statSync(primaryAuth).mode & 0o777).toBe(0o600);
    expect(readFileSync(otherAuth, 'utf8')).toBe('{"tokens":{"access_token":"old-other"}}');

    const sshTargets = readFileSync(sshLogPath, 'utf8').trim().split('\n');
    expect(sshTargets).toEqual(['invoker@primary.example.test', 'invoker@primary.example.test', 'invoker@primary.example.test']);

    const codexCalls = readFileSync(join(remoteRoot, 'codex.log'), 'utf8').trim().split('\n');
    expect(codexCalls).toHaveLength(2);
    expect(codexCalls[0]).toMatch(/^invoker@primary.example.test\|login --device-auth \|\/tmp\//);
    expect(codexCalls[1]).toMatch(/^invoker@primary.example.test\|exec --skip-git-repo-check Reply with just the word ok\|\/tmp\//);
    expect(codexCalls[1].split('|')[2]).toBe(codexCalls[0].split('|')[2]);
    expect(existsSync(codexCalls[0].split('|')[2])).toBe(false);
  }, 20_000);

  it('leaves the remote live auth untouched when the named host test call fails', async () => {
    const codexScript = [
      '#!/bin/bash',
      'set -euo pipefail',
      'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
      '  echo "To authenticate, visit: https://example.test/device"',
      '  echo "Enter code: WXYZ-9876"',
      '  printf \'{"tokens":{"access_token":"should-never-install-remote"}}\' > "$CODEX_HOME/auth.json"',
      '  exit 0',
      'fi',
      'if [ "$1" = "exec" ]; then',
      '  exit 1',
      'fi',
      'exit 1',
      '',
    ].join('\n');
    fakeBinDir = createFakeBinWithFiles({ ssh: fakeSshScript, codex: codexScript });
    process.env.PATH = `${fakeBinDir}:${originalPath}`;

    const primaryHome = remoteHome('invoker@primary.example.test');
    mkdirSync(join(primaryHome, '.codex'), { recursive: true });
    const primaryAuth = join(primaryHome, '.codex', 'auth.json');
    writeFileSync(primaryAuth, '{"tokens":{"access_token":"old-primary"}}');
    const beforeHash = hashFile(primaryAuth);

    const deps: AgentLoginSessionDependencies = {
      logger: createSilentLogger(),
      remoteTargets: [
        { name: 'primary', connection: { host: 'primary.example.test', user: 'invoker', sshKeyPath: '/tmp/primary-key' } },
        { name: 'other', connection: { host: 'other.example.test', user: 'invoker', sshKeyPath: '/tmp/other-key' } },
      ],
    };

    const started = await startAgentLogin('codex', deps, { host: 'primary' });
    expect(started.status).toBe('awaiting_user');

    await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'failed');
    const final = getAgentLoginStatus(started.sessionId, deps);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/probe failed/i);
    expect(hashFile(primaryAuth)).toBe(beforeHash);
    expect(readFileSync(sshLogPath, 'utf8').trim().split('\n')).toEqual([
      'invoker@primary.example.test',
      'invoker@primary.example.test',
      'invoker@primary.example.test',
    ]);
  }, 20_000);
});

describe('agent-login-session codex flow (real fake-codex executable on PATH)', () => {
  let fakeBinDir: string;
  let homeDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'invoker-agent-login-home-'));
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports the device URL/code, then installs the new login only after a passing probe, backs up the old login, and copies it to remote targets', async () => {
    fakeBinDir = createFakeBin('codex', CODEX_HAPPY_SCRIPT);
    process.env.PATH = `${fakeBinDir}:${originalPath}`;

    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const oldAuthPath = join(codexDir, 'auth.json');
    writeFileSync(oldAuthPath, '{"tokens":{"access_token":"old-live-token"}}');

    const logger = createSilentLogger();
    const distributeCodexFn = vi.fn().mockResolvedValue(undefined);
    const deps: AgentLoginSessionDependencies = {
      logger,
      distributeCodexFn,
      remoteTargets: [
        { name: 'pool-a', connection: { host: 'a.example.test', user: 'invoker', sshKeyPath: '/dev/null' } },
        { name: 'pool-b', connection: { host: 'b.example.test', user: 'invoker', sshKeyPath: '/dev/null' } },
      ],
    };

    const started = await startAgentLogin('codex', deps);
    expect(started.status).toBe('awaiting_user');
    expect(started.loginUrl).toBe('https://example.test/device');
    expect(started.code).toBe('ABCD-1234');

    await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'installed');
    const final = getAgentLoginStatus(started.sessionId, deps);
    expect(final.status).toBe('installed');

    const installedContents = readFileSync(oldAuthPath, 'utf8');
    expect(installedContents).toBe('{"tokens":{"access_token":"fake-codex-access-token-xyz"}}');

    const backups = readdirSync(codexDir).filter((name) => name.startsWith('auth.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(codexDir, backups[0]), 'utf8')).toBe('{"tokens":{"access_token":"old-live-token"}}');

    expect(distributeCodexFn).toHaveBeenCalledTimes(2);
    expect(distributeCodexFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pool-a' }),
      '{"tokens":{"access_token":"fake-codex-access-token-xyz"}}',
    );
    expect(distributeCodexFn).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pool-b' }),
      '{"tokens":{"access_token":"fake-codex-access-token-xyz"}}',
    );

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('fake-codex-access-token-xyz');
    expect(logged).not.toContain('old-live-token');
  }, 20_000);

  it('leaves the live codex auth.json byte-identical when the post-login probe fails', async () => {
    fakeBinDir = createFakeBin('codex', CODEX_PROBE_FAILS_SCRIPT);
    process.env.PATH = `${fakeBinDir}:${originalPath}`;

    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, 'auth.json');
    writeFileSync(authPath, '{"tokens":{"access_token":"untouched-live-token"}}');
    const beforeHash = hashFile(authPath);

    const secretsPath = join(homeDir, '.config', 'invoker', 'secrets.env');
    mkdirSync(join(homeDir, '.config', 'invoker'), { recursive: true });
    writeFileSync(secretsPath, 'OTHER_KEY=unrelated\n');
    const beforeSecretsHash = hashFile(secretsPath);

    const logger = createSilentLogger();
    const deps: AgentLoginSessionDependencies = { logger };

    const started = await startAgentLogin('codex', deps);
    expect(started.status).toBe('awaiting_user');

    await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'failed');
    const final = getAgentLoginStatus(started.sessionId, deps);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/probe failed/i);

    expect(hashFile(authPath)).toBe(beforeHash);
    expect(hashFile(secretsPath)).toBe(beforeSecretsHash);
    expect(readdirSync(codexDir).some((name) => name.startsWith('auth.json.bak-'))).toBe(false);

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('should-never-be-installed');
  }, 20_000);
});

describe('agent-login-session claude flow (real fake-claude executable under a real pty on PATH)', () => {
  let fakeBinDir: string;
  let homeDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'invoker-agent-login-home-'));
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('reports the login URL, then only installs the token after a passing probe and backs up the old secrets file', async () => {
    fakeBinDir = createFakeBin('claude', CLAUDE_HAPPY_SCRIPT);
    process.env.PATH = `${fakeBinDir}:${originalPath}`;

    const secretsDir = join(homeDir, '.config', 'invoker');
    mkdirSync(secretsDir, { recursive: true });
    const secretsPath = join(secretsDir, 'secrets.env');
    writeFileSync(secretsPath, 'SOME_OTHER_KEY=keep-me\n');

    const logger = createSilentLogger();
    const deps: AgentLoginSessionDependencies = { logger };

    const started = await startAgentLogin('claude', deps);
    expect(started.status).toBe('awaiting_code');
    expect(started.loginUrl).toBe('https://example.test/oauth/authorize?req=demo');

    const final = await submitAgentLoginCode(started.sessionId, 'GOODCODE', deps);
    expect(final.status).toBe('installed');

    const secretsContents = readFileSync(secretsPath, 'utf8');
    expect(secretsContents).toContain('SOME_OTHER_KEY=keep-me');
    expect(secretsContents).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abcdefghijklmnop');
    expect(statSync(secretsPath).mode & 0o777).toBe(0o600);

    const backups = readdirSync(secretsDir).filter((name) => name.startsWith('secrets.env.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(secretsDir, backups[0]), 'utf8')).toBe('SOME_OTHER_KEY=keep-me\n');

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('sk-ant-oat01-abcdefghijklmnop');
  }, 20_000);

  it('leaves the secrets file byte-identical when the post-code probe fails', async () => {
    fakeBinDir = createFakeBin('claude', CLAUDE_PROBE_FAILS_SCRIPT);
    process.env.PATH = `${fakeBinDir}:${originalPath}`;

    const secretsDir = join(homeDir, '.config', 'invoker');
    mkdirSync(secretsDir, { recursive: true });
    const secretsPath = join(secretsDir, 'secrets.env');
    writeFileSync(secretsPath, 'CLAUDE_CODE_OAUTH_TOKEN=old-live-token\n');
    const beforeSecretsHash = hashFile(secretsPath);

    const codexAuthPath = join(homeDir, '.codex', 'auth.json');
    mkdirSync(join(homeDir, '.codex'), { recursive: true });
    writeFileSync(codexAuthPath, '{"tokens":{"access_token":"untouched-codex-token"}}');
    const beforeCodexHash = hashFile(codexAuthPath);

    const logger = createSilentLogger();
    const deps: AgentLoginSessionDependencies = { logger };

    const started = await startAgentLogin('claude', deps);
    expect(started.status).toBe('awaiting_code');

    const final = await submitAgentLoginCode(started.sessionId, 'GOODCODE', deps);
    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/probe failed/i);

    expect(hashFile(secretsPath)).toBe(beforeSecretsHash);
    expect(hashFile(codexAuthPath)).toBe(beforeCodexHash);
    expect(readdirSync(secretsDir).some((name) => name.startsWith('secrets.env.bak-'))).toBe(false);

    const logged = allLoggedText(logger);
    expect(logged).not.toContain('shouldneverinstall');
  }, 20_000);
});

describe('agent-login-session TTL constant', () => {
  it('defaults to 15 minutes', () => {
    expect(DEFAULT_AGENT_LOGIN_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });
});
