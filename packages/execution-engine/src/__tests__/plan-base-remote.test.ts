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
  shouldResolveViaOriginTracking,
} from '../plan-base-remote.js';

function runGitFactory(cwd: string) {
  return async (args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('plan-base-remote', () => {
  let upstream: string;
  let mirror: string;
  let mirrorParent: string;

  beforeEach(() => {
    upstream = mkdtempSync(join(tmpdir(), 'plan-base-up-'));
    mirrorParent = mkdtempSync(join(tmpdir(), 'plan-base-mirror-'));
    execSync('git init', { cwd: upstream });
    execSync('git config user.email "t@t.com"', { cwd: upstream });
    execSync('git config user.name "T"', { cwd: upstream });
    writeFileSync(join(upstream, 'a.txt'), 'a');
    execSync('git add -A && git commit -m "first"', { cwd: upstream });
    execSync('git branch -M master', { cwd: upstream });

    execSync(`git clone "${upstream}" mirror-work`, { cwd: mirrorParent });
    mirror = join(mirrorParent, 'mirror-work');
  });

  afterEach(() => {
    rmSync(mirrorParent, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
  });

  it('resolvePlanBaseRevision uses origin/master after syncPlanBaseRemote', async () => {
    const runGit = runGitFactory(mirror);

    writeFileSync(join(upstream, 'b.txt'), 'b');
    execSync('git add -A && git commit -m "second on upstream"', { cwd: upstream });

    const staleLocal = (await runGit(['rev-parse', 'master'])).trim();
    const upstreamTip = execSync('git rev-parse master', { cwd: upstream }).toString().trim();
    expect(staleLocal).not.toBe(upstreamTip);

    await syncPlanBaseRemote(runGit, 'master');
    const resolved = (await resolvePlanBaseRevision(runGit, 'master')).trim();
    expect(resolved).toBe(upstreamTip);
  });

  it('resolvePlanBaseRevision passes through full SHAs present in the mirror', async () => {
    const runGit = runGitFactory(mirror);
    const sha = (await runGit(['rev-parse', 'HEAD'])).trim();
    const resolved = (await resolvePlanBaseRevision(runGit, sha)).trim();
    expect(resolved).toBe(sha);
  });

  it('resolvePlanBaseRevision falls back to local refs/heads/<branch> when origin tracking is missing', async () => {
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

    execSync('git checkout -b feature/new-remote', { cwd: upstream });
    writeFileSync(join(upstream, 'remote.txt'), 'remote');
    execSync('git add -A && git commit -m "new remote branch"', { cwd: upstream });
    const upstreamHead = execSync('git rev-parse feature/new-remote', { cwd: upstream }).toString().trim();

    const resolved = (await resolvePlanBaseRevision(runGit, 'feature/new-remote')).trim();
    expect(resolved).toBe(upstreamHead);
  });

  it('resolvePreferredTrackingRemote prefers upstream for short base refs when available', async () => {
    const runGit = runGitFactory(mirror);
    execSync(`git remote add upstream "${upstream}"`, { cwd: mirror });

    const preferred = await resolvePreferredTrackingRemote(runGit, 'master');
    expect(preferred).toBe('upstream');
  });

  it('resolvePreferredTrackingRemote falls back to origin when upstream branch is missing', async () => {
    const runGit = runGitFactory(mirror);
    execSync(`git remote add upstream "${upstream}"`, { cwd: mirror });

    const preferred = await resolvePreferredTrackingRemote(runGit, 'branch-that-does-not-exist');
    expect(preferred).toBe('origin');
  });

  it('syncPlanBaseRemoteForRef supports custom parent remote names', async () => {
    const runGit = runGitFactory(mirror);
    execSync(`git remote add canonical "${upstream}"`, { cwd: mirror });

    writeFileSync(join(upstream, 'canonical-sync.txt'), 'canonical-sync');
    execSync('git add -A && git commit -m "canonical sync target"', { cwd: upstream });
    const upstreamTip = execSync('git rev-parse master', { cwd: upstream }).toString().trim();

    await syncPlanBaseRemoteForRef(runGit, 'canonical/master', 'canonical');
    const resolved = await runGit(['rev-parse', '--verify', 'canonical/master^{commit}']);
    expect(resolved).toBe(upstreamTip);
  });

  it('shouldResolveViaOriginTracking treats custom parent remote refs as explicit', () => {
    expect(shouldResolveViaOriginTracking('master', 'canonical')).toBe(true);
    expect(shouldResolveViaOriginTracking('canonical/master', 'canonical')).toBe(false);
  });
});
