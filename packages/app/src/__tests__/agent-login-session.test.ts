import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getAgentLoginStatus,
  parseClaudeSetupTokenUrl,
  parseClaudeSetupTokenValue,
  parseCodexDeviceAuthOutput,
  startAgentLogin,
  stripAnsiColorCodes,
  submitAgentLoginCode,
  type AgentLoginSessionOptions,
} from '../agent-login-session.js';

const CODEX_FAKE = `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "login" ] && [ "\${2:-}" = "--device-auth" ]; then
  printf '\\033[1mStarting device authorization...\\033[0m\\n'
  printf 'Open this URL to continue: \\033[36mhttps://auth.example.com/device?user_code=ABCD-1234\\033[0m\\n'
  printf 'One-time code: \\033[33mABCD-1234\\033[0m\\n'
  i=0
  while [ ! -f "\${INVOKER_TEST_CODEX_DONE_FILE:?}" ]; do
    sleep 0.05
    i=\$((i+1))
    if [ "\$i" -gt 200 ]; then
      echo "timed out waiting for device auth" >&2
      exit 1
    fi
  done
  outcome="\$(cat "\${INVOKER_TEST_CODEX_DONE_FILE}")"
  if [ "\$outcome" = "fail" ]; then
    echo "authorization denied" >&2
    exit 1
  fi
  mkdir -p "\${CODEX_HOME:?}"
  printf '{"access_token":"fake-codex-access-token","account_id":"fake-account"}' > "\${CODEX_HOME}/auth.json"
  exit 0
fi

if [ "\${1:-}" = "exec" ]; then
  if [ "\${INVOKER_TEST_CODEX_PROBE_OUTCOME:-ok}" = "fail" ]; then
    echo "codex probe failed" >&2
    exit 1
  fi
  echo "ok"
  exit 0
fi

echo "unhandled codex fake args: \$*" >&2
exit 1
`;

const CLAUDE_FAKE = `#!/usr/bin/env bash
set -euo pipefail

if [ "\${1:-}" = "setup-token" ]; then
  printf 'Visit this URL to authorize: \\033[36mhttps://claude.ai/oauth/authorize?state=xyz\\033[0m\\r\\n'
  IFS= read -r pasted_code
  pasted_code="\${pasted_code%\$'\\r'}"
  if [ "\$pasted_code" = "WRONGCODE" ]; then
    printf 'Invalid code.\\r\\n'
    exit 1
  fi
  printf 'Authorization successful.\\r\\n'
  printf 'Your Claude Code OAuth token: \\033[32msk-ant-oat01-FAKETOKEN12345\\033[0m\\r\\n'
  exit 0
fi

if [ "\${1:-}" = "-p" ]; then
  if [ "\${INVOKER_TEST_CLAUDE_PROBE_OUTCOME:-ok}" = "fail" ]; then
    echo "claude probe failed" >&2
    exit 1
  fi
  echo "ok"
  exit 0
fi

echo "unhandled claude fake args: \$*" >&2
exit 1
`;

function writeFakeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, 'utf8');
  chmodSync(path, 0o755);
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('agent-login-session', () => {
  let scratchDir: string;
  let binDir: string;
  let homeDir: string;
  let codexDoneFile: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'invoker-agent-login-session-'));
    binDir = join(scratchDir, 'bin');
    homeDir = join(scratchDir, 'home');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    writeFakeExecutable(join(binDir, 'codex'), CODEX_FAKE);
    writeFakeExecutable(join(binDir, 'claude'), CLAUDE_FAKE);
    codexDoneFile = join(scratchDir, 'codex-done');
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function baseOptions(overrides: Partial<AgentLoginSessionOptions> = {}): AgentLoginSessionOptions {
    return {
      homeDir,
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        INVOKER_TEST_CODEX_DONE_FILE: codexDoneFile,
      },
      deviceAuthParseTimeoutMs: 5_000,
      probeTimeoutMs: 5_000,
      ...overrides,
    };
  }

  describe('parsers', () => {
    it('strips ANSI colour codes', () => {
      expect(stripAnsiColorCodes('\x1b[36mhello\x1b[0m')).toBe('hello');
    });

    it('parses the codex device URL and one-time code out of colourized output', () => {
      const raw = 'Open this URL to continue: \x1b[36mhttps://auth.example.com/device?user_code=ABCD-1234\x1b[0m\nOne-time code: \x1b[33mABCD-1234\x1b[0m\n';
      expect(parseCodexDeviceAuthOutput(raw)).toEqual({
        url: 'https://auth.example.com/device?user_code=ABCD-1234',
        code: 'ABCD-1234',
      });
    });

    it('returns null when the codex output has no code yet', () => {
      expect(parseCodexDeviceAuthOutput('Starting device authorization...\n')).toBeNull();
    });

    it('parses the claude setup-token URL', () => {
      const raw = 'Visit this URL to authorize: \x1b[36mhttps://claude.ai/oauth/authorize?state=xyz\x1b[0m\r\n';
      expect(parseClaudeSetupTokenUrl(raw)).toBe('https://claude.ai/oauth/authorize?state=xyz');
    });

    it('parses the claude setup-token value', () => {
      const raw = 'Your Claude Code OAuth token: \x1b[32msk-ant-oat01-FAKETOKEN12345\x1b[0m\r\n';
      expect(parseClaudeSetupTokenValue(raw)).toBe('sk-ant-oat01-FAKETOKEN12345');
    });
  });

  describe('codex login', () => {
    it('reports the link and code, then installs after a passing probe', async () => {
      const view = await startAgentLogin('codex', baseOptions());
      expect(view.status).toBe('awaiting_user');
      expect(view.url).toBe('https://auth.example.com/device?user_code=ABCD-1234');
      expect(view.code).toBe('ABCD-1234');

      writeFileSync(codexDoneFile, 'ok');

      let final = await getAgentLoginStatus(view.sessionId);
      for (let i = 0; i < 100 && final.status !== 'installed' && final.status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        final = await getAgentLoginStatus(view.sessionId);
      }

      expect(final.status).toBe('installed');
      const installedAuth = readFileSync(join(homeDir, '.codex', 'auth.json'), 'utf8');
      expect(installedAuth).toContain('fake-codex-access-token');
    });

    it('backs up an existing login before installing a new one', async () => {
      mkdirSync(join(homeDir, '.codex'), { recursive: true });
      writeFileSync(join(homeDir, '.codex', 'auth.json'), '{"access_token":"old-token"}');

      const view = await startAgentLogin('codex', baseOptions());
      writeFileSync(codexDoneFile, 'ok');

      let final = await getAgentLoginStatus(view.sessionId);
      for (let i = 0; i < 100 && final.status !== 'installed' && final.status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        final = await getAgentLoginStatus(view.sessionId);
      }

      expect(final.status).toBe('installed');
      const codexDir = readFileSync(join(homeDir, '.codex', 'auth.json'), 'utf8');
      expect(codexDir).toContain('fake-codex-access-token');

      const entries = readdirSync(join(homeDir, '.codex'));
      const backups = entries.filter((name) => name.startsWith('auth.json.bak-'));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(homeDir, '.codex', backups[0]), 'utf8')).toBe('{"access_token":"old-token"}');
    });

    it('never installs when the new login fails its probe, leaving live files byte-identical', async () => {
      const codexDir = join(homeDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, 'auth.json'), '{"access_token":"old-token"}');
      const secretsDir = join(homeDir, '.config', 'invoker');
      mkdirSync(secretsDir, { recursive: true });
      writeFileSync(join(secretsDir, 'secrets.env'), 'SOME_OTHER_KEY=untouched\n');

      const authHashBefore = sha256(join(codexDir, 'auth.json'));
      const secretsHashBefore = sha256(join(secretsDir, 'secrets.env'));

      const view = await startAgentLogin('codex', baseOptions({
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          INVOKER_TEST_CODEX_DONE_FILE: codexDoneFile,
          INVOKER_TEST_CODEX_PROBE_OUTCOME: 'fail',
        },
      }));
      writeFileSync(codexDoneFile, 'ok');

      let final = await getAgentLoginStatus(view.sessionId);
      for (let i = 0; i < 100 && final.status !== 'installed' && final.status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        final = await getAgentLoginStatus(view.sessionId);
      }

      expect(final.status).toBe('failed');
      expect(sha256(join(codexDir, 'auth.json'))).toBe(authHashBefore);
      expect(sha256(join(secretsDir, 'secrets.env'))).toBe(secretsHashBefore);
      expect(existsSync(join(codexDir, 'auth.json.bak-not-real'))).toBe(false);
    });

    it('fails when the device authorization itself is denied, and installs nothing', async () => {
      const codexDir = join(homeDir, '.codex');
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(join(codexDir, 'auth.json'), '{"access_token":"old-token"}');
      const hashBefore = sha256(join(codexDir, 'auth.json'));

      const view = await startAgentLogin('codex', baseOptions());
      writeFileSync(codexDoneFile, 'fail');

      let final = await getAgentLoginStatus(view.sessionId);
      for (let i = 0; i < 100 && final.status !== 'installed' && final.status !== 'failed'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        final = await getAgentLoginStatus(view.sessionId);
      }

      expect(final.status).toBe('failed');
      expect(sha256(join(codexDir, 'auth.json'))).toBe(hashBefore);
    });
  });

  describe('claude login', () => {
    it('reports the link, then installs the token after a passing probe with the pasted code', async () => {
      const view = await startAgentLogin('claude', baseOptions());
      expect(view.status).toBe('awaiting_code');
      expect(view.url).toBe('https://claude.ai/oauth/authorize?state=xyz');

      const final = await submitAgentLoginCode(view.sessionId, 'RIGHTCODE');

      expect(final.status).toBe('installed');
      const secrets = readFileSync(join(homeDir, '.config', 'invoker', 'secrets.env'), 'utf8');
      expect(secrets).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKETOKEN12345');
    });

    it('never leaks the token into the session view or error text', async () => {
      const view = await startAgentLogin('claude', baseOptions());
      const final = await submitAgentLoginCode(view.sessionId, 'RIGHTCODE');
      const serialized = JSON.stringify(final);
      expect(serialized).not.toContain('sk-ant-oat01-FAKETOKEN12345');
    });

    it('never installs when the new login fails its probe, leaving the secrets file byte-identical', async () => {
      const secretsDir = join(homeDir, '.config', 'invoker');
      mkdirSync(secretsDir, { recursive: true });
      const secretsPath = join(secretsDir, 'secrets.env');
      writeFileSync(secretsPath, 'CLAUDE_CODE_OAUTH_TOKEN=old-token\n');
      const hashBefore = sha256(secretsPath);

      const view = await startAgentLogin('claude', baseOptions({
        env: {
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          INVOKER_TEST_CODEX_DONE_FILE: codexDoneFile,
          INVOKER_TEST_CLAUDE_PROBE_OUTCOME: 'fail',
        },
      }));

      const final = await submitAgentLoginCode(view.sessionId, 'RIGHTCODE');

      expect(final.status).toBe('failed');
      expect(sha256(secretsPath)).toBe(hashBefore);
    });

    it('fails when the pasted code is rejected by the vendor CLI, and installs nothing', async () => {
      const secretsDir = join(homeDir, '.config', 'invoker');
      mkdirSync(secretsDir, { recursive: true });
      const secretsPath = join(secretsDir, 'secrets.env');
      writeFileSync(secretsPath, 'CLAUDE_CODE_OAUTH_TOKEN=old-token\n');
      const hashBefore = sha256(secretsPath);

      const view = await startAgentLogin('claude', baseOptions());
      const final = await submitAgentLoginCode(view.sessionId, 'WRONGCODE');

      expect(final.status).toBe('failed');
      expect(sha256(secretsPath)).toBe(hashBefore);
    });

    it('rejects submitting a code to a session that is not awaiting one', async () => {
      const view = await startAgentLogin('codex', baseOptions());
      await expect(submitAgentLoginCode(view.sessionId, '123456')).rejects.toThrow(/not awaiting a pasted code/);
    });
  });

  it('rejects an unknown session id', async () => {
    await expect(getAgentLoginStatus('does-not-exist')).rejects.toThrow(/Unknown agent login session/);
  });
});
