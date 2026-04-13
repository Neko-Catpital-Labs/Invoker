import { describe, expect, it } from 'vitest';
import { rewriteLegacyAbsoluteRepoCd } from '../command-normalization.js';

describe('rewriteLegacyAbsoluteRepoCd', () => {
  const repoUrl = 'git@github.com:EdbertChan/Invoker.git';

  it('strips a stale absolute repo-root cd prefix', () => {
    expect(
      rewriteLegacyAbsoluteRepoCd(
        'cd /home/edbert-chan/Invoker-Personal/Invoker && pnpm lint',
        repoUrl,
      ),
    ).toBe('pnpm lint');
  });

  it('rewrites a stale absolute package subdirectory cd prefix', () => {
    expect(
      rewriteLegacyAbsoluteRepoCd(
        'cd /home/edbert-chan/Invoker/packages/app && pnpm test -- --runInBand',
        repoUrl,
      ),
    ).toBe('cd packages/app && pnpm test -- --runInBand');
  });

  it('handles quoted remote paths', () => {
    expect(
      rewriteLegacyAbsoluteRepoCd(
        "cd '~/workspace/Invoker/packages/ui' && pnpm build",
        repoUrl,
      ),
    ).toBe('cd packages/ui && pnpm build');
  });

  it('leaves unrelated commands unchanged', () => {
    expect(rewriteLegacyAbsoluteRepoCd('cd packages/app && pnpm test', repoUrl))
      .toBe('cd packages/app && pnpm test');
    expect(rewriteLegacyAbsoluteRepoCd('pnpm test', repoUrl)).toBe('pnpm test');
  });
});
