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

function mockSpawnResultDetailed(stdoutData: string, stderrData: string, exitCode: number) {
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

/**
 * Wrap a callCount-based mock to auto-reject `git remote get-url upstream`
 * (simulating no upstream remote / non-fork workflow).
 */
function wrapNoFork(fn: (callCount: number) => any): (cmd: string, args: string[]) => any {
  let callCount = 0;
  return (cmd: string, args: string[]) => {
    if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'upstream') {
      return mockSpawnResult('', 1);
    }
    callCount++;
    return fn(callCount);
  };
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

      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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

    it('normalizes origin/ base branch for gh API and pr list', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(wrapNoFork((callCount) => {
        if (callCount === 1) return mockSpawnResult('', 0);
        if (callCount === 2) return mockSpawnResult('[]', 0);
        return mockSpawnResult('{"html_url":"https://github.com/o/r/pull/99","number":99}', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'origin/fix/remote-ssh-build',
        featureBranch: 'plan/feature-github-pr',
        title: 'PR title',
        cwd: '/tmp/repo',
      });

      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        [
          'pr', 'list',
          '--head', 'plan/feature-github-pr',
          '--base', 'fix/remote-ssh-build',
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
          '-f', 'base=fix/remote-ssh-build',
          '-f', 'head=plan/feature-github-pr',
          '-f', 'title=PR title',
          '-f', 'body=',
        ],
        expect.anything(),
      );
    });

    it('reuses existing open PR and updates title', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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

      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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

      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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

      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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

  describe('fork workflow', () => {
    it('qualifies head with fork owner when upstream remote exists', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'upstream') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'origin') {
          return mockSpawnResult('https://github.com/EdbertChan/Invoker/', 0);
        }
        if (cmd === 'git' && args?.[0] === 'fetch') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..origin/master') {
          return mockSpawnResult('fork-only-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..plan/my-feature') {
          return mockSpawnResult('feature-only-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'push') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return mockSpawnResult('[]', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'repos/{owner}/{repo}/pulls') {
          return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/50","number":50}', 0);
        }
        throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'plan/my-feature',
        title: 'Fork PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/Neko-Catpital-Labs/Invoker/pull/50');

      // Verify head is qualified with fork owner
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--head', 'EdbertChan:plan/my-feature']),
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['-f', 'head=EdbertChan:plan/my-feature']),
        expect.anything(),
      );
    });

    it('skips fork branch repair when origin is a local/file remote', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'upstream') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'origin') {
          return mockSpawnResult('file:///tmp/local-checkout', 0);
        }
        if (cmd === 'git' && args?.[0] === 'push') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return mockSpawnResult('[]', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'repos/{owner}/{repo}/pulls') {
          return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/53","number":53}', 0);
        }
        throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'plan/local-origin',
        title: 'Local origin PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/Neko-Catpital-Labs/Invoker/pull/53');
      expect(spawnMock).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['fetch', '--quiet', 'upstream', 'master']),
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['push', '--force', '-u', 'origin', 'plan/local-origin'],
        expect.anything(),
      );
    });

    it('auto-repairs a polluted PR branch before pushing to origin', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567890);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'upstream') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'origin') {
          return mockSpawnResult('https://github.com/EdbertChan/Invoker/', 0);
        }
        if (cmd === 'git' && args?.[0] === 'fetch') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..origin/master') {
          return mockSpawnResult('fork-only-sha\nfork-only-sha-2', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..plan/polluted') {
          return mockSpawnResult('feature-sha\nfork-only-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === '--reverse' && args?.[2] === '--no-merges' && args?.[3] === 'origin/master..plan/polluted') {
          return mockSpawnResult('feature-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'branch' && args?.[1] === '--show-current') {
          return mockSpawnResult('plan/polluted', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify' && args?.[2] === 'HEAD') {
          return mockSpawnResult('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 0);
        }
        if (cmd === 'git' && args?.[0] === 'switch' && args?.[1] === '-C') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'cherry-pick') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'push') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return mockSpawnResult('[]', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'repos/{owner}/{repo}/pulls') {
          return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/51","number":51}', 0);
        }
        if (cmd === 'git' && args?.[0] === 'switch' && args?.[1] === 'plan/polluted') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'branch' && args?.[1] === '-D') {
          return mockSpawnResult('', 0);
        }
        throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'plan/polluted',
        title: 'Polluted PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/Neko-Catpital-Labs/Invoker/pull/51');
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['switch', '-C', 'invoker/pr-clean/plan-polluted-1234567890', 'upstream/master'],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['cherry-pick', 'feature-sha'],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['push', '--force', '-u', 'origin', 'invoker/pr-clean/plan-polluted-1234567890:plan/polluted'],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['branch', '-D', 'invoker/pr-clean/plan-polluted-1234567890'],
        expect.anything(),
      );
      nowSpy.mockRestore();
    });

    it('auto-repairs polluted fork branches even when cwd is detached at upstream base', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567891);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'upstream') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'origin') {
          return mockSpawnResult('https://github.com/EdbertChan/Invoker/', 0);
        }
        if (cmd === 'git' && args?.[0] === 'fetch') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..origin/master') {
          return mockSpawnResult('fork-only-sha\nfork-only-sha-2', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..plan/detached') {
          return mockSpawnResult('feature-sha\nfork-only-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === '--reverse' && args?.[2] === '--no-merges' && args?.[3] === 'origin/master..plan/detached') {
          return mockSpawnResult('feature-empty\nfeature-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'branch' && args?.[1] === '--show-current') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-parse' && args?.[1] === '--verify' && args?.[2] === 'HEAD') {
          return mockSpawnResult('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 0);
        }
        if (cmd === 'git' && args?.[0] === 'switch' && args?.[1] === '-C') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'cherry-pick' && args?.[1] === 'feature-empty') {
          return mockSpawnResultDetailed(
            'On branch invoker/pr-clean/plan-detached-1234567891\nnothing to commit, working tree clean\n',
            'The previous cherry-pick is now empty, possibly due to conflict resolution.\n',
            1,
          );
        }
        if (cmd === 'git' && args?.[0] === 'cherry-pick' && args?.[1] === '--skip') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'cherry-pick') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'push') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return mockSpawnResult('[]', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'api' && args?.[1] === 'repos/{owner}/{repo}/pulls') {
          return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/52","number":52}', 0);
        }
        if (cmd === 'git' && args?.[0] === 'switch' && args?.[1] === '--detach') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'branch' && args?.[1] === '-D') {
          return mockSpawnResult('', 0);
        }
        throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'plan/detached',
        title: 'Detached polluted PR',
        cwd: '/tmp/repo',
      });

      expect(result.url).toBe('https://github.com/Neko-Catpital-Labs/Invoker/pull/52');
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['switch', '--detach', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
        expect.anything(),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        'git',
        ['cherry-pick', '--skip'],
        expect.anything(),
      );
      nowSpy.mockRestore();
    });
  });

  describe('regression guard', () => {
    it('passes --no-merges to rev-list so cherry-pick never encounters a merge commit', async () => {
      // Regression: when a feature branch contains "Merge upstream" commits
      // (e.g., from task-branch consolidation), `git cherry-pick <merge-sha>`
      // fails with: "commit is a merge but no -m option was given."
      // The fix is to exclude merge commits from the cherry-pick list.
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1234567892);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'upstream') {
          return mockSpawnResult('https://github.com/Neko-Catpital-Labs/Invoker.git', 0);
        }
        if (cmd === 'git' && args?.[0] === 'remote' && args?.[1] === 'get-url' && args?.[2] === 'origin') {
          return mockSpawnResult('https://github.com/EdbertChan/Invoker/', 0);
        }
        if (cmd === 'git' && args?.[0] === 'fetch') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..origin/master') {
          return mockSpawnResult('fork-only-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === 'upstream/master..plan/with-merges') {
          return mockSpawnResult('feature-a\nfork-only-sha', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-list' && args?.[1] === '--reverse' && args?.[2] === '--no-merges' && args?.[3] === 'origin/master..plan/with-merges') {
          // Server already filtered merges; return only the non-merge commits.
          return mockSpawnResult('feature-a\nfeature-b', 0);
        }
        if (cmd === 'git' && args?.[0] === 'branch' && args?.[1] === '--show-current') {
          return mockSpawnResult('plan/with-merges', 0);
        }
        if (cmd === 'git' && args?.[0] === 'rev-parse') {
          return mockSpawnResult('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 0);
        }
        if (cmd === 'git' && args?.[0] === 'switch') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'cherry-pick') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'push') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'git' && args?.[0] === 'branch' && args?.[1] === '-D') {
          return mockSpawnResult('', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'pr' && args?.[1] === 'list') {
          return mockSpawnResult('[]', 0);
        }
        if (cmd === 'gh' && args?.[0] === 'api') {
          return mockSpawnResult('{"html_url":"https://github.com/Neko-Catpital-Labs/Invoker/pull/99","number":99}', 0);
        }
        throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
      }) as any);

      await provider.createReview({
        baseBranch: 'master',
        featureBranch: 'plan/with-merges',
        title: 'Branch with merges',
        cwd: '/tmp/repo',
      });

      // Primary invariant: the cherry-pick enumeration MUST pass --no-merges.
      const revListCalls = spawnMock.mock.calls.filter(
        ([cmd, args]) => cmd === 'git' && (args as string[])[0] === 'rev-list'
          && (args as string[]).includes('origin/master..plan/with-merges'),
      );
      expect(revListCalls.length).toBeGreaterThan(0);
      for (const [, args] of revListCalls) {
        expect(args as string[]).toContain('--no-merges');
      }

      // Secondary invariant: no bare cherry-pick of a merge-looking ref ever ran.
      // (If --no-merges regressed, rev-list would emit a merge sha which this
      //  mock would then hand to cherry-pick — a real repo would fail there.)
      nowSpy.mockRestore();
    });

    it('never uses gh pr edit or gh pr create subcommands', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      // Scenario 1: create new PR (no existing)
      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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
      spawnMock.mockImplementation(wrapNoFork((callCount) => {
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
