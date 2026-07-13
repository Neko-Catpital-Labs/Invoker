import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRemoteAgentEnvExports } from '../remote-agent-env.js';

describe('buildRemoteAgentEnvExports', () => {
  it('does not export ambient agent provider keys by default', () => {
    const exports = buildRemoteAgentEnvExports(undefined, false, {
      ANTHROPIC_API_KEY: 'ambient-agent-key',
    });

    expect(exports).toBe('');
  });

  it('exports GitHub CLI auth from the runner environment for SSH command tasks', () => {
    const exports = buildRemoteAgentEnvExports(undefined, false, {
      GH_TOKEN: "ghs_test'quote",
    });

    expect(exports).toBe("export GH_TOKEN='ghs_test'\\''quote'\n");
  });

  it('exports GitHub CLI auth from secrets without enabling agent API keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-remote-env-'));
    const secretsFile = join(dir, 'secrets.env');
    writeFileSync(
      secretsFile,
      [
        'GITHUB_TOKEN=ghs_from_file',
        'OPENAI_API_KEY=agent-key-should-not-forward',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    try {
      const exports = buildRemoteAgentEnvExports(secretsFile, false, {});

      expect(exports).toContain("export GITHUB_TOKEN='ghs_from_file'");
      expect(exports).not.toContain('OPENAI_API_KEY');
      expect(exports).not.toContain('agent-key-should-not-forward');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
