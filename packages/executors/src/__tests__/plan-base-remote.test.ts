import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { syncPlanBaseRemote, resolvePlanBaseRevision } from '../plan-base-remote.js';

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
});
