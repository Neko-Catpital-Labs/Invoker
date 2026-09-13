import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRemoteAgentEnvExports,
  loadLinearEnv,
  loadRemoteAgentEnv,
} from '../remote-agent-env.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSecrets(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'remote-agent-env-'));
  dirs.push(dir);
  const path = join(dir, 'secrets.env');
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe('loadLinearEnv', () => {
  it('returns empty when secretsFile is unset', () => {
    expect(loadLinearEnv(undefined)).toEqual({});
  });

  it('loads LINEAR keys without useApiKey', () => {
    const path = writeSecrets([
      'LINEAR_API_KEY=lin_secret',
      'INVOKER_LINEAR_API_KEY=lin_alt',
      'ANTHROPIC_API_KEY=should-not-appear',
      'OTHER_TOKEN=nope',
    ].join('\n'));
    expect(loadLinearEnv(path)).toEqual({
      LINEAR_API_KEY: 'lin_secret',
      INVOKER_LINEAR_API_KEY: 'lin_alt',
    });
  });
});

describe('loadRemoteAgentEnv', () => {
  it('always includes Linear keys even when useApiKey is false', () => {
    const path = writeSecrets([
      'LINEAR_API_KEY=lin_secret',
      'ANTHROPIC_API_KEY=agent-key',
      'OTHER_TOKEN=nope',
    ].join('\n'));
    expect(loadRemoteAgentEnv(path, false)).toEqual({
      LINEAR_API_KEY: 'lin_secret',
    });
  });

  it('includes agent keys only when useApiKey is true', () => {
    const path = writeSecrets([
      'LINEAR_API_KEY=lin_secret',
      'ANTHROPIC_API_KEY=agent-key',
      'OTHER_TOKEN=nope',
    ].join('\n'));
    expect(loadRemoteAgentEnv(path, true)).toEqual({
      LINEAR_API_KEY: 'lin_secret',
      ANTHROPIC_API_KEY: 'agent-key',
    });
  });

  it('never leaks non-allowlisted secrets into exports', () => {
    const path = writeSecrets([
      'LINEAR_API_KEY=lin_secret',
      'IGNORED_TOKEN=nope',
    ].join('\n'));
    const exports = buildRemoteAgentEnvExports(path, true);
    expect(exports).toContain("export LINEAR_API_KEY='lin_secret'");
    expect(exports).not.toContain('IGNORED_TOKEN');
    expect(exports).not.toContain('nope');
  });
});
