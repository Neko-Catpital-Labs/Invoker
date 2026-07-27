import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import {
  syncPlanBaseRemote,
  syncPlanBaseRemoteForRef,
  resolvePlanBaseRevision,
  resolvePreferredTrackingRemote,
} from '../plan-base-remote.js';

function runGitFactory(cwd: string) {
  return async (args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('plan-base-remote', () => {
  let originRepo: string;
  let mirror: string;
  let mirrorParent: string;
  let extraRepos: string[];

  beforeEach(() => {
    originRepo = mkdtempSync(join(tmpdir(), 'plan-base-origin-'));
    mirrorParent = mkdtempSync(join(tmpdir(), 'plan-base-mirror-'));
    extraRepos = [];
    execSync('git init', { cwd: originRepo });
    execSync('git config user.email "t@t.com"', { cwd: originRepo });
    execSync('git config user.name "T"', { cwd: originRepo });
    writeFileSync(join(originRepo, 'a.txt'), 'a');
    execSync('git add -A && git commit -m "first"', { cwd: originRepo });
    execSync('git branch -M master', { cwd: originRepo });

    execSync(`git clone "${originRepo}" mirror-work`, { cwd: mirrorParent });
    mirror = join(mirrorParent, 'mirror-work');
  });

  afterEach(() => {
    rmSync(mirrorParent, { recursive: true, force: true });
    rmSync(originRepo, { recursive: true, force: true });
    for (const repo of extraRepos) {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  function addDivergedUpstreamRemote(): string {
    const upstreamRemote = mkdtempSync(join(tmpdir(), 'plan-base-upstream-'));
    extraRepos.push(upstreamRemote);
    execSync(`git clone "${originRepo}" .`, { cwd: upstreamRemote });
    execSync('git config user.email "t@t.com"', { cwd: upstreamRemote });
    execSync('git config user.name "T"', { cwd: upstreamRemote });
    writeFileSync(join(upstreamRemote, 'upstream.txt'), 'upstream');
    execSync('git add -A && git commit -m "upstream advance"', { cwd: upstreamRemote });
    execSync(`git remote add upstream "${upstreamRemote}"`, { cwd: mirror });
    return upstreamRemote;
  }

  it('resolvePlanBaseRevision uses origin/master after syncPlanBaseRemote', async () => {
    const runGit = runGitFactory(mirror);

    writeFileSync(join(originRepo, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "second on origin"', { cwd: originRepo });

    const staleLocal = (await runGit(['rev-parse', 'master'])).trim();
    const originTip = execSync('git rev-parse master', { cwd: originRepo }).toString().trim();
    expect(staleLocal).not.toBe(originTip);

    await syncPlanBaseRemote(runGit, 'master');
    const resolved = (await resolvePlanBaseRevision(runGit, 'master')).trim();
    expect(resolved).toBe(originTip);
  });

  it('resolvePlanBaseRevision passes through full SHAs present in the mirror', async () => {
    const runGit = runGitFactory(mirror);
    const sha = (await runGit(['rev-parse', 'HEAD'])).trim();
    const resolved = (await resolvePlanBaseRevision(runGit, sha)).trim();
    expect(resolved).toBe(sha);
  });

  it('resolvePlanBaseRevision falls back to local refs/heads/<branch> when remote tracking is missing', async () => {
    const runGit = runGitFactory(mirror);
    await runGit(['checkout', '-b', 'feature/local-only']);
    writeFileSync(join(mirror, 'local.txt'), 'local');
    await runGit(['add', '-A']);
    await runGit(['commit', '-m', 'local-only']);
    const localHead = (await runGit(['rev-parse', 'feature/local-only'])).trim();

    const resolved = (await resolvePlanBaseRevision(runGit, 'feature/local-only')).trim();
    expect(resolved).toBe(localHead);
  });

  it('resolvePlanBaseRevision can self-sync missing origin tracking refs for new remote branches', async () => {
    const runGit = runGitFactory(mirror);

    execSync('git checkout -b feature/new-remote', { cwd: originRepo });
    writeFileSync(join(originRepo, 'remote.txt'), 'remote');
    execSync('git add -A && git commit -m "new remote branch"', { cwd: originRepo });
    const originHead = execSync('git rev-parse feature/new-remote', { cwd: originRepo }).toString().trim();

    const resolved = (await resolvePlanBaseRevision(runGit, 'feature/new-remote')).trim();
    expect(resolved).toBe(originHead);
  });

  it('resolvePlanBaseRevision falls back to origin/HEAD when the requested branch is missing', async () => {
    const runGit = runGitFactory(mirror);
    const headCommit = (await runGit(['rev-parse', '--verify', 'origin/master^{commit}'])).trim();

    const resolved = (await resolvePlanBaseRevision(runGit, 'main')).trim();
    expect(resolved).toBe(headCommit);
  });

  it('resolvePreferredTrackingRemote keeps origin as the default remote', async () => {
    const runGit = runGitFactory(mirror);
    const preferred = await resolvePreferredTrackingRemote(runGit, 'master');
    expect(preferred).toBe('origin');
  });

  it('resolvePreferredTrackingRemote preserves an explicit remote selection', async () => {
    const runGit = runGitFactory(mirror);
    addDivergedUpstreamRemote();

    const preferred = await resolvePreferredTrackingRemote(runGit, 'upstream/master');
    expect(preferred).toBe('upstream');
  });

  it('syncPlanBaseRemoteForRef fetches explicit upstream-qualified refs into that remote namespace', async () => {
    const runGit = runGitFactory(mirror);
    const upstreamRemote = addDivergedUpstreamRemote();
    const upstreamTip = execSync('git rev-parse master', { cwd: upstreamRemote }).toString().trim();

    await syncPlanBaseRemoteForRef(runGit, 'upstream/master');
    const resolved = await runGit(['rev-parse', '--verify', 'upstream/master^{commit}']);
    expect(resolved).toBe(upstreamTip);
  });

  it('resolvePlanBaseRevision honors explicit upstream-qualified refs when remotes diverge', async () => {
    const runGit = runGitFactory(mirror);
    const upstreamRemote = addDivergedUpstreamRemote();
    const originTip = execSync('git rev-parse master', { cwd: originRepo }).toString().trim();
    const upstreamTip = execSync('git rev-parse master', { cwd: upstreamRemote }).toString().trim();
    expect(upstreamTip).not.toBe(originTip);

    const resolved = (await resolvePlanBaseRevision(runGit, 'upstream/master')).trim();
    expect(resolved).toBe(upstreamTip);
  });
});
