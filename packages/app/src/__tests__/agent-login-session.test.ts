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

const REMOTE_CODEX_SCRIPT = [
  '#!/bin/bash',
  'printf "%s\\t%s\\t%s\\n" "$REMOTE_TEST_HOST" "$*" "${CODEX_HOME:-}" >> "$REMOTE_CODEX_LOG"',
  'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
  '  echo "To authenticate, visit: https://example.test/remote-device"',
  '  echo "Enter code: REMO-1234"',
  '  sleep 0.1',
  '  mkdir -p "$CODEX_HOME"',
  '  printf "{\\"tokens\\":{\\"access_token\\":\\"remote-token-%s\\"}}" "$REMOTE_TEST_HOST" > "$CODEX_HOME/auth.json"',
  '  exit 0',
  'fi',
  'if [ "$1" = "exec" ] && [ "$2" = "--skip-git-repo-check" ]; then',
  '  if [ "${CODEX_PROBE_FAILS:-0}" = "1" ]; then exit 1; fi',
  '  if [ -s "$CODEX_HOME/auth.json" ]; then echo ok; exit 0; fi',
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

function createFakeBin(name: 'codex' | 'claude' | 'ssh', script: string): string {
  const dir = mkdtempSync(join(tmpdir(), `invoker-agent-login-test-bin-`));
  writeFileSync(join(dir, name), script, { mode: 0o755 });
  return dir;
}

function createFakeSshBin(options: {
  logPath: string;
  remoteBinDir: string;
  remoteCodexLog: string;
  hostHomes: Record<string, string>;
  failProbeHost?: string;
}): string {
  const script = [
    '#!/bin/bash',
    'set -euo pipefail',
    'payload="$(cat)"',
    'target=""',
    'for arg in "$@"; do',
    '  case "$arg" in *@*) target="$arg" ;; esac',
    'done',
    'host="${target#*@}"',
    'case "$host" in',
    `  remote-a) remote_home=${JSON.stringify(options.hostHomes['remote-a'] ?? '')} ;;`,
    `  remote-b) remote_home=${JSON.stringify(options.hostHomes['remote-b'] ?? '')} ;;`,
    '  *) echo "unexpected host $host" >&2; exit 88 ;;',
    'esac',
    `printf "host=%s\\nargs=%s\\n%s\\n---\\n" "$host" "$*" "$payload" >> ${JSON.stringify(options.logPath)}`,
    `if [ "$host" = ${JSON.stringify(options.failProbeHost ?? '')} ]; then probe_fails=1; else probe_fails=0; fi`,
    `REMOTE_TEST_HOST="$host" REMOTE_CODEX_LOG=${JSON.stringify(options.remoteCodexLog)} CODEX_PROBE_FAILS="$probe_fails" HOME="$remote_home" PATH=${JSON.stringify(options.remoteBinDir)}":$PATH" bash -s <<< "$payload"`,
    '',
  ].join('\n');
  return createFakeBin('ssh', script);
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

describe('agent-login-session codex remote host flow (real fake-ssh executable on PATH)', () => {
  let sshBinDir: string;
  let remoteBinDir: string;
  let remoteRoot: string;
  let originalPath: string | undefined;

  function remoteTarget(name: string, host: string, key: string) {
    return { name, connection: { host, user: 'invoker', sshKeyPath: key } };
  }

  function readRemoteCodexCalls(logPath: string): Array<{ host: string; args: string; codexHome: string }> {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [host, args, codexHome] = line.split('\t');
        return { host, args, codexHome };
      });
  }

  beforeEach(() => {
    remoteRoot = mkdtempSync(join(tmpdir(), 'invoker-agent-login-remote-'));
    remoteBinDir = createFakeBin('codex', REMOTE_CODEX_SCRIPT);
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (sshBinDir) rmSync(sshBinDir, { recursive: true, force: true });
    if (remoteBinDir) rmSync(remoteBinDir, { recursive: true, force: true });
    rmSync(remoteRoot, { recursive: true, force: true });
  });

  it('runs login and test call on the named host in a throwaway CODEX_HOME before installing there only', async () => {
    const remoteAHome = join(remoteRoot, 'remote-a-home');
    const remoteBHome = join(remoteRoot, 'remote-b-home');
    mkdirSync(join(remoteAHome, '.codex'), { recursive: true });
    mkdirSync(join(remoteBHome, '.codex'), { recursive: true });
    const remoteAAuthPath = join(remoteAHome, '.codex', 'auth.json');
    const remoteBAuthPath = join(remoteBHome, '.codex', 'auth.json');
    writeFileSync(remoteAAuthPath, '{"tokens":{"access_token":"old-remote-a"}}');
    writeFileSync(remoteBAuthPath, '{"tokens":{"access_token":"old-remote-b"}}');

    const sshLogPath = join(remoteRoot, 'ssh.log');
    const remoteCodexLogPath = join(remoteRoot, 'remote-codex.log');
    sshBinDir = createFakeSshBin({
      logPath: sshLogPath,
      remoteBinDir,
      remoteCodexLog: remoteCodexLogPath,
      hostHomes: { 'remote-a': remoteAHome, 'remote-b': remoteBHome },
    });
    process.env.PATH = `${sshBinDir}:${originalPath}`;

    const distributeCodexFn = vi.fn().mockResolvedValue(undefined);
    const deps: AgentLoginSessionDependencies = {
      host: 'do-1',
      remoteTargets: [
        remoteTarget('do-1', 'remote-a', '/tmp/key-a'),
        remoteTarget('do-2', 'remote-b', '/tmp/key-b'),
      ],
      distributeCodexFn,
    };

    const started = await startAgentLogin('codex', deps);
    expect(started.status).toBe('awaiting_user');
    expect(started.loginUrl).toBe('https://example.test/remote-device');
    expect(started.code).toBe('REMO-1234');

    await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'installed');
    expect(readFileSync(remoteAAuthPath, 'utf8')).toBe('{"tokens":{"access_token":"remote-token-remote-a"}}');
    expect(statSync(remoteAAuthPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(remoteBAuthPath, 'utf8')).toBe('{"tokens":{"access_token":"old-remote-b"}}');
    expect(distributeCodexFn).not.toHaveBeenCalled();

    const sshLog = readFileSync(sshLogPath, 'utf8');
    expect(sshLog).toContain('host=remote-a');
    expect(sshLog).not.toContain('host=remote-b');
    expect(sshLog).toContain('/tmp/key-a');
    expect(sshLog).not.toContain('/tmp/key-b');
    expect(sshLog).toContain('mktemp -d');
    expect(sshLog).toContain('codex exec --skip-git-repo-check');
    expect(sshLog).toContain('.incoming');

    const codexCalls = readRemoteCodexCalls(remoteCodexLogPath);
    expect(codexCalls.map((call) => call.host)).toEqual(['remote-a', 'remote-a']);
    expect(codexCalls.map((call) => call.args)).toEqual([
      'login --device-auth',
      'exec --skip-git-repo-check Reply with just the word ok',
    ]);
    expect(codexCalls[0].codexHome).toBe(codexCalls[1].codexHome);
    expect(codexCalls[0].codexHome).not.toBe(join(remoteAHome, '.codex'));
    expect(existsSync(codexCalls[0].codexHome)).toBe(false);
  }, 20_000);

  it('leaves the named host auth untouched when the remote test call fails', async () => {
    const remoteAHome = join(remoteRoot, 'remote-a-home');
    const remoteBHome = join(remoteRoot, 'remote-b-home');
    mkdirSync(join(remoteAHome, '.codex'), { recursive: true });
    mkdirSync(join(remoteBHome, '.codex'), { recursive: true });
    const remoteAAuthPath = join(remoteAHome, '.codex', 'auth.json');
    const remoteBAuthPath = join(remoteBHome, '.codex', 'auth.json');
    writeFileSync(remoteAAuthPath, '{"tokens":{"access_token":"old-remote-a"}}');
    writeFileSync(remoteBAuthPath, '{"tokens":{"access_token":"old-remote-b"}}');
    const beforeRemoteAHash = hashFile(remoteAAuthPath);
    const beforeRemoteBHash = hashFile(remoteBAuthPath);

    const sshLogPath = join(remoteRoot, 'ssh.log');
    const remoteCodexLogPath = join(remoteRoot, 'remote-codex.log');
    sshBinDir = createFakeSshBin({
      logPath: sshLogPath,
      remoteBinDir,
      remoteCodexLog: remoteCodexLogPath,
      hostHomes: { 'remote-a': remoteAHome, 'remote-b': remoteBHome },
      failProbeHost: 'remote-a',
    });
    process.env.PATH = `${sshBinDir}:${originalPath}`;

    const deps: AgentLoginSessionDependencies = {
      host: 'do-1',
      remoteTargets: [
        remoteTarget('do-1', 'remote-a', '/tmp/key-a'),
        remoteTarget('do-2', 'remote-b', '/tmp/key-b'),
      ],
    };

    const started = await startAgentLogin('codex', deps);
    expect(started.status).toBe('awaiting_user');

    await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'failed');
    const final = getAgentLoginStatus(started.sessionId, deps);
    expect(final.error).toMatch(/probe failed/i);
    expect(hashFile(remoteAAuthPath)).toBe(beforeRemoteAHash);
    expect(hashFile(remoteBAuthPath)).toBe(beforeRemoteBHash);

    const sshLog = readFileSync(sshLogPath, 'utf8');
    expect(sshLog).toContain('host=remote-a');
    expect(sshLog).not.toContain('host=remote-b');
    expect(sshLog).toContain('rm -rf');
    expect(readRemoteCodexCalls(remoteCodexLogPath).map((call) => call.args)).toEqual([
      'login --device-auth',
      'exec --skip-git-repo-check Reply with just the word ok',
    ]);
  }, 20_000);

  it('keeps owner-local codex behavior when no host is requested even if fake ssh is on PATH', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'invoker-agent-login-home-'));
    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, 'auth.json');
    writeFileSync(authPath, '{"tokens":{"access_token":"old-live-token"}}');

    const sshLogPath = join(remoteRoot, 'ssh.log');
    const remoteCodexLogPath = join(remoteRoot, 'remote-codex.log');
    sshBinDir = createFakeSshBin({
      logPath: sshLogPath,
      remoteBinDir,
      remoteCodexLog: remoteCodexLogPath,
      hostHomes: { 'remote-a': join(remoteRoot, 'remote-a-home') },
    });
    const localCodexBinDir = createFakeBin('codex', CODEX_HAPPY_SCRIPT);
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    process.env.PATH = `${sshBinDir}:${localCodexBinDir}:${originalPath}`;

    const distributeCodexFn = vi.fn().mockResolvedValue(undefined);
    const deps: AgentLoginSessionDependencies = {
      remoteTargets: [remoteTarget('do-1', 'remote-a', '/tmp/key-a')],
      distributeCodexFn,
    };

    try {
      const started = await startAgentLogin('codex', deps);
      expect(started.status).toBe('awaiting_user');
      await waitFor(() => getAgentLoginStatus(started.sessionId, deps).status === 'installed');
      expect(readFileSync(authPath, 'utf8')).toBe('{"tokens":{"access_token":"fake-codex-access-token-xyz"}}');
      expect(distributeCodexFn).toHaveBeenCalledTimes(1);
      expect(existsSync(sshLogPath)).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(localCodexBinDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
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
