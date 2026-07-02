import { describe, expect, it } from 'vitest';

import { runStartupPrerequisites } from '../startup-prerequisites.js';

const presets = { 'cursor+claude': { tool: 'cursor', model: 'claude' }, omp: { tool: 'omp' } };

describe('runStartupPrerequisites', () => {
  it('returns no failures when the default preset tool is installed', () => {
    expect(runStartupPrerequisites(presets, 'omp', (cmd) => cmd === 'omp')).toEqual([]);
  });

  it('reports the default-preset failure when its tool is missing', () => {
    const fails = runStartupPrerequisites(presets, 'cursor+claude', (cmd) => cmd === 'omp');
    expect(fails.some((c) => c.id === 'default-preset' && c.status === 'error')).toBe(true);
  });

  it('skips checks when no presets are configured', () => {
    expect(runStartupPrerequisites({}, 'cursor+claude', () => false)).toEqual([]);
  });
});
