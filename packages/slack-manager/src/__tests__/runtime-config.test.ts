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

  // `it.fails`: this asserts the DESIRED behavior, which the current standalone
  // Slack manager does not satisfy — it documents the stale owner-env override
  // bug and stays green in CI. The fix slice removes `.fails` once
  // ~/.invoker/config.json wins over a stale INVOKER_SLACK_DEFAULT_PRESET.
  it.fails('prefers ~/.invoker/config.json over a stale owner env preset', () => {
    expect(resolveDefaultHarnessPreset('omp+codex', 'codex')).toBe('codex');
  });
});
