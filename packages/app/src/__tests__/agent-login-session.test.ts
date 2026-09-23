import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';

import {
  startAgentLogin,
  submitAgentLoginCode,
  getAgentLoginStatus,
  parseCodexDeviceAuthOutput,
  parseClaudeSetupTokenUrl,
  parseClaudeSetupTokenValue,
  type AgentLoginSessionSnapshot,
  type AgentLoginRemoteTarget,
} from '../agent-login-session.js';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';

const FAKE_CLAUDE_TOKEN = 'sk-ant-oat01-FAKE1234567890abcdefFAKE';

const CODEX_LOGIN_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;

if (args[0] === 'login' && args.includes('--device-auth')) {
  process.stdout.write('To finish logging in to Codex, open this URL in a browser:\\n\\n');
  process.stdout.write('    https://auth.example.com/device\\n\\n');
  process.stdout.write('And enter the code:\\n\\n');
  process.stdout.write('    ABCD-1234\\n\\n');
  process.stdout.write('Waiting for authorization...\\n');
  const mode = process.env.FAKE_CODEX_LOGIN_RESULT || 'success';
  setTimeout(() => {
    if (mode === 'success') {
      fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'FAKE-CODEX-AUTH-TOKEN' } }));
      process.exit(0);
    } else if (mode === 'fail-exit') {
      process.exit(1);
    } else {
      setInterval(() => {}, 1 << 30);
    }
  }, 40);
} else if (args[0] === 'exec') {
  const probeMode = process.env.FAKE_CODEX_PROBE_RESULT || 'ok';
  if (probeMode === 'ok') {
    process.stdout.write('ok\\n');
    process.exit(0);
  } else {
    process.stdout.write('Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.\\n');
    process.exit(1);
  }
} else {
  process.exit(1);
}
`;

const CLAUDE_SETUP_TOKEN_SCRIPT = `#!/usr/bin/env node
const readline = require('readline');
const args = process.argv.slice(2);

