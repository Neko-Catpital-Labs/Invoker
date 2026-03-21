import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';

vi.mock('node:child_process');

function mockSpawnResult(stdoutData: string, exitCode: number) {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;

  setTimeout(() => {
    stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

describe('GitHubMergeGateProvider', () => {
  let provider: GitHubMergeGateProvider;

  beforeEach(() => {
    provider = new GitHubMergeGateProvider();
    vi.clearAllMocks();
  });

  describe('createReview', () => {
    it('pushes branch and creates PR', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) {
          // git push
          return mockSpawnResult('', 0);
        } else if (callCount === 2) {
          // gh pr list — no existing PR
          return mockSpawnResult('[]', 0);
        } else {
          // gh api repos/{owner}/{repo}/pulls POST — returns JSON
          return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/42","number":42}', 0);
        }
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(result.identifier).toBe('42');

      // Verify git push was called
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['push', '--force', '-u', 'origin', 'feature/test'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );

      // Verify gh api POST was called to create the PR
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/{owner}/{repo}/pulls', '--method', 'POST', '-f', 'base=main', '-f', 'head=feature/test', '-f', 'title=Test PR', '-f', 'body='],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('reuses existing open PR and updates title', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) {
          // git push
          return mockSpawnResult('', 0);
        } else if (callCount === 2) {
          // gh pr list — existing PR found
          return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/10","number":10}]', 0);
        } else {
          // gh api PATCH
          return mockSpawnResult('', 0);
        }
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/10');
      expect(result.identifier).toBe('10');

      // Verify gh api POST was NOT called (no new PR)
      expect(spawnMock).not.toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['repos/{owner}/{repo}/pulls', '--method', 'POST']),
        expect.anything(),
      );

      // Verify gh api PATCH was called to update the title
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/{owner}/{repo}/pulls/10', '--method', 'PATCH', '-f', 'title=Test PR'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('passes body to gh api POST when creating new PR', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) return mockSpawnResult('', 0);
        else if (callCount === 2) return mockSpawnResult('[]', 0);
        else return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/43","number":43}', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/summary',
        title: 'PR with body',
        cwd: '/tmp/repo',
        body: '## Summary\nTest body',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/{owner}/{repo}/pulls', '--method', 'POST', '-f', 'base=main', '-f', 'head=feature/summary', '-f', 'title=PR with body', '-f', 'body=## Summary\nTest body'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('uses empty body when body is omitted', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) return mockSpawnResult('', 0);
        else if (callCount === 2) return mockSpawnResult('[]', 0);
        else return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/44","number":44}', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/no-body',
        title: 'PR without body',
        cwd: '/tmp/repo',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/{owner}/{repo}/pulls', '--method', 'POST', '-f', 'base=main', '-f', 'head=feature/no-body', '-f', 'title=PR without body', '-f', 'body='],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('passes body when updating existing PR via REST PATCH', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) return mockSpawnResult('', 0);
        else if (callCount === 2) return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/10","number":10}]', 0);
        else return mockSpawnResult('', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/update-body',
        title: 'Updated PR',
        cwd: '/tmp/repo',
        body: 'Updated body text',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/{owner}/{repo}/pulls/10', '--method', 'PATCH', '-f', 'title=Updated PR', '-f', 'body=Updated body text'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });
  });

  describe('checkApproval', () => {
    it('returns approved when reviewDecision is APPROVED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      const jsonResponse = JSON.stringify({
        state: 'OPEN',
        reviewDecision: 'APPROVED',
        url: 'https://github.com/owner/repo/pull/42',
      });

      spawnMock.mockReturnValue(mockSpawnResult(jsonResponse, 0) as any);

      const result = await provider.checkApproval({
        identifier: '42',
        cwd: '/tmp/repo',
      });

      expect(result.approved).toBe(true);
      expect(result.rejected).toBe(false);
      expect(result.statusText).toBe('Approved');
      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
    });

    it('returns rejected when reviewDecision is CHANGES_REQUESTED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      const jsonResponse = JSON.stringify({
        state: 'OPEN',
        reviewDecision: 'CHANGES_REQUESTED',
        url: 'https://github.com/owner/repo/pull/42',
      });

      spawnMock.mockReturnValue(mockSpawnResult(jsonResponse, 0) as any);

      const result = await provider.checkApproval({
        identifier: '42',
        cwd: '/tmp/repo',
      });

      expect(result.approved).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.statusText).toBe('Changes requested');
      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
    });

    it('returns rejected when state is CLOSED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      const jsonResponse = JSON.stringify({
        state: 'CLOSED',
        reviewDecision: '',
        url: 'https://github.com/owner/repo/pull/42',
      });

      spawnMock.mockReturnValue(mockSpawnResult(jsonResponse, 0) as any);

      const result = await provider.checkApproval({
        identifier: '42',
        cwd: '/tmp/repo',
      });

      expect(result.approved).toBe(false);
      expect(result.rejected).toBe(true);
      expect(result.statusText).toBe('Closed');
      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
    });

    it('returns approved when state is MERGED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      const jsonResponse = JSON.stringify({
        state: 'MERGED',
        reviewDecision: null,
        url: 'https://github.com/owner/repo/pull/42',
      });

      spawnMock.mockReturnValue(mockSpawnResult(jsonResponse, 0) as any);

      const result = await provider.checkApproval({
        identifier: '42',
        cwd: '/tmp/repo',
      });

      expect(result.approved).toBe(true);
      expect(result.rejected).toBe(false);
      expect(result.statusText).toBe('Merged');
      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
    });

    it('returns awaiting when no decision yet', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      const jsonResponse = JSON.stringify({
        state: 'OPEN',
        reviewDecision: '',
        url: 'https://github.com/owner/repo/pull/42',
      });

      spawnMock.mockReturnValue(mockSpawnResult(jsonResponse, 0) as any);

      const result = await provider.checkApproval({
        identifier: '42',
        cwd: '/tmp/repo',
      });

      expect(result.approved).toBe(false);
      expect(result.rejected).toBe(false);
      expect(result.statusText).toBe('Awaiting review');
      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
    });
  });

  describe('regression guard', () => {
    it('never uses gh pr edit or gh pr create subcommands', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      // Scenario 1: create new PR (no existing)
      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) return mockSpawnResult('', 0); // git push
        else if (callCount === 2) return mockSpawnResult('[]', 0); // gh pr list
        else return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/99","number":99}', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/guard-new',
        title: 'Guard test',
        cwd: '/tmp/repo',
      });

      // Scenario 2: update existing PR
      callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) return mockSpawnResult('', 0); // git push
        else if (callCount === 2) return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/5","number":5}]', 0);
        else return mockSpawnResult('', 0); // PATCH
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/guard-existing',
        title: 'Guard test existing',
        cwd: '/tmp/repo',
      });

      // Assert deprecated subcommands were never called
      const allCalls = spawnMock.mock.calls;
      for (const [cmd, args] of allCalls) {
        if (cmd === 'gh') {
          expect(args).not.toEqual(expect.arrayContaining(['pr', 'create']));
          expect(args).not.toEqual(expect.arrayContaining(['pr', 'edit']));
        }
      }
    });
  });
});
