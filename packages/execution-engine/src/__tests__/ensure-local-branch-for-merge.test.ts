import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { ensureLocalBranchForMerge, type MergeExecutorHost } from '../merge-executor.js';

function gitExec(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('ensureLocalBranchForMerge pool mirror fallback', () => {
  let root: string;
  let hostDir: string;
  let mergeClone: string;
  let mirrorDir: string;
  let bareOrigin: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'elm-mirror-'));
    bareOrigin = join(root, 'origin.git');
    mirrorDir = join(root, 'mirror');
    hostDir = join(root, 'host');
    mergeClone = join(root, 'merge-clone');

    execSync(`git init --bare -b master "${bareOrigin}"`, { stdio: 'pipe' });

    execSync(`git clone "${bareOrigin}" "${mirrorDir}"`, { stdio: 'pipe' });
    gitExec(['config', 'user.email', 'test@test.com'], mirrorDir);
    gitExec(['config', 'user.name', 'Test'], mirrorDir);
    writeFileSync(join(mirrorDir, 'm.txt'), 'm');
    gitExec(['add', '-A'], mirrorDir);
    gitExec(['commit', '-m', 'initial'], mirrorDir);
    gitExec(['push', 'origin', 'master'], mirrorDir);
    gitExec(['checkout', '-b', 'experiment/foo', 'master'], mirrorDir);
    writeFileSync(join(mirrorDir, 'foo.txt'), 'foo');
    gitExec(['add', '-A'], mirrorDir);
    gitExec(['commit', '-m', 'foo'], mirrorDir);

    execSync(`git clone "${bareOrigin}" "${hostDir}"`, { stdio: 'pipe' });
    gitExec(['config', 'user.email', 'test@test.com'], hostDir);
    gitExec(['config', 'user.name', 'Test'], hostDir);

    execSync(`git clone "${hostDir}" "${mergeClone}"`, { stdio: 'pipe' });
    gitExec(['config', 'user.email', 'test@test.com'], mergeClone);
    gitExec(['config', 'user.name', 'Test'], mergeClone);
    gitExec(['remote', 'set-url', 'origin', bareOrigin], mergeClone);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fetches branch from pool mirror when origin lacks ref', async () => {
    const host: MergeExecutorHost = {
      cwd: hostDir,
      persistence: {} as any,
      orchestrator: {} as any,
      callbacks: {} as any,
      defaultBranch: 'master',
      async execGitReadonly(args: string[]) {
        return gitExec(args, hostDir);
      },
      async execGitIn(args: string[], dir: string) {
        return gitExec(args, dir);
      },
      async createMergeWorktree() {
        return mergeClone;
      },
      async removeMergeWorktree() {},
      async execGh() {
        return '';
      },
      async execPr() {
        return '';
      },
      async detectDefaultBranch() {
        return 'master';
      },
      async gitLogMessage() {
        return '';
      },
      async gitDiffStat() {
        return '';
      },
      startPrPolling() {},
      async executeTasks() {},
      async consolidateAndMerge() {
        return undefined;
      },
      async buildMergeSummary() {
        return '';
      },
      ensureRepoMirrorPath: async () => mirrorDir,
    };

    await ensureLocalBranchForMerge(host, mergeClone, 'experiment/foo', 'https://example.com/repo.git');

    const rev = gitExec(['rev-parse', '--verify', 'experiment/foo'], mergeClone);
    expect(rev).toMatch(/^[a-f0-9]{40}$/);
  });
});
