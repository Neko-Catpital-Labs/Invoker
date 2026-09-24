import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePlanBaseRevision } from '../plan-base-remote.js';
import { buildMirrorCloneScript } from '../ssh-git-exec.js';

describe('missing named base branch is refused at task start', () => {
  let root: string;
  let originRepo: string;
  let mirror: string;
  let masterSha: string;

  const git = (cwd: string, cmd: string): string =>
    execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const runGit = (args: string[]): Promise<string> =>
    Promise.resolve(execFileSync('git', args, { cwd: mirror, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'missing-base-branch-'));
    originRepo = join(root, 'origin.git');
    const seed = join(root, 'seed');
    mirror = join(root, 'mirror');

    execSync(`git init --bare -b master ${JSON.stringify(originRepo)}`, { stdio: 'ignore' });
    execSync(`git clone ${JSON.stringify(originRepo)} ${JSON.stringify(seed)}`, { stdio: 'ignore' });
    git(seed, 'git config user.email test@example.com && git config user.name Test');
    git(seed, 'git checkout -B master');
    writeFileSync(join(seed, 'a.txt'), 'a\n');
    git(seed, 'git add a.txt && git commit -m base && git push origin master');
    git(seed, 'git checkout -b feature/x');
    writeFileSync(join(seed, 'b.txt'), 'b\n');
    git(seed, 'git add b.txt && git commit -m feature && git push origin feature/x');
    masterSha = git(originRepo, 'git rev-parse master');

    execSync(`git clone ${JSON.stringify(originRepo)} ${JSON.stringify(mirror)}`, { stdio: 'ignore' });
    git(originRepo, 'git branch -D feature/x');
    git(mirror, 'git fetch --all --prune');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('resolvePlanBaseRevision rejects a named branch missing on the remote', async () => {
    await expect(resolvePlanBaseRevision(runGit, 'feature/x')).rejects.toThrow(/was not found on the remote/);
  });

  it('resolvePlanBaseRevision resolves master to origin master', async () => {
    expect((await resolvePlanBaseRevision(runGit, 'master')).trim()).toBe(masterSha);
  });

  it('resolvePlanBaseRevision resolves main to the master alternate', async () => {
    expect((await resolvePlanBaseRevision(runGit, 'main')).trim()).toBe(masterSha);
  });

  const runScript = (baseRef: string) => {
    const script = buildMirrorCloneScript({
      repoUrl: originRepo,
      repoHash: 'refused-base',
      baseRef,
      invokerHome: root,
    });
    return spawnSync('bash', ['-lc', script], { env: { ...process.env, HOME: root }, encoding: 'utf8' });
  };

  it('mirror clone script refuses a named branch missing on the remote', () => {
    const result = runScript('feature/x');
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('__INVOKER_BASE_REF__=');
    expect(result.stderr).toContain('was not found on the remote');
  });

  it('mirror clone script resolves main to the origin/master alternate', () => {
    const result = runScript('main');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('__INVOKER_BASE_REF__=origin/master');
  });
});