if (args[0] === '-p') {
  const probeMode = process.env.FAKE_CLAUDE_PROBE_RESULT || 'ok';
  if (probeMode === 'ok') {
    process.stdout.write('ok\\n');
    process.exit(0);
  } else {
    process.stdout.write('Failed to authenticate: OAuth session expired and could not be refreshed\\n');
    process.exit(1);
  }
} else if (args[0] === 'setup-token') {
  process.stdout.write('Please visit the following URL to authorize this device:\\n\\n');
  process.stdout.write('    https://auth.anthropic.com/authorize?client=cli\\n\\n');
  process.stdout.write('Then paste the code shown in your browser and press Enter:\\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.once('line', () => {
    const mode = process.env.FAKE_CLAUDE_LOGIN_RESULT || 'success';
    setTimeout(() => {
      if (mode === 'success') {
        process.stdout.write('\\nLogin successful. Your long-lived OAuth token:\\n\\n');
        process.stdout.write('${FAKE_CLAUDE_TOKEN}\\n');
        process.exit(0);
      } else {
        process.stdout.write('\\nAuthorization failed.\\n');
        process.exit(1);
      }
    }, 30);
  });
} else {
  process.exit(1);
}
`;

function writeFakeBin(dir: string, name: string, script: string): void {
  const filePath = join(dir, name);
  writeFileSync(filePath, script);
  chmodSync(filePath, 0o755);
}

function sha256OrMissing(path: string): string {
  if (!existsSync(path)) return 'MISSING';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function waitForStatus(
  sessionId: string,
  predicate: (status: AgentLoginSessionSnapshot | undefined) => boolean,
  timeoutMs = 5000,
): Promise<AgentLoginSessionSnapshot | undefined> {
  const start = Date.now();
  for (;;) {
    const snapshot = getAgentLoginStatus(sessionId);
    if (predicate(snapshot)) return snapshot;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for session ${sessionId}; last snapshot: ${JSON.stringify(snapshot)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class FakeWorkerDecisionStore {
  rows = new Map<string, WorkerActionRecord>();

  getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined {
    return this.rows.get(`${workerKind}:${externalKey}`);
  }

  upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord {
    const key = `${action.workerKind}:${action.externalKey}`;
    const existing = this.rows.get(key);
    const record: WorkerActionRecord = {
      ...action,
      createdAt: existing?.createdAt ?? action.createdAt ?? new Date().toISOString(),
      updatedAt: action.updatedAt ?? new Date().toISOString(),
      attemptCount: action.attemptCount ?? 0,
    };
    this.rows.set(key, record);
    return record;
  }
}

function createCapturingLogger(): { logger: Logger; calls: string[] } {
  const calls: string[] = [];
  const record = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    calls.push(`${level}: ${msg} ${fields ? JSON.stringify(fields) : ''}`);
  };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => logger,
  };
  return { logger, calls };
}

const ORIGINAL_PATH = process.env.PATH;
const FAKE_ENV_KEYS = [
  'FAKE_CODEX_LOGIN_RESULT',
  'FAKE_CODEX_PROBE_RESULT',
  'FAKE_CLAUDE_LOGIN_RESULT',
  'FAKE_CLAUDE_PROBE_RESULT',
] as const;

let fakeBinDir: string;
let workDir: string;
let codexAuthPath: string;
let secretsFilePath: string;

beforeEach(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'invoker-agent-login-bin-'));
  writeFakeBin(fakeBinDir, 'codex', CODEX_LOGIN_SCRIPT);
  writeFakeBin(fakeBinDir, 'claude', CLAUDE_SETUP_TOKEN_SCRIPT);
  process.env.PATH = `${fakeBinDir}${delimiter}${ORIGINAL_PATH}`;

  workDir = mkdtempSync(join(tmpdir(), 'invoker-agent-login-home-'));
  codexAuthPath = join(workDir, 'dot-codex', 'auth.json');
  secretsFilePath = join(workDir, 'secrets.env');
});

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  for (const key of FAKE_ENV_KEYS) delete process.env[key];
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('boundary parsers', () => {
  it('parses a codex device-auth url and code, stripping ANSI codes', () => {
    const raw = '\x1b[32mOpen this URL: https://auth.example.com/device\x1b[0m\nCode: ABCD-1234\n';
    expect(parseCodexDeviceAuthOutput(raw)).toEqual({ url: 'https://auth.example.com/device', code: 'ABCD-1234' });
  });

  it('returns null when the code or url is missing', () => {
    expect(parseCodexDeviceAuthOutput('no url or code here')).toBeNull();
  });

  it('parses a claude setup-token url', () => {
    expect(parseClaudeSetupTokenUrl('visit https://auth.anthropic.com/authorize?x=1 now')).toBe(
      'https://auth.anthropic.com/authorize?x=1',
    );
  });

  it('parses a claude oauth token from mixed output', () => {
    expect(parseClaudeSetupTokenValue(`noise\n${FAKE_CLAUDE_TOKEN}\nmore noise`)).toBe(FAKE_CLAUDE_TOKEN);
  });
});

describe('codex login flow', () => {
  it('reports the device-auth url and code, then installs after a passing probe', async () => {
    process.env.FAKE_CODEX_LOGIN_RESULT = 'success';
    process.env.FAKE_CODEX_PROBE_RESULT = 'ok';

    const started = await startAgentLogin('codex', { codexAuthPath, secretsFilePath });
    expect(started.status).toBe('awaiting_user');
    expect(started.url).toBe('https://auth.example.com/device');
    expect(started.code).toBe('ABCD-1234');

    const final = await waitForStatus(started.sessionId, (s) => s?.status === 'installed');
    expect(final?.status).toBe('installed');
    expect(existsSync(codexAuthPath)).toBe(true);
    expect(JSON.parse(readFileSync(codexAuthPath, 'utf8'))).toEqual({
      tokens: { access_token: 'FAKE-CODEX-AUTH-TOKEN' },
    });
  });

  it('leaves the live auth.json byte-identical when the post-login probe fails', async () => {
    mkdirSync(join(workDir, 'dot-codex'), { recursive: true });
    writeFileSync(codexAuthPath, JSON.stringify({ tokens: { access_token: 'STILL-LIVE-TOKEN' } }));
    const beforeHash = sha256OrMissing(codexAuthPath);
    const beforeSecretsHash = sha256OrMissing(secretsFilePath);

    process.env.FAKE_CODEX_LOGIN_RESULT = 'success';
    process.env.FAKE_CODEX_PROBE_RESULT = 'fail';

    const started = await startAgentLogin('codex', { codexAuthPath, secretsFilePath });
    const final = await waitForStatus(started.sessionId, (s) => s?.status === 'failed');
    expect(final?.status).toBe('failed');
    expect(final?.error).toMatch(/test call with the new Codex login failed/);

    expect(sha256OrMissing(codexAuthPath)).toBe(beforeHash);
    expect(sha256OrMissing(secretsFilePath)).toBe(beforeSecretsHash);
  });

  it('marks the session failed when the codex CLI exits non-zero', async () => {
    process.env.FAKE_CODEX_LOGIN_RESULT = 'fail-exit';

    const started = await startAgentLogin('codex', { codexAuthPath, secretsFilePath });
    const final = await waitForStatus(started.sessionId, (s) => s?.status === 'failed');
    expect(final?.error).toMatch(/codex login exited with code 1/);
    expect(existsSync(codexAuthPath)).toBe(false);
  });

  it('distributes the new Codex auth to every configured remote target and re-probes it', async () => {
    process.env.FAKE_CODEX_LOGIN_RESULT = 'success';
    process.env.FAKE_CODEX_PROBE_RESULT = 'ok';

    const distributed: Array<{ target: string; authJson: string }> = [];
    const probed: string[] = [];
    const remoteTargets: AgentLoginRemoteTarget[] = [
      { name: 'pool-1', connection: { host: 'pool1.example.com', user: 'invoker', sshKeyPath: '/dev/null' } },
      { name: 'pool-2', connection: { host: 'pool2.example.com', user: 'invoker', sshKeyPath: '/dev/null' } },
    ];

    const started = await startAgentLogin('codex', {
      codexAuthPath,
      secretsFilePath,
      remoteTargets,
      distributeCodexAuth: async (target, authJson) => {
        distributed.push({ target: target.name, authJson });
      },
      probeRemoteCodex: async (target) => {
        probed.push(target.name);
        return true;
      },
    });

    await waitForStatus(started.sessionId, (s) => s?.status === 'installed');

    expect(distributed.map((d) => d.target).sort()).toEqual(['pool-1', 'pool-2']);
    expect(JSON.parse(distributed[0].authJson)).toEqual({ tokens: { access_token: 'FAKE-CODEX-AUTH-TOKEN' } });
    expect(probed.sort()).toEqual(['pool-1', 'pool-2']);
  });

  it('records durable session state transitions in the worker decision store', async () => {
    process.env.FAKE_CODEX_LOGIN_RESULT = 'success';
    process.env.FAKE_CODEX_PROBE_RESULT = 'ok';
    const store = new FakeWorkerDecisionStore();

    const started = await startAgentLogin('codex', { codexAuthPath, secretsFilePath, store });
    await waitForStatus(started.sessionId, (s) => s?.status === 'installed');

    const row = store.getWorkerAction('agent-login-session', started.sessionId);
    expect(row?.status).toBe('completed');
    expect(row?.payload).toMatchObject({ status: 'installed' });
  });
});

describe('claude login flow', () => {
  it('reports the setup-token url, then installs the token after a passing probe', async () => {
    process.env.FAKE_CLAUDE_LOGIN_RESULT = 'success';
    process.env.FAKE_CLAUDE_PROBE_RESULT = 'ok';
    writeFileSync(secretsFilePath, 'OTHER_KEY=keep-me\n');

    const started = await startAgentLogin('claude', { codexAuthPath, secretsFilePath });
    expect(started.status).toBe('awaiting_code');
    expect(started.url).toBe('https://auth.anthropic.com/authorize?client=cli');

    const final = await submitAgentLoginCode(started.sessionId, 'BROWSER-CODE-1234');
    expect(final.status).toBe('installed');

    const secretsContents = readFileSync(secretsFilePath, 'utf8');
    expect(secretsContents).toContain('OTHER_KEY=keep-me');
    expect(secretsContents).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${FAKE_CLAUDE_TOKEN}`);

    const { readdirSync } = await import('node:fs');
    const backups = readdirSync(workDir).filter((name) => name.startsWith('secrets.env.bak-'));
    expect(backups.length).toBe(1);
  });

  it('leaves the secrets file byte-identical when the post-login probe fails, and never logs the token', async () => {
    process.env.FAKE_CLAUDE_LOGIN_RESULT = 'success';
    process.env.FAKE_CLAUDE_PROBE_RESULT = 'fail';
    writeFileSync(secretsFilePath, 'OTHER_KEY=keep-me\n');
    const beforeHash = sha256OrMissing(secretsFilePath);
    const beforeCodexHash = sha256OrMissing(codexAuthPath);

    const { logger, calls } = createCapturingLogger();
    const started = await startAgentLogin('claude', { codexAuthPath, secretsFilePath, logger });
    const final = await submitAgentLoginCode(started.sessionId, 'BROWSER-CODE-1234');

    expect(final.status).toBe('failed');
    expect(final.error).toMatch(/test call with the new Claude login failed/);
    expect(sha256OrMissing(secretsFilePath)).toBe(beforeHash);
    expect(sha256OrMissing(codexAuthPath)).toBe(beforeCodexHash);

    const combinedLogs = calls.join('\n');
    expect(combinedLogs).not.toContain(FAKE_CLAUDE_TOKEN);
    expect(JSON.stringify(getAgentLoginStatus(started.sessionId))).not.toContain(FAKE_CLAUDE_TOKEN);
  });

  it('fails the session when claude setup-token exits without producing a token', async () => {
    process.env.FAKE_CLAUDE_LOGIN_RESULT = 'fail';

    const started = await startAgentLogin('claude', { codexAuthPath, secretsFilePath });
    const final = await submitAgentLoginCode(started.sessionId, 'BROWSER-CODE-1234');
    expect(final.status).toBe('failed');
    expect(existsSync(secretsFilePath)).toBe(false);
  });
});

