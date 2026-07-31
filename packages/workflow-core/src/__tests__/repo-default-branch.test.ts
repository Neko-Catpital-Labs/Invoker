import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import * as repoDefaultBranch from '../repo-default-branch.js';

describe('repo-default-branch', () => {
  afterEach(() => {
    execFileSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it('preserves explicit workflow base branches and defaults blank values to master', () => {
    expect(repoDefaultBranch.normalizeWorkflowBaseBranch('plan/upstream-step')).toBe('plan/upstream-step');
    expect(repoDefaultBranch.normalizeWorkflowBaseBranch('  release  ')).toBe('release');
    expect(repoDefaultBranch.normalizeWorkflowBaseBranch('')).toBe('master');
    expect(repoDefaultBranch.normalizeWorkflowBaseBranch(undefined)).toBe('master');
    expect(repoDefaultBranch.workflowBaseBranchNeedsMigration('plan/upstream-step')).toBe(false);
    expect(repoDefaultBranch.workflowBaseBranchNeedsMigration('')).toBe(true);
  });

  it('passes a dash-prefixed repo path after --', () => {
    execFileSyncMock.mockReturnValue('ref: refs/heads/main HEAD\n');

    expect(repoDefaultBranch.detectDefaultBranchRemote('-origin.git')).toBe('main');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['ls-remote', '--symref', '--', '-origin.git', 'HEAD'],
      expect.objectContaining({
        encoding: 'utf8',
        timeout: 10_000,
      }),
    );
  });

  it('redacts credentials when default-branch lookup fails', () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('ls-remote failed');
    });

    expect(() => repoDefaultBranch.requireDefaultBranchRemote('https://user:secret@example.invalid/repo.git')).toThrow(
      'Unable to resolve default branch for repo. Make the remote HEAD readable.',
    );
  });
});
