import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { buildMirrorCloneScript } from '../ssh-git-exec.js';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runScript(script: string, home: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', script], { env: { ...process.env, HOME: home } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function git(cwd: string, args: string[], home: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: {
      ...process.env,
      HOME: home,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('buildMirrorCloneScript concurrent mirror creation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setup(): { home: string; script: string } {
    const root = mkdtempSync(join(tmpdir(), 'ssh-mirror-race-'));
    tempDirs.push(root);
    const home = join(root, 'home');
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    mkdirSync(home);
    mkdirSync(seed);
    git(root, ['init', '--bare', '-b', 'master', origin], home);
    git(seed, ['init', '-b', 'master'], home);
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(seed, `file-${i}.txt`), `content ${i}\n`);
    }
    git(seed, ['add', '.'], home);
    git(seed, ['commit', '-m', 'seed'], home);
    git(seed, ['push', origin, 'master'], home);
    const script = buildMirrorCloneScript({
      repoUrl: `file://${origin}`,
      repoHash: 'racehash',
      baseRef: 'master',
      invokerHome: home,
    });
    return { home, script };
  }

  it('succeeds for every concurrent run and leaves no lock or temp dirs', async () => {
    const { home, script } = setup();
    const reposDir = join(home, 'repos');

    for (let round = 0; round < 5; round++) {
      rmSync(reposDir, { recursive: true, force: true });
      const results = await Promise.all([runScript(script, home), runScript(script, home), runScript(script, home)]);
      for (const result of results) {
        expect(result, `round ${round} stderr: ${result.stderr}`).toMatchObject({ code: 0 });
        expect(result.stdout).toContain('__INVOKER_BASE_HEAD__=');
      }
    }

    const leftovers = readdirSync(reposDir).filter(
      (entry) => entry === 'racehash.lock' || entry.startsWith('racehash.tmp.'),
    );
    expect(leftovers).toEqual([]);
    const nested = readdirSync(join(reposDir, 'racehash')).filter((entry) => entry.startsWith('racehash.tmp.'));
    expect(nested).toEqual([]);
  }, 120_000);

  it('leaves a lock older than ten minutes alone while its clone is still running', async () => {
    const { home, script } = setup();
    const lock = join(home, 'repos', 'racehash.lock');
    mkdirSync(lock, { recursive: true });
    const holder = spawn('bash', ['-c', 'sleep 4']);
    writeFileSync(join(lock, 'pid'), `${holder.pid}\n`);
    writeFileSync(join(lock, 'heartbeat'), `${Math.floor(Date.now() / 1000) - 20 * 60}\n`);
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(lock, old, old);

    const pending = runScript(script, home);
    const holderExited = new Promise<void>((resolve) => holder.on('close', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 2500));

    expect(existsSync(join(lock, 'pid'))).toBe(true);
    expect(readFileSync(join(lock, 'pid'), 'utf8').trim()).toBe(String(holder.pid));
    expect(existsSync(join(home, 'repos', 'racehash'))).toBe(false);

    await holderExited;
    const result = await pending;

    expect(result, `stderr: ${result.stderr}`).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('__INVOKER_BASE_HEAD__=');
    expect(existsSync(lock)).toBe(false);
  }, 60_000);

  it('refuses to publish into a surviving $CLONE instead of nesting the temporary clone inside it', async () => {
    const { home, script } = setup();
    const clone = join(home, 'repos', 'racehash');
    mkdirSync(clone, { recursive: true });
    writeFileSync(join(clone, 'stray.txt'), 'not a clone\n');

    const result = await runScript(script, home);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('cannot publish mirror clone');
    expect(readdirSync(clone).filter((entry) => entry.startsWith('racehash.tmp.'))).toEqual([]);
  }, 60_000);

  it('breaks a stale lock older than ten minutes', async () => {
    const { home, script } = setup();
    const lock = join(home, 'repos', 'racehash.lock');
    mkdirSync(lock, { recursive: true });
    const old = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(lock, old, old);

    const result = await runScript(script, home);

    expect(result, `stderr: ${result.stderr}`).toMatchObject({ code: 0 });
    expect(result.stdout).toContain('__INVOKER_BASE_HEAD__=');
    expect(existsSync(lock)).toBe(false);
  }, 60_000);
});
