import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  assertNotGitConfigMutation,
  classifyGitConfigMutation,
  ensureRemoteUrl,
} from '../git-config-mutation.js';
import { TaskRunner, ExecutorRegistry } from '../index.js';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-config-mutation-'));
  execSync('git init -b master', { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('git config mutation classification', () => {
  it('classifies runtime .git/config writers', () => {
    expect(classifyGitConfigMutation(['config', 'user.name', 'Test'])).toMatchObject({
      mutates: true,
      kind: 'config-write',
    });
    expect(classifyGitConfigMutation(['remote', 'add', 'origin', 'git@example.com:repo.git'])).toMatchObject({
      mutates: true,
      kind: 'remote-add',
    });
    expect(classifyGitConfigMutation(['remote', 'set-url', 'origin', 'git@example.com:repo.git'])).toMatchObject({
      mutates: true,
      kind: 'remote-set-url',
    });
    expect(classifyGitConfigMutation(['push', '-u', 'origin', 'branch'])).toMatchObject({
      mutates: true,
      kind: 'push-upstream',
    });
    expect(classifyGitConfigMutation(['branch', '--set-upstream-to', 'origin/main'])).toMatchObject({
      mutates: true,
      kind: 'branch-upstream',
    });
  });

  it('allows read-only config and non-upstream pushes', () => {
    expect(classifyGitConfigMutation(['config', '--get', 'user.name']).mutates).toBe(false);
    expect(classifyGitConfigMutation(['remote', 'get-url', 'origin']).mutates).toBe(false);
    expect(classifyGitConfigMutation(['config', '--list']).mutates).toBe(false);
    expect(classifyGitConfigMutation(['push', 'origin', 'branch:refs/heads/branch']).mutates).toBe(false);
  });
});

describe('git config mutation gateway', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('skips ensureRemoteUrl when the URL already matches', async () => {
    root = createRepo();
    git(root, 'remote add origin /tmp/origin.git');

    const result = await ensureRemoteUrl({
      cwd: root,
      remote: 'origin',
      url: '/tmp/origin.git',
      context: { caller: 'test', detail: 'noop' },
    });

    expect(result).toBe('unchanged');
    expect(git(root, 'remote get-url origin')).toBe('/tmp/origin.git');
  });

  it('serializes concurrent remote setup and waits for transient config.lock', async () => {
    root = createRepo();
    const configLock = join(root, '.git', 'config.lock');
    writeFileSync(configLock, '');
    setTimeout(() => unlinkSync(configLock), 100);

    const results = await Promise.all([
      ensureRemoteUrl({
        cwd: root,
        remote: 'origin',
        url: '/tmp/origin.git',
        context: { caller: 'test', detail: 'a' },
      }),
      ensureRemoteUrl({
        cwd: root,
        remote: 'origin',
        url: '/tmp/origin.git',
        context: { caller: 'test', detail: 'b' },
      }),
    ]);

    expect(results).toContain('added');
    expect(results).toContain('unchanged');
    expect(git(root, 'remote get-url origin')).toBe('/tmp/origin.git');
  });

  it('rejects raw runtime git config mutations at TaskRunner boundaries', () => {
    root = createRepo();
    const runner = new TaskRunner({
      orchestrator: { getAllTasks: () => [] } as any,
      persistence: { updateTask: () => {} } as any,
      executorRegistry: new ExecutorRegistry(),
      cwd: root,
      defaultBranch: 'master',
    });

    expect(() => runner.execGitIn(['remote', 'add', 'origin', '/tmp/origin.git'], root!))
      .toThrow('TaskRunner.execGitIn rejected');
    expect(() => assertNotGitConfigMutation(['push', '-u', 'origin', 'branch'], 'test'))
      .toThrow('mutates .git/config');
  });
});
