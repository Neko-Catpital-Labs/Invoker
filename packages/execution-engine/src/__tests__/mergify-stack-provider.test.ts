import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MergifyStackProvider } from '../mergify-stack-provider.js';

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

function mockSpawnError(errorMsg: string) {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;

  setTimeout(() => {
    stderr.emit('data', Buffer.from(errorMsg));
    child.emit('close', 1);
  }, 0);

  return child;
}

function mockSpawnENOENT() {
  const { EventEmitter } = require('events');
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter();
  (child as any).stdout = stdout;
  (child as any).stderr = stderr;

  setTimeout(() => {
    child.emit('error', Object.assign(new Error('spawn mergify ENOENT'), { code: 'ENOENT' }));
  }, 0);

  return child;
}

describe('MergifyStackProvider', () => {
  let provider: MergifyStackProvider;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    provider = new MergifyStackProvider();
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.useRealTimers();
  });

  it('has name "mergify_stack"', () => {
    expect(provider.name).toBe('mergify_stack');
  });

  describe('createReview', () => {
    it('runs mergify stack push, resolves PR, and patches title/body', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git' && args[0] === 'checkout') return mockSpawnResult('', 0);
        if (cmd === 'mergify' && args[0] === 'stack' && args[1] === 'push') {
          return mockSpawnResult('Stack pushed', 0);
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/7","number":7}]', 0);
        }
        if (cmd === 'gh' && args[0] === 'api') return mockSpawnResult('{}', 0);
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feature/stack-test',
        title: 'Stack PR',
        cwd: '/tmp/gate',
        body: '## Details',
      });

      expect(result.url).toBe('https://github.com/owner/repo/pull/7');
      expect(result.identifier).toBe('7');

      // Verify git checkout was called.
      expect(spawnMock).toHaveBeenCalledWith(
        'git', ['checkout', 'feature/stack-test'],
        expect.objectContaining({ cwd: '/tmp/gate' }),
      );

      // Verify mergify stack push was called.
      expect(spawnMock).toHaveBeenCalledWith(
        'mergify', ['stack', 'push'],
        expect.objectContaining({ cwd: '/tmp/gate' }),
      );

      // Verify gh pr list was called with the normalized head.
      expect(spawnMock).toHaveBeenCalledWith(
        'gh', [
          'pr', 'list',
          '--repo', 'owner/repo',
          '--head', 'feature/stack-test',
          '--state', 'open',
          '--json', 'url,number',
          '--limit', '1',
        ],
        expect.anything(),
      );

      // Verify title/body patch was called.
      expect(spawnMock).toHaveBeenCalledWith(
        'gh', [
          'api', 'repos/owner/repo/pulls/7',
          '--method', 'PATCH',
          '-f', 'title=Stack PR',
          '-f', 'body=## Details',
        ],
        expect.anything(),
      );
    });

    it('uses explicit target repo from environment', async () => {
      process.env.INVOKER_GITHUB_TARGET_REPO = 'org/my-repo';
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          throw new Error('should not call git remote when env is set');
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'mergify') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return mockSpawnResult('[{"url":"https://github.com/org/my-repo/pull/1","number":1}]', 0);
        }
        if (cmd === 'gh' && args[0] === 'api') return mockSpawnResult('{}', 0);
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feat/x',
        title: 'T',
        cwd: '/tmp/gate',
      });

      expect(result.url).toBe('https://github.com/org/my-repo/pull/1');
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--repo', 'org/my-repo']),
        expect.anything(),
      );
    });

    it('throws clear error when mergify CLI is not installed (ENOENT)', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'mergify') return mockSpawnENOENT();
        return mockSpawnResult('', 0);
      }) as any);

      await expect(provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feat/x',
        title: 'T',
        cwd: '/tmp/gate',
      })).rejects.toThrow('Mergify CLI is not installed or not in PATH');
    });

    it('throws when mergify stack push fails with non-ENOENT error', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, _args: string[]) => {
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'mergify') return mockSpawnError('authentication failed');
        return mockSpawnResult('', 0);
      }) as any);

      await expect(provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feat/x',
        title: 'T',
        cwd: '/tmp/gate',
      })).rejects.toThrow('mergify stack push failed');
    });

    it('throws when no PR is found after stack push (both attempts)', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'mergify') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return mockSpawnResult('[]', 0);
        }
        return mockSpawnResult('', 0);
      }) as any);

      await expect(provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feat/missing',
        title: 'T',
        cwd: '/tmp/gate',
      })).rejects.toThrow('No open PR found for head "feat/missing"');
    });

    it('normalizes remote-tracking refs for head branch', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'mergify') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/3","number":3}]', 0);
        }
        if (cmd === 'gh' && args[0] === 'api') return mockSpawnResult('{}', 0);
        return mockSpawnResult('', 0);
      }) as any);

      const result = await provider.createReview({
        baseBranch: 'origin/main',
        featureBranch: 'origin/feature/stack',
        title: 'Stack',
        cwd: '/tmp/gate',
      });

      expect(result.identifier).toBe('3');
      // The head passed to gh pr list should be normalized (no origin/ prefix).
      expect(spawnMock).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['--head', 'feature/stack']),
        expect.anything(),
      );
    });

    it('omits body from PATCH when no body is provided', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'git') return mockSpawnResult('', 0);
        if (cmd === 'mergify') return mockSpawnResult('', 0);
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          return mockSpawnResult('[{"url":"https://github.com/owner/repo/pull/5","number":5}]', 0);
        }
        if (cmd === 'gh' && args[0] === 'api') return mockSpawnResult('{}', 0);
        return mockSpawnResult('', 0);
      }) as any);

      await provider.createReview({
        baseBranch: 'main',
        featureBranch: 'feat/no-body',
        title: 'No Body',
        cwd: '/tmp/gate',
      });

      // PATCH args should NOT contain body.
      const patchCall = spawnMock.mock.calls.find(
        ([cmd, args]) => cmd === 'gh' && (args as string[])[0] === 'api',
      );
      expect(patchCall).toBeDefined();
      const patchArgs = patchCall![1] as string[];
      expect(patchArgs).not.toContain('body=');
      expect(patchArgs.filter(a => (a as string).startsWith('body='))).toHaveLength(0);
    });
  });

  describe('checkApproval', () => {
    it('reports approved when reviewDecision is APPROVED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'gh') {
          return mockSpawnResult(
            JSON.stringify({ state: 'OPEN', reviewDecision: 'APPROVED', url: 'https://github.com/owner/repo/pull/7' }),
            0,
          );
        }
        return mockSpawnResult('', 0);
      }) as any);

      const status = await provider.checkApproval({ identifier: '7', cwd: '/tmp/gate' });
      expect(status.approved).toBe(true);
      expect(status.rejected).toBe(false);
      expect(status.statusText).toBe('Approved');
      expect(status.url).toBe('https://github.com/owner/repo/pull/7');
    });

    it('reports approved when state is MERGED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'gh') {
          return mockSpawnResult(
            JSON.stringify({ state: 'MERGED', reviewDecision: null, url: 'https://github.com/owner/repo/pull/7' }),
            0,
          );
        }
        return mockSpawnResult('', 0);
      }) as any);

      const status = await provider.checkApproval({ identifier: '7', cwd: '/tmp/gate' });
      expect(status.approved).toBe(true);
      expect(status.statusText).toBe('Merged');
    });

    it('reports rejected when state is CLOSED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'gh') {
          return mockSpawnResult(
            JSON.stringify({ state: 'CLOSED', reviewDecision: null, url: 'https://github.com/owner/repo/pull/7' }),
            0,
          );
        }
        return mockSpawnResult('', 0);
      }) as any);

      const status = await provider.checkApproval({ identifier: '7', cwd: '/tmp/gate' });
      expect(status.approved).toBe(false);
      expect(status.rejected).toBe(true);
      expect(status.statusText).toBe('Closed');
    });

    it('reports rejected when reviewDecision is CHANGES_REQUESTED', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'gh') {
          return mockSpawnResult(
            JSON.stringify({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', url: 'https://github.com/owner/repo/pull/7' }),
            0,
          );
        }
        return mockSpawnResult('', 0);
      }) as any);

      const status = await provider.checkApproval({ identifier: '7', cwd: '/tmp/gate' });
      expect(status.approved).toBe(false);
      expect(status.rejected).toBe(true);
      expect(status.statusText).toBe('Changes requested');
    });

    it('reports awaiting review when no decision yet', async () => {
      const { spawn } = await import('node:child_process');
      const spawnMock = vi.mocked(spawn);

      spawnMock.mockImplementation(((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return mockSpawnResult('https://github.com/owner/repo.git', 0);
        }
        if (cmd === 'gh') {
          return mockSpawnResult(
            JSON.stringify({ state: 'OPEN', reviewDecision: null, url: 'https://github.com/owner/repo/pull/7' }),
            0,
          );
        }
        return mockSpawnResult('', 0);
      }) as any);

      const status = await provider.checkApproval({ identifier: '7', cwd: '/tmp/gate' });
      expect(status.approved).toBe(false);
      expect(status.rejected).toBe(false);
      expect(status.statusText).toBe('Awaiting review');
    });
  });
});
