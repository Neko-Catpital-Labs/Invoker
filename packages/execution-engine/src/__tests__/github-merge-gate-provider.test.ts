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

describe('GitHubMergeGateProvider', () => {
  let provider: GitHubMergeGateProvider;

  beforeEach(() => {
    provider = new GitHubMergeGateProvider();
    vi.clearAllMocks();
  });

  describe('createReview', () => {
    it('targets upstream repository when creating merge-gate PRs', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/42","number":42}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/Neko-Catpital-Labs/Invoker/pull/42');
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'pr', 'list',
          '--repo', 'Neko-Catpital-Labs/Invoker',
          '--head', 'feature/test',
          '--base', 'master',
          '--state', 'open',
          '--json', 'url,number',
          '--limit', '1',
        ],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'api', 'repos/Neko-Catpital-Labs/Invoker/pulls',
          '--method', 'POST',
          '-f', 'base=master',
          '-f', 'head=feature/test',
          '-f', 'title=Test PR',
          '-f', 'body=',
        ],
        expect.anything(),
      );
    });

    it('pushes branch to origin and creates a PR against the normalized base branch', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        const args = _args;
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return mockSpawnResult('[]', 0);
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
          '--repo', 'owner/repo',
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
          'api', 'repos/owner/repo/pulls',
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

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
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
        ['api', 'repos/owner/repo/pulls/10', '--method', 'PATCH', '-f', 'title=Updated PR', '-f', 'body=## Summary'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });
  });
});
