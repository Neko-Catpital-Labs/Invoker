import { describe, expect, it } from 'vitest';

import { runStartupPrerequisites } from '../startup-prerequisites.js';

const presets = { 'cursor+claude': { tool: 'cursor', model: 'claude' }, omp: { tool: 'omp' } };

describe('runStartupPrerequisites', () => {
  it('returns no failures when the default preset tool is installed', () => {
    expect(runStartupPrerequisites(presets, 'omp', undefined, (cmd) => cmd === 'omp')).toEqual([]);
  });

  it('reports the default-preset failure when its tool is missing', () => {
    const fails = runStartupPrerequisites(presets, 'cursor+claude', undefined, (cmd) => cmd === 'omp');
    expect(fails.some((c) => c.id === 'default-preset' && c.status === 'error')).toBe(true);
  });

  it('uses built-in presets when config presets are absent', () => {
    const fails = runStartupPrerequisites({}, 'cursor+claude', undefined, (cmd) => cmd === 'cursor');
    expect(fails).toEqual([]);
  });

  it('fails when the default planning preset harness is missing from host capabilities', () => {
    const fails = runStartupPrerequisites(
      {},
      'cursor+claude',
      {
        planning: {
          omp: { modelPolicy: { kind: 'implicit' } },
        },
      },
      (cmd) => cmd === 'cursor',
    );
    expect(fails).toContainEqual(expect.objectContaining({
      id: 'default-preset-capability',
      status: 'error',
      detail: 'Default preset "cursor+claude" is unsupported by this host: missing planning harness "cursor"',
    }));
  });

  it('fails when the default planning preset requests a disallowed fixed model', () => {
    const fails = runStartupPrerequisites(
      {},
      'cursor+codex',
      {
        planning: {
          cursor: { modelPolicy: { kind: 'fixed', model: 'claude' } },
        },
      },
      (cmd) => cmd === 'cursor',
    );
    expect(fails).toContainEqual(expect.objectContaining({
      id: 'default-preset-capability',
      status: 'error',
      detail: 'Default preset "cursor+codex" is unsupported by this host: harness "cursor" is fixed to model "claude"',
    }));
  });
});
