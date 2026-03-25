import { describe, it, expect } from 'vitest';
import { normalizeBranchForGithubCli } from '../github-branch-ref.js';

describe('normalizeBranchForGithubCli', () => {
  it('strips origin/ remote-tracking prefix', () => {
    expect(normalizeBranchForGithubCli('origin/main')).toBe('main');
    expect(normalizeBranchForGithubCli('origin/fix/foo-bar')).toBe('fix/foo-bar');
  });

  it('strips upstream/ prefix', () => {
    expect(normalizeBranchForGithubCli('upstream/develop')).toBe('develop');
  });

  it('strips refs/heads/', () => {
    expect(normalizeBranchForGithubCli('refs/heads/main')).toBe('main');
  });

  it('strips refs/remotes/<remote>/', () => {
    expect(normalizeBranchForGithubCli('refs/remotes/origin/fix/x')).toBe('fix/x');
  });

  it('leaves short branch names unchanged', () => {
    expect(normalizeBranchForGithubCli('main')).toBe('main');
    expect(normalizeBranchForGithubCli('plan/my-feature')).toBe('plan/my-feature');
    expect(normalizeBranchForGithubCli('fix/ssh-merge')).toBe('fix/ssh-merge');
  });
});
