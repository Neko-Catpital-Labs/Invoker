import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, resolveExecutorRouting } from '../config.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `invoker-config-test-${process.pid}`);
const fakeHome = join(testDir, 'home');
const fakeRepo = join(testDir, 'repo');

beforeEach(() => {
  mkdirSync(join(fakeHome, '.invoker'), { recursive: true });
  mkdirSync(fakeRepo, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

describe('loadConfig', () => {
  it('returns empty config when no files exist', () => {
    const config = loadConfig(fakeRepo);
    expect(config).toEqual({});
  });

  it('reads user-level ~/.invoker/config.json', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.defaultBranch).toBe('main');
  });

  it('reads repo-level .invoker.json', () => {
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ defaultBranch: 'master' }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.defaultBranch).toBe('master');
  });

  it('repo-level overrides user-level', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ defaultBranch: 'develop' }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.defaultBranch).toBe('develop');
  });

  it('handles malformed JSON gracefully', () => {
    writeFileSync(join(fakeRepo, '.invoker.json'), 'not json {{{');
    const config = loadConfig(fakeRepo);
    expect(config).toEqual({});
  });

  it('handles non-object JSON gracefully', () => {
    writeFileSync(join(fakeRepo, '.invoker.json'), '"just a string"');
    const config = loadConfig(fakeRepo);
    expect(config).toEqual({});
  });

  it('reads planningTimeoutSeconds from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningTimeoutSeconds: 600 }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.planningTimeoutSeconds).toBe(600);
  });

  it('reads planningHeartbeatIntervalSeconds from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningHeartbeatIntervalSeconds: 30 }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.planningHeartbeatIntervalSeconds).toBe(30);
  });

  it('repo-level overrides planningTimeoutSeconds from user-level', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningTimeoutSeconds: 600 }),
    );
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ planningTimeoutSeconds: 900 }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.planningTimeoutSeconds).toBe(900);
  });

  it('reads disableAutoRunOnStartup from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ disableAutoRunOnStartup: true }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.disableAutoRunOnStartup).toBe(true);
  });

  it('repo-level overrides disableAutoRunOnStartup from user-level', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ disableAutoRunOnStartup: false }),
    );
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ disableAutoRunOnStartup: true }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.disableAutoRunOnStartup).toBe(true);
  });

  it('reads maxConcurrency from repo config', () => {
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ maxConcurrency: 6 }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.maxConcurrency).toBe(6);
  });

  it('repo-level overrides maxConcurrency from user-level', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ maxConcurrency: 4 }),
    );
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ maxConcurrency: 8 }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.maxConcurrency).toBe(8);
  });

  it('loadConfig picks up browser field', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ browser: 'firefox' }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.browser).toBe('firefox');
  });

  it('reads imageStorage from user config', () => {
    const imageStorage = {
      provider: 'r2',
      accountId: 'abc123',
      bucketName: 'my-bucket',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      publicUrlBase: 'https://my-bucket.r2.dev',
    };
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ imageStorage }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.imageStorage).toEqual(imageStorage);
  });

  it('repo-level overrides browser from user-level', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ browser: 'firefox' }),
    );
    writeFileSync(
      join(fakeRepo, '.invoker.json'),
      JSON.stringify({ browser: 'chromium' }),
    );
    const config = loadConfig(fakeRepo);
    expect(config.browser).toBe('chromium');
  });
});

describe('resolveExecutorRouting', () => {
  const rule = { pattern: 'deploy', familiarType: 'ssh', remoteTargetId: 'prod' };

  it('returns {} when no rules', () => {
    expect(resolveExecutorRouting('pnpm deploy', undefined, undefined, [])).toEqual({});
  });

  it('matches by pattern substring', () => {
    expect(resolveExecutorRouting('pnpm deploy:prod', undefined, undefined, [rule]))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'prod' });
  });

  it('returns {} when pattern does not match', () => {
    expect(resolveExecutorRouting('pnpm test', undefined, undefined, [rule])).toEqual({});
  });

  it('matches by regex', () => {
    const regexRule = { regex: '^pnpm (build|deploy)', familiarType: 'ssh', remoteTargetId: 'prod' };
    expect(resolveExecutorRouting('pnpm deploy:staging', undefined, undefined, [regexRule]))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'prod' });
  });

  it('returns {} when regex does not match', () => {
    const regexRule = { regex: '^pnpm deploy$', familiarType: 'ssh', remoteTargetId: 'prod' };
    expect(resolveExecutorRouting('pnpm test', undefined, undefined, [regexRule])).toEqual({});
  });

  it('matches if either pattern or regex matches (both present)', () => {
    const bothRule = { pattern: 'deploy', regex: 'nope', familiarType: 'ssh', remoteTargetId: 'prod' };
    expect(resolveExecutorRouting('pnpm deploy', undefined, undefined, [bothRule]))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'prod' });
    const bothRule2 = { pattern: 'nope', regex: 'deploy', familiarType: 'ssh', remoteTargetId: 'prod' };
    expect(resolveExecutorRouting('pnpm deploy', undefined, undefined, [bothRule2]))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'prod' });
  });

  it('returns {} when planFamiliarType is already set (YAML wins)', () => {
    expect(resolveExecutorRouting('pnpm deploy', 'worktree', undefined, [rule])).toEqual({});
  });

  it('returns {} when planRemoteTargetId is already set (YAML wins)', () => {
    expect(resolveExecutorRouting('pnpm deploy', undefined, 'staging', [rule])).toEqual({});
  });

  it('returns {} when both planFamiliarType and planRemoteTargetId are set', () => {
    expect(resolveExecutorRouting('pnpm deploy', 'docker', 'prod', [rule])).toEqual({});
  });

  it('first matching rule wins', () => {
    const rules = [
      { pattern: 'deploy', familiarType: 'ssh', remoteTargetId: 'prod' },
      { pattern: 'deploy', familiarType: 'docker', remoteTargetId: 'staging' },
    ];
    expect(resolveExecutorRouting('pnpm deploy', undefined, undefined, rules))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'prod' });
  });

  it('skips non-matching rules and returns first match', () => {
    const rules = [
      { pattern: 'build', familiarType: 'docker', remoteTargetId: 'ci' },
      { pattern: 'deploy', familiarType: 'ssh', remoteTargetId: 'prod' },
    ];
    expect(resolveExecutorRouting('pnpm deploy', undefined, undefined, rules))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'prod' });
  });
});
