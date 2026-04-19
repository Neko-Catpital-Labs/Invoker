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
    if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
    child.emit('close', exitCode);
  }, 0);

  return child;
}

function mockSpawnResultWithStderr(stdoutData: string, stderrData: string, exitCode: number) {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;

  setTimeout(() => {
    if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) stderr.emit('data', Buffer.from(stderrData));
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
    it('pushes branch to origin and creates a PR against the normalized base branch', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        if (cmd === 'git') return mockSpawnResult('', 0);
        if ((spawnMock.mock.calls.length ?? 0) === 2) return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/42","number":42}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'origin/main',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(result.identifier).toBe('42');
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['push', '--force', '-u', 'origin', 'feature/test'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'pr', 'list',
          '--head', 'feature/test',
          '--base', 'main',
          '--state', 'open',
          '--json', 'url,number',
          '--limit', '1',
        ],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'api', 'repos/{owner}/{repo}/pulls',
          '--method', 'POST',
          '-f', 'base=main',
          '-f', 'head=feature/test',
          '-f', 'title=Test PR',
          '-f', 'body=',
        ],
        expect.anything(),
      );
    });

    it('reuses an existing open PR instead of creating a new one', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation(((cmd: string) => {
        callCount += 1;
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (callCount === 2) {
          return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/10","number":10}]', 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Updated PR',
        cwd: '/tmp/repo',
        body: '## Summary',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/10');
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        ['api', 'repos/{owner}/{repo}/pulls/10', '--method', 'PATCH', '-f', 'title=Updated PR', '-f', 'body=## Summary'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('continues when branch push loses a cannot-lock-ref race but the remote already has equivalent content', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      let callCount = 0;
      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        callCount += 1;
        if (cmd === 'git' && args[0] === 'push') {
          return mockSpawnResultWithStderr(
            '',
            "To https://github.com/owner/repo\n ! [remote rejected] feature/test -> feature/test (cannot lock ref 'refs/heads/feature/test': is at aaa111 but expected bbb222)\n",
            1,
          );
        }
        if (cmd === 'git' && args[0] === 'fetch') return mockSpawnResult('', 0);
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD^{tree}') return mockSpawnResult('same-tree\n', 0);
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'refs/remotes/origin/feature/test^{tree}') return mockSpawnResult('same-tree\n', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/42","number":42}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Race-safe PR',
        cwd: '/tmp/repo',
      });

      expect(result.identifier).toBe('42');
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', '+refs/heads/feature/test:refs/remotes/origin/feature/test'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });
  });
});
