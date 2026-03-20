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
        } else {
          // gh pr create
          return mockSpawnResult('https://github.com/owner/repo/pull/42', 0);
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

      // Verify gh pr create was called
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['pr', 'create', '--base', 'main', '--head', 'feature/test', '--title', 'Test PR', '--body', ''],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('passes body to gh pr create', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation((() => {
        callCount++;
        if (callCount === 1) return mockSpawnResult('', 0);
        else return mockSpawnResult('https://github.com/owner/repo/pull/43', 0);
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
        ['pr', 'create', '--base', 'main', '--head', 'feature/summary', '--title', 'PR with body', '--body', '## Summary\nTest body'],
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
        else return mockSpawnResult('https://github.com/owner/repo/pull/44', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/no-body',
        title: 'PR without body',
        cwd: '/tmp/repo',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['pr', 'create', '--base', 'main', '--head', 'feature/no-body', '--title', 'PR without body', '--body', ''],
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
});
