import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  reapStaleWorktrees,
  STALE_WORKTREE_MIN_AGE_HOURS,
} from '../workers/reaper-reclaim.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createStaleWorktree(): { home: string; root: string; worktreePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-responsiveness-'));
  tempDirs.push(root);

  const home = join(root, '.invoker');
  const repoHash = 'repoabc123456';
  const repoPath = join(home, 'repos', repoHash);
  const worktreePath = join(home, 'worktrees', repoHash, 'old-worktree');
  mkdirSync(join(home, 'worktrees', repoHash), { recursive: true });

  execFileSync('git', ['init', '--quiet', repoPath]);
  execFileSync('git', ['-C', repoPath, 'commit', '--quiet', '--allow-empty', '-m', 'seed'], {
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'repro@example.invalid',
      GIT_AUTHOR_NAME: 'Reaper Repro',
      GIT_COMMITTER_EMAIL: 'repro@example.invalid',
      GIT_COMMITTER_NAME: 'Reaper Repro',
    },
  });
  execFileSync('git', ['-C', repoPath, 'worktree', 'add', '--quiet', '--detach', worktreePath]);

  const staleSeconds =
    (Date.now() - (STALE_WORKTREE_MIN_AGE_HOURS + 1) * 60 * 60 * 1000) / 1000;
  utimesSync(worktreePath, staleSeconds, staleSeconds);

  return { home, root, worktreePath };
}

describe('stale-worktree reaper responsiveness (real git)', { timeout: 30_000 }, () => {
  it.fails('allows owner-loop callbacks to run while Git removes a stale worktree', async () => {
    const { home, root, worktreePath } = createStaleWorktree();
    let reapCompleted = false;
    let callbackSawReapComplete: boolean | undefined;

    const ownerLoopCallback = new Promise<void>((resolve) => {
      setTimeout(() => {
        callbackSawReapComplete = reapCompleted;
        resolve();
      }, 0);
    });
    const reaping = reapStaleWorktrees({
      invokerHome: home,
      userHome: root,
      remoteTargets: [],
    }).then((results) => {
      reapCompleted = true;
      return results;
    });

    const [, results] = await Promise.all([ownerLoopCallback, reaping]);

    expect(callbackSawReapComplete).toBe(false);
    expect(results[0]).toMatchObject({
      ok: true,
      reason: 'reap-worktrees',
      detail: 'removed 1',
    });
    expect(existsSync(worktreePath)).toBe(false);
  });
});
