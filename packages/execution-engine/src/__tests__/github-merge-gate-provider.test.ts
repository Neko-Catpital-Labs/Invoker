import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';

vi.mock('node:child_process');

function mockSpawnResult(stdoutData: string, exitCode: number, stderrData = '') {
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
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    provider = new GitHubMergeGateProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('updateReviewBody', () => {
    it('updates the PR body through a temporary body file', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      await provider.updateReviewBody({
        identifier: '42',
        cwd: '/tmp/repo',
        body: '## Summary\n\nUpdated body',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'pr', 'edit', '42',
          '--repo', 'owner/repo',
          '--body-file', expect.stringContaining('body.md'),
        ],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });
  });

  describe('createReview', () => {
    it('targets origin repository when creating merge-gate PRs', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/Neko-Catpital-Labs/Invoker/pulls' && args.includes('--method') && args.includes('GET')) return mockSpawnResult('[]', 0);
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
          'api', 'repos/Neko-Catpital-Labs/Invoker/pulls',
          '--method', 'GET',
          '-f', 'state=open',
          '-f', 'head=Neko-Catpital-Labs:feature/test',
          '-f', 'per_page=1',
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

    it('pushes branch to origin and creates a PR against normalized base branch', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        const args = _args;
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('--method') && args.includes('GET')) return mockSpawnResult('[]', 0);
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
        ['push', '--force', 'origin', 'feature/test:refs/heads/feature/test'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'api', 'repos/owner/repo/pulls',
          '--method', 'GET',
          '-f', 'state=open',
          '-f', 'head=owner:feature/test',
          '-f', 'per_page=1',
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

    it('retries branch push after GitHub reports a ref lock already-exists race', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);
      let pushAttempts = 0;

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        const args = _args;
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git' && args[0] === 'push') {
          pushAttempts++;
          if (pushAttempts === 1) {
            return mockSpawnResult('', 1, [
              'To github.com:owner/repo.git',
              " ! [remote rejected] feature/test -> feature/test (cannot lock ref 'refs/heads/feature/test': reference already exists)",
              "error: failed to push some refs to 'github.com:owner/repo.git'",
            ].join('\n'));
          }
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args[0] === 'fetch') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('--method') && args.includes('GET')) return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/42","number":42}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(pushAttempts).toBe(2);
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', '+refs/heads/feature/test:refs/remotes/origin/feature/test'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('retries branch push after GitHub reports a stale expected-sha ref lock race', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);
      let pushAttempts = 0;

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        const args = _args;
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git' && args[0] === 'push') {
          pushAttempts++;
          if (pushAttempts === 1) {
            return mockSpawnResult('', 1, [
              'To github.com:owner/repo.git',
              " ! [remote rejected] feature/test -> feature/test (cannot lock ref 'refs/heads/feature/test': is at 1111111 but expected 2222222)",
              "error: failed to push some refs to 'github.com:owner/repo.git'",
            ].join('\n'));
          }
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args[0] === 'fetch') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('--method') && args.includes('GET')) return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/42","number":42}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(pushAttempts).toBe(2);
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin', '+refs/heads/feature/test:refs/remotes/origin/feature/test'],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('retries transient REST PR lookup failures before creating a PR', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);
      let lookupAttempts = 0;

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        const args = _args;
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('--method') && args.includes('GET')) {
          lookupAttempts++;
          if (lookupAttempts === 1) {
            return mockSpawnResult('', 1, 'Post "https://api.github.com/graphql": dial tcp: i/o timeout');
          }
          return mockSpawnResult('[]', 0);
        }
        return mockSpawnResult('{"html_url":"https://github.com/owner/repo/pull/42","number":42}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/test',
        title: 'Test PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      expect(lookupAttempts).toBe(2);
    });

    it('reuses an existing open PR by head and retargets its base', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('--method') && args.includes('GET')) {
          return mockSpawnResult('[{"html_url":"https://github.com/owner/repo/pull/10","number":10}]', 0);
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
        [
          'api', 'repos/owner/repo/pulls/10',
          '--method', 'PATCH',
          '-f', 'base=main',
          '-f', 'title=Updated PR',
          '-f', 'body=## Summary',
        ],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('falls back to REST when gh pr list is unavailable', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return mockSpawnResult('', 1, 'GraphQL: API rate limit already exceeded');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/owner/repo/pulls' && args.includes('--method') && args.includes('GET')) {
          return mockSpawnResult('[{"html_url":"https://github.com/owner/repo/pull/11","number":11}]', 0);
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

      expect(result).toEqual({
        url: 'https://github.com/owner/repo/pull/11',
        identifier: '11',
      });
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'api', 'repos/owner/repo/pulls',
          '--method', 'GET',
          '-f', 'state=open',
          '-f', 'head=owner:feature/test',
          '-f', 'per_page=1',
        ],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'api', 'repos/owner/repo/pulls/11',
          '--method', 'PATCH',
          '-f', 'base=main',
          '-f', 'title=Updated PR',
          '-f', 'body=## Summary',
        ],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });

    it('uses explicit target repo from environment when provided', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'Neko-Catpital-Labs/Invoker';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          throw new Error('remote lookup should not run when env target is set');
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          throw new Error('gh pr list should not be used');
        }
        if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/Neko-Catpital-Labs/Invoker/pulls' && args.includes('--method') && args.includes('GET')) return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/99","number":99}', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'feature/test',
        title: 'Env target PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/Neko-Catpital-Labs/Invoker/pull/99');
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['api', 'repos/Neko-Catpital-Labs/Invoker/pulls']),
        expect.anything(),
      );
    });

    it('fails clearly when target repo cannot be resolved from env or remotes', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          return mockSpawnResult('/tmp/local/path/repo.git', 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      await expect(provider.createReview({
        baseBranch: 'master',
        featureBranch: 'feature/test',
        title: 'Missing target',
        cwd: '/tmp/repo',
      })).rejects.toThrow('Unable to resolve GitHub target repo.');
    });

    it('does not fall back to upstream when origin is missing', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
          return mockSpawnResult('', 1);
        }
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      await expect(provider.createReview({
        baseBranch: 'master',
        featureBranch: 'feature/test',
        title: 'Missing origin',
        cwd: '/tmp/repo',
      })).rejects.toThrow('parseable origin GitHub remote');
    });
  });

  describe('closeReview', () => {
    it('closes the owning PR without deleting the branch', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') return mockSpawnResult('{}', 0);
        return mockSpawnResult('', 0);
      }) as any);

      await provider.closeReview({ identifier: '42', cwd: '/tmp/repo' });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'api', 'repos/owner/repo/pulls/42',
          '--method', 'PATCH',
          '-f', 'state=closed',
        ],
        expect.objectContaining({ cwd: '/tmp/repo' }),
      );
    });
  });

  describe('checkApproval', () => {
    it('treats a merged PR as approved with statusText "Merged"', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'MERGED',
            reviewDecision: 'APPROVED',
            url: 'https://github.com/owner/repo/pull/1',
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '1', cwd: '/tmp/repo' });

      expect(result.lifecycle).toBe('merged');
      expect(result.rejected).toBe(false);
      expect(result.statusText).toBe('Merged');
    });

    it('treats an open approved PR as non-terminal with statusText "Approved, awaiting merge"', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'OPEN',
            reviewDecision: 'APPROVED',
            url: 'https://github.com/owner/repo/pull/2',
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '2', cwd: '/tmp/repo' });

      expect(result.lifecycle).toBe('open');
      expect(result.rejected).toBe(false);
      expect(result.statusText).toBe('Approved, awaiting merge');
    });

    it('treats a closed non-merged PR as terminal with statusText "Closed"', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'CLOSED',
            reviewDecision: null,
            url: 'https://github.com/owner/repo/pull/3',
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '3', cwd: '/tmp/repo' });

      expect(result.lifecycle).toBe('closed');
      expect(result.rejected).toBe(false);
      expect(result.statusText).toBe('Closed');
    });

    it('returns PR head metadata and failed checks for review-gate auto-fix', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'OPEN',
            reviewDecision: null,
            url: 'https://github.com/owner/repo/pull/4',
            headRefOid: 'abc123',
            headRefName: 'feature/red-ci',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [
              {
                __typename: 'StatusContext',
                context: 'invoker/fake-ci',
                state: 'FAILURE',
                targetUrl: 'https://github.com/owner/repo/pull/4',
                description: 'Fixture failed',
              },
              {
                name: 'test-all',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/1',
                summary: 'Tests failed',
              },
              {
                name: 'lint',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
              },
            ],
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '4', cwd: '/tmp/repo' });

      expect(result.headSha).toBe('abc123');
      expect(result.headRef).toBe('feature/red-ci');
      expect(result.mergeState).toBe('clean');
      expect(result.hasMergeConflict).toBe(false);
      expect(result.checks).toEqual({
        state: 'failure',
        failed: [
          {
            name: 'invoker/fake-ci',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/owner/repo/pull/4',
            summary: 'Fixture failed',
          },
          {
            name: 'test-all',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/owner/repo/actions/runs/1',
            summary: 'Tests failed',
          },
        ],
      });
    });

    it('uses only the latest check run per name from historical statusCheckRollup', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'OPEN',
            reviewDecision: 'APPROVED',
            url: 'https://github.com/owner/repo/pull/4583',
            headRefOid: 'headsha',
            headRefName: 'stack/ui-responsiveness',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [
              {
                name: 'PR Body',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                completedAt: '2026-07-15T04:02:25Z',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/1',
              },
              {
                name: 'PR Body',
                status: 'COMPLETED',
                conclusion: 'CANCELLED',
                completedAt: '2026-07-15T05:00:00Z',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/2',
              },
              {
                name: 'PR Body',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                completedAt: '2026-07-15T06:00:00Z',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/3',
              },
              {
                name: 'PR Body',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                completedAt: '2026-07-15T09:10:14Z',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/4',
              },
              {
                name: 'quality / TypeScript Types',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                completedAt: '2026-07-15T09:11:00Z',
              },
            ],
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '4583', cwd: '/tmp/repo' });

      expect(result.checks).toEqual({ state: 'success', failed: [] });
    });

    it('reports failure from the latest check when older runs of the same name succeeded', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'OPEN',
            reviewDecision: null,
            url: 'https://github.com/owner/repo/pull/9',
            headRefOid: 'headsha',
            headRefName: 'feature/regressed',
            mergeStateStatus: 'CLEAN',
            statusCheckRollup: [
              {
                name: 'PR Body',
                status: 'COMPLETED',
                conclusion: 'SUCCESS',
                completedAt: '2026-07-15T01:00:00Z',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/old',
              },
              {
                name: 'PR Body',
                status: 'COMPLETED',
                conclusion: 'FAILURE',
                completedAt: '2026-07-15T09:00:00Z',
                detailsUrl: 'https://github.com/owner/repo/actions/runs/new',
                summary: 'Body invalid',
              },
            ],
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '9', cwd: '/tmp/repo' });

      expect(result.checks).toEqual({
        state: 'failure',
        failed: [
          {
            name: 'PR Body',
            conclusion: 'FAILURE',
            detailsUrl: 'https://github.com/owner/repo/actions/runs/new',
            summary: 'Body invalid',
          },
        ],
      });
    });

    it('marks only DIRTY merge state as a merge conflict signal', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'OPEN',
            reviewDecision: null,
            url: 'https://github.com/owner/repo/pull/5',
            headRefOid: 'dirty123',
            headRefName: 'feature/conflict',
            mergeStateStatus: 'DIRTY',
            statusCheckRollup: [],
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '5', cwd: '/tmp/repo' });

      expect(result.mergeState).toBe('dirty');
      expect(result.hasMergeConflict).toBe(true);
    });

    it('does not treat BEHIND merge state as a merge conflict signal', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'owner/repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string) => {
        if (cmd === 'gh') {
          return mockSpawnResult(JSON.stringify({
            state: 'OPEN',
            reviewDecision: null,
            url: 'https://github.com/owner/repo/pull/6',
            headRefOid: 'behind123',
            headRefName: 'feature/behind',
            mergeStateStatus: 'BEHIND',
            statusCheckRollup: [],
          }), 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.checkApproval({ identifier: '6', cwd: '/tmp/repo' });

      expect(result.mergeState).toBe('dirty');
      expect(result.hasMergeConflict).toBe(false);
    });
  });
});
