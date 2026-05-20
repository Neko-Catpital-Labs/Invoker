import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSecretsFile } from '../secrets-loader.js';

describe('loadSecretsFile', () => {
  it('strips unquoted inline comments from secret values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-secrets-loader-'));
    const secretsFile = join(dir, 'secrets.env');
    writeFileSync(
      secretsFile,
      [
        'OPENAI_API_KEY=sk-test-key # used by remote codex',
        'ANTHROPIC_API_KEY="sk-ant-key # quoted value keeps hash"',
        "CLAUDE_API_KEY='sk-claude-key # quoted value keeps hash'",
        'CODEX_API_KEY=sk-key-with#hash',
      ].join('\n'),
      { mode: 0o600 },
    );

    try {
      expect(loadSecretsFile(secretsFile)).toEqual([
        'OPENAI_API_KEY=sk-test-key',
        'ANTHROPIC_API_KEY=sk-ant-key # quoted value keeps hash',
        'CLAUDE_API_KEY=sk-claude-key # quoted value keeps hash',
        'CODEX_API_KEY=sk-key-with#hash',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
