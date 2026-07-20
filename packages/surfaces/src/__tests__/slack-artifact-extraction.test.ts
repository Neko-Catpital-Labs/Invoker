import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { MAX_ARTIFACT_UPLOADS, extractArtifactPaths } from '../slack/slack-message-helpers.js';

const WORKTREE = resolve('/tmp/slack-thread-worktree');

describe('extractArtifactPaths', () => {
  it('extracts an absolute link inside the worktree', () => {
    const png = `${WORKTREE}/artifacts/inbox.png`;
    const { paths, rejected } = extractArtifactPaths(`Here it is: [inbox](${png})`, WORKTREE);
    expect(paths).toEqual([png]);
    expect(rejected).toEqual([]);
  });

  it('accepts file:// links', () => {
    const png = `${WORKTREE}/a.png`;
    expect(extractArtifactPaths(`[a](file://${png})`, WORKTREE).paths).toEqual([png]);
  });

  it('returns a repeated link only once', () => {
    const png = `${WORKTREE}/a.png`;
    expect(extractArtifactPaths(`[a](${png}) and again [a](${png})`, WORKTREE).paths).toEqual([png]);
  });

  it('rejects paths outside the worktree and says why', () => {
    const { paths, rejected } = extractArtifactPaths('[key](/Users/someone/.ssh/id_rsa)', WORKTREE);
    expect(paths).toEqual([]);
    expect(rejected).toEqual([
      { path: '/Users/someone/.ssh/id_rsa', reason: 'outside thread worktree' },
    ]);
  });

  it('rejects traversal that escapes the worktree', () => {
    const { paths, rejected } = extractArtifactPaths(`[x](${WORKTREE}/../../etc/passwd)`, WORKTREE);
    expect(paths).toEqual([]);
    expect(rejected[0].reason).toBe('outside thread worktree');
  });

  it('does not treat a sibling directory sharing the prefix as inside', () => {
    const { paths, rejected } = extractArtifactPaths(`[x](${WORKTREE}-other/secret.png)`, WORKTREE);
    expect(paths).toEqual([]);
    expect(rejected[0].reason).toBe('outside thread worktree');
  });

  it('ignores relative source-file references in prose', () => {
    const { paths, rejected } = extractArtifactPaths(
      '[helpers](packages/surfaces/src/slack/slack-message-helpers.ts:162)',
      WORKTREE,
    );
    expect(paths).toEqual([]);
    expect(rejected).toEqual([]);
  });

  it('ignores http links', () => {
    expect(extractArtifactPaths('[docs](https://example.com/a.png)', WORKTREE).paths).toEqual([]);
  });

  it('caps the batch and reports what it dropped', () => {
    const links = Array.from(
      { length: MAX_ARTIFACT_UPLOADS + 3 },
      (_, i) => `[f${i}](${WORKTREE}/f${i}.png)`,
    ).join('\n');
    const { paths, rejected } = extractArtifactPaths(links, WORKTREE);
    expect(paths).toHaveLength(MAX_ARTIFACT_UPLOADS);
    expect(rejected).toHaveLength(3);
    expect(rejected[0].reason).toContain('limit');
  });
});