describe('session lookup and state errors', () => {
  it('rejects submitAgentLoginCode for an unknown session id', async () => {
    await expect(submitAgentLoginCode('does-not-exist', 'ABCD')).rejects.toThrow(/Unknown agent login session/);
  });

  it('rejects submitAgentLoginCode for a codex session', async () => {
    process.env.FAKE_CODEX_LOGIN_RESULT = 'success';
    process.env.FAKE_CODEX_PROBE_RESULT = 'ok';
    const started = await startAgentLogin('codex', { codexAuthPath, secretsFilePath });
    await expect(submitAgentLoginCode(started.sessionId, 'ABCD')).rejects.toThrow(/does not accept a submitted code/);
  });

  it('returns undefined for getAgentLoginStatus on an unknown session id', () => {
    expect(getAgentLoginStatus('does-not-exist')).toBeUndefined();
  });
});

describe('session expiry', () => {
  it('fails a session that never completes within its timeout', async () => {
    process.env.FAKE_CODEX_LOGIN_RESULT = 'never';

    const started = await startAgentLogin('codex', { codexAuthPath, secretsFilePath, sessionTimeoutMs: 150 });
    expect(started.status).toBe('awaiting_user');

    const final = await waitForStatus(started.sessionId, (s) => s?.status === 'failed', 3000);
    expect(final?.error).toMatch(/expired/);
  });
});
