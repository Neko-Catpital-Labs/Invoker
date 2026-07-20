import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { readDefaultSlackHarnessPreset, resolveDefaultHarnessPreset } from '../runtime-config.js';

describe('runtime-config', () => {
  it('reads defaultSlackHarnessPreset from ~/.invoker/config.json shape', () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-slack-config-'));
    const configDir = join(home, '.invoker');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ defaultSlackHarnessPreset: 'codex' }));

    expect(readDefaultSlackHarnessPreset(configPath)).toBe('codex');
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
