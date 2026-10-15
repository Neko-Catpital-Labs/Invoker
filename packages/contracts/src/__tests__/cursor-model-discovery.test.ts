import { describe, expect, it } from 'vitest';

import { parseCursorListModelsOutput } from '../cursor-model-discovery.js';

describe('parseCursorListModelsOutput', () => {
  it('parses id - label lines and strips ANSI / default markers', () => {
    const stdout = [
      '\x1b[2K\x1b[GLoading models…',
      'Available models',
      '',
      'auto - Auto  (default)',
      'claude-4.5-sonnet - Claude Sonnet 4.5',
      'gpt-5.3-codex - Codex 5.3',
    ].join('\n');

    expect(parseCursorListModelsOutput(stdout)).toEqual({
      kind: 'ok',
      models: [
        { id: 'auto', label: 'Auto' },
        { id: 'claude-4.5-sonnet', label: 'Claude Sonnet 4.5' },
        { id: 'gpt-5.3-codex', label: 'Codex 5.3' },
      ],
    });
  });

  it('returns empty when the header is present but no model lines', () => {
    expect(parseCursorListModelsOutput('Available models\n\n')).toEqual({ kind: 'empty' });
  });

  it('returns invalid for malformed output', () => {
    expect(parseCursorListModelsOutput('boom: not a catalog')).toEqual({
      kind: 'invalid',
      reason: 'no model lines found',
    });
  });

  it('dedupes model ids case-insensitively', () => {
    const parsed = parseCursorListModelsOutput([
      'auto - Auto',
      'Auto - Auto Dup',
    ].join('\n'));
    expect(parsed).toEqual({
      kind: 'ok',
      models: [{ id: 'auto', label: 'Auto' }],
    });
  });
});
