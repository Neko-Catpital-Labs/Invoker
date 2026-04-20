import { describe, it, expect, vi } from 'vitest';
import { pushBranchWithRecovery } from '../git-branch-push-recovery.js';

describe('pushBranchWithRecovery', () => {
  it('retries when an overlapping publisher moves the same workflow feature branch first', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(
        new Error(
          "git push --force -u origin feature/test failed (code 1): cannot lock ref 'refs/heads/feature/test': is at aaa111 but expected bbb222",
        ),
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('local-tree\n')
      .mockResolvedValueOnce('remote-tree\n')
      .mockResolvedValueOnce('');

    await pushBranchWithRecovery({ exec }, '/tmp/repo', 'feature/test');

    expect(exec.mock.calls.map((call) => call[0])).toEqual([
      ['push', '--force', '-u', 'origin', 'feature/test'],
      ['fetch', 'origin', '+refs/heads/feature/test:refs/remotes/origin/feature/test'],
      ['rev-parse', 'HEAD^{tree}'],
      ['rev-parse', 'refs/remotes/origin/feature/test^{tree}'],
      ['push', '--force', '-u', 'origin', 'feature/test'],
    ]);
  });

  it('treats the race as success when an overlapping publisher already pushed equivalent content', async () => {
    const exec = vi.fn()
      .mockRejectedValueOnce(
        new Error(
          "git push --force -u origin feature/test failed (code 1): cannot lock ref 'refs/heads/feature/test': is at aaa111 but expected bbb222",
        ),
      )
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('same-tree\n')
      .mockResolvedValueOnce('same-tree\n');

    await pushBranchWithRecovery({ exec }, '/tmp/repo', 'feature/test');

    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('does not swallow non-race push failures', async () => {
    const exec = vi.fn().mockRejectedValueOnce(
      new Error('git push --force -u origin feature/test failed (code 1): authentication failed'),
    );

    await expect(pushBranchWithRecovery({ exec }, '/tmp/repo', 'feature/test')).rejects.toThrow(
      'authentication failed',
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
