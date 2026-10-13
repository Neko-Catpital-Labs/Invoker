import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GitLabMergeGateProvider,
  resolveGitLabMergeRequestLifecycle,
} from '../gitlab-merge-gate-provider.js';

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

describe('resolveGitLabMergeRequestLifecycle', () => {
  it('maps GitLab states onto merge-gate lifecycle', () => {
    expect(resolveGitLabMergeRequestLifecycle('merged')).toBe('merged');
    expect(resolveGitLabMergeRequestLifecycle('closed')).toBe('closed');
    expect(resolveGitLabMergeRequestLifecycle('opened')).toBe('open');
  });
});

describe('GitLabMergeGateProvider', () => {
  let provider: GitLabMergeGateProvider;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, INVOKER_GITLAB_PROJECT: 'Group/Sub/Project' };
    provider = new GitLabMergeGateProvider();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates a merge request through glab api with a temp input file', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);

    spawnMock.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git') return mockSpawnResult('', 0);
      if (cmd === 'glab' && args.some((arg) => String(arg).includes('state=opened'))) {
        return mockSpawnResult('[]', 0);
      }
      if (cmd === 'glab' && args.includes('--method') && args.includes('POST')) {
        return mockSpawnResult(JSON.stringify({
          web_url: 'https://gitlab.com/Group/Sub/Project/-/merge_requests/3',
          iid: 3,
        }), 0);
      }
      return mockSpawnResult('{}', 0);
    }) as any);

    const result = await provider.createReview({
      baseBranch: 'master',
      featureBranch: 'feature/x',
      title: 'Test MR',
      cwd: '/tmp/repo',
      body: '## Summary\n\nbody',
    });

    expect(result).toEqual({
      url: 'https://gitlab.com/Group/Sub/Project/-/merge_requests/3',
      identifier: '3',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'glab',
      expect.arrayContaining(['--input', expect.stringContaining('create.json')]),
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
  });

  it('maps approvals and failed pipelines onto MergeGateApprovalStatus', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);

    spawnMock.mockImplementation(((cmd: string, args: string[]) => {
      const path = args.find((arg) => String(arg).startsWith('projects/')) ?? '';
      if (cmd === 'glab' && path.includes('/approvals')) {
        return mockSpawnResult(JSON.stringify({ approved: false }), 0);
      }
      if (cmd === 'glab' && path.includes('/jobs')) {
        return mockSpawnResult(JSON.stringify([{
          id: 42,
          name: 'test',
          status: 'failed',
          web_url: 'https://gitlab.com/Group/Sub/Project/-/jobs/42',
        }]), 0);
      }
      if (cmd === 'glab' && path.includes('/pipelines')) {
        return mockSpawnResult(JSON.stringify([{
          id: 9,
          status: 'failed',
          web_url: 'https://gitlab.com/Group/Sub/Project/-/pipelines/9',
        }]), 0);
      }
      if (cmd === 'glab') {
        return mockSpawnResult(JSON.stringify({
          state: 'opened',
          web_url: 'https://gitlab.com/Group/Sub/Project/-/merge_requests/3',
          sha: 'abc',
          source_branch: 'feature/x',
          has_conflicts: false,
          detailed_merge_status: 'mergeable',
        }), 0);
      }
      return mockSpawnResult('{}', 0);
    }) as any);

    const status = await provider.checkApproval({ identifier: '3', cwd: '/tmp/repo' });
    expect(status.lifecycle).toBe('open');
    expect(status.rejected).toBe(false);
    expect(status.statusText).toBe('Awaiting review');
    expect(status.checks?.state).toBe('failure');
    expect(status.checks?.failed[0]?.detailsUrl).toContain('/-/jobs/42');
  });

  it('refreshes branch refs without interpolating the feature branch into git fetch', async () => {
    const { spawn } = await import('node:child_process');
    const spawnMock = vi.mocked(spawn);
    let pushAttempts = 0;

    spawnMock.mockImplementation(((cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'remote') return mockSpawnResult('origin\n', 0);
      if (cmd === 'git' && args[0] === 'push') {
        pushAttempts += 1;
        if (pushAttempts === 1) {
          return mockSpawnResult(
            '',
            1,
            "remote rejected: cannot lock ref 'refs/heads/feature/test': is at 1111111 but expected 2222222",
          );
        }
        return mockSpawnResult('', 0);
      }
      if (cmd === 'git' && args[0] === 'fetch') return mockSpawnResult('', 0);
      if (cmd === 'glab' && args.some((arg) => String(arg).includes('state=opened'))) {
        return mockSpawnResult('[]', 0);
      }
      if (cmd === 'glab' && args.includes('--method') && args.includes('POST')) {
        return mockSpawnResult(JSON.stringify({
          web_url: 'https://gitlab.com/Group/Sub/Project/-/merge_requests/3',
          iid: 3,
        }), 0);
      }
      return mockSpawnResult('{}', 0);
    }) as any);

    await provider.createReview({
      baseBranch: 'master',
      featureBranch: 'feature/test',
      title: 'Test MR',
      cwd: '/tmp/repo',
      body: '## Summary\n\nbody',
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'],
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
  });
});
