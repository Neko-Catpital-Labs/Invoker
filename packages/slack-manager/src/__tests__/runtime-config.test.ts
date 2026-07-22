import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { readDefaultSlackHarnessPreset, readSlackRuntimeConfig, resolveDefaultHarnessPreset } from '../runtime-config.js';

describe('runtime-config', () => {
  it('reads defaultSlackHarnessPreset from ~/.invoker/config.json shape', () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-slack-config-'));
    const configDir = join(home, '.invoker');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ defaultSlackHarnessPreset: 'codex' }));

    expect(readDefaultSlackHarnessPreset(configPath)).toBe('codex');
  });

  it('reads the documented Slack repository aliases and default repository', () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-slack-repos-'));
    const configDir = join(home, '.invoker');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      defaultRepoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
      slackRepos: {
        notarepo: 'https://github.com/EdbertChan/notarepo.git',
        invalid: 42,
      },
    }));

    expect(readSlackRuntimeConfig(configPath)).toEqual({
      defaultRepoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git',
      repoAliases: { notarepo: 'https://github.com/EdbertChan/notarepo.git' },
    });
  });

  it('falls back to the owner env preset when no config default is present', () => {
    expect(resolveDefaultHarnessPreset('omp+codex', undefined)).toBe('omp+codex');
  });
  // The standalone Slack manager should follow ~/.invoker/config.json first so
  // the documented default preset cannot be shadowed by a stale
  // INVOKER_SLACK_DEFAULT_PRESET in ~/.invoker/.slack-owner.env.
  it('prefers ~/.invoker/config.json over a stale owner env preset', () => {
    expect(resolveDefaultHarnessPreset('omp+codex', 'codex')).toBe('codex');
  });
});
