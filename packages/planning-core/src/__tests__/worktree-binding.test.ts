import { describe, expect, it } from 'vitest';
import { decideWorktreeBinding } from '../worktree-binding.js';

describe('decideWorktreeBinding', () => {
  it('provisions on first bind regardless of draft state', () => {
    expect(decideWorktreeBinding({
      requestedRepoUrl: 'https://example.com/repo.git',
      requestedHeadSha: 'sha-a',
      hasDraft: true,
    }).action).toBe('provision');

    expect(decideWorktreeBinding({
      requestedRepoUrl: 'https://example.com/repo.git',
      requestedHeadSha: 'sha-a',
      hasDraft: false,
    }).action).toBe('provision');
  });

  it('reuses when repo and commit are unchanged', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo.git',
      requestedHeadSha: 'sha-a',
      hasDraft: true,
    }).action).toBe('reuse');

    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo.git',
      requestedHeadSha: 'sha-a',
      hasDraft: false,
    }).action).toBe('reuse');
  });

  it('invalidates and blocks submit when commit changes with a draft in flight', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo.git',
      requestedHeadSha: 'sha-b',
      hasDraft: true,
    }).action).toBe('invalidate_and_block_submit');
  });

  it('provisions when commit changes with no draft in flight', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo.git',
      requestedHeadSha: 'sha-b',
      hasDraft: false,
    }).action).toBe('provision');
  });

  it('invalidates and blocks submit when repo changes with same sha and a draft in flight', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo-one.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo-two.git',
      requestedHeadSha: 'sha-a',
      hasDraft: true,
    }).action).toBe('invalidate_and_block_submit');
  });

  it('provisions when repo changes with same sha and no draft in flight', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo-one.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo-two.git',
      requestedHeadSha: 'sha-a',
      hasDraft: false,
    }).action).toBe('provision');
  });

  it('invalidates and blocks submit when repo and commit both change with a draft in flight', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo-one.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo-two.git',
      requestedHeadSha: 'sha-b',
      hasDraft: true,
    }).action).toBe('invalidate_and_block_submit');
  });

  it('provisions when repo and commit both change with no draft in flight', () => {
    expect(decideWorktreeBinding({
      storedRepoUrl: 'https://example.com/repo-one.git',
      storedHeadSha: 'sha-a',
      requestedRepoUrl: 'https://example.com/repo-two.git',
      requestedHeadSha: 'sha-b',
      hasDraft: false,
    }).action).toBe('provision');
  });
});
