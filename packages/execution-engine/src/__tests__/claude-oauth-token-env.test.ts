import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ClaudeExecutionAgent } from '../agents/claude-execution-agent.js';
import { buildRemoteAgentEnvExports, loadRemoteAgentEnv } from '../remote-agent-env.js';
import { traceExecution } from '../exec-trace.js';

const TOKEN = 'sk-ant-oat01-test-token-value';
const LOCAL_ENV_KEYS_TODAY = ['ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'];

const dirs: string[] = [];
const originalEnv = process.env;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function writeSecrets(lines: string[]): string {
  const path = join(tempDir('claude-oauth-secrets-'), 'secrets.env');
  writeFileSync(path, lines.join('\n'), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function newAgent(): ClaudeExecutionAgent {
  return new ClaudeExecutionAgent({ configDir: tempDir('claude-oauth-config-') });
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('CLAUDE_CODE_OAUTH_TOKEN absent', () => {
  it('leaves the local Claude agent env keys unchanged', () => {
    const agent = newAgent();
    expect(Object.keys(agent.getContainerRequirements().env).sort()).toEqual(LOCAL_ENV_KEYS_TODAY);
  });

  it('leaves the remote export script unchanged', () => {
    const path = writeSecrets(['LINEAR_API_KEY=lin_secret', 'ANTHROPIC_API_KEY=agent-key']);

    expect(loadRemoteAgentEnv(path, false)).toEqual({ LINEAR_API_KEY: 'lin_secret' });
    expect(buildRemoteAgentEnvExports(path, false)).toBe("export LINEAR_API_KEY='lin_secret'\n");
    expect(buildRemoteAgentEnvExports(path, true)).toBe(
      "export LINEAR_API_KEY='lin_secret'\nexport ANTHROPIC_API_KEY='agent-key'\n",
    );
  });

  it('ignores a whitespace-only token', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = '   ';
    const agent = newAgent();
    expect(Object.keys(agent.getContainerRequirements().env).sort()).toEqual(LOCAL_ENV_KEYS_TODAY);
  });
});

describe('CLAUDE_CODE_OAUTH_TOKEN present', () => {
  it('reaches Claude tasks locally', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    const agent = newAgent();
    expect(agent.getContainerRequirements().env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it('reaches Claude tasks over SSH without use_api_key', () => {
    const path = writeSecrets([`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`, 'ANTHROPIC_API_KEY=agent-key']);

    expect(loadRemoteAgentEnv(path, false)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
    expect(buildRemoteAgentEnvExports(path, false)).toContain(`export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}'`);
    expect(buildRemoteAgentEnvExports(path, true)).toContain(`export CLAUDE_CODE_OAUTH_TOKEN='${TOKEN}'`);
  });

  it('never writes the token value to a log line', () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN;
    process.env.INVOKER_TRACE_EXECUTION = '1';
    const path = writeSecrets([`CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}`]);

    const logged: string[] = [];
    const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }

    const agent = newAgent();
    const localEnv = agent.getContainerRequirements().env;
    const exports = buildRemoteAgentEnvExports(path, true);
    traceExecution('[claude-oauth-token-env] built env', Object.keys(localEnv).join(','));

    expect(localEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(exports).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain(TOKEN);
    }
  });
});
