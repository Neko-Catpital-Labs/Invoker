import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig, resolveExecutorRouting } from '../config.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `invoker-config-test-${process.pid}`);
const fakeHome = join(testDir, 'home');

beforeEach(() => {
  mkdirSync(join(fakeHome, '.invoker'), { recursive: true });
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
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('reads user-level ~/.invoker/config.json', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig();
    expect(config.defaultBranch).toBe('main');
  });

  it('handles malformed JSON gracefully', () => {
    writeFileSync(join(fakeHome, '.invoker', 'config.json'), 'not json {{{');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('handles non-object JSON gracefully', () => {
    writeFileSync(join(fakeHome, '.invoker', 'config.json'), '"just a string"');
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('reads planningTimeoutSeconds from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningTimeoutSeconds: 600 }),
    );
    const config = loadConfig();
    expect(config.planningTimeoutSeconds).toBe(600);
  });

  it('reads planningHeartbeatIntervalSeconds from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningHeartbeatIntervalSeconds: 30 }),
    );
    const config = loadConfig();
    expect(config.planningHeartbeatIntervalSeconds).toBe(30);
  });

  it('reads disableAutoRunOnStartup from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ disableAutoRunOnStartup: true }),
    );
    const config = loadConfig();
    expect(config.disableAutoRunOnStartup).toBe(true);
  });

  it('reads maxConcurrency from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ maxConcurrency: 6 }),
    );
    const config = loadConfig();
    expect(config.maxConcurrency).toBe(6);
  });

  it('loadConfig picks up browser field', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ browser: 'firefox' }),
    );
    const config = loadConfig();
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
    const config = loadConfig();
    expect(config.imageStorage).toEqual(imageStorage);
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

  it('matches test command by pattern substring', () => {
    const testRule = { pattern: 'pnpm test', familiarType: 'ssh', remoteTargetId: 'ci-box' };
    expect(resolveExecutorRouting('pnpm test --coverage', undefined, undefined, [testRule]))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'ci-box' });
  });

  it('matches test command by regex', () => {
    const testRule = { regex: '^pnpm test', familiarType: 'ssh', remoteTargetId: 'ci-box' };
    expect(resolveExecutorRouting('pnpm test', undefined, undefined, [testRule]))
      .toEqual({ familiarType: 'ssh', remoteTargetId: 'ci-box' });
  });

  it('does not match test rule against non-test command', () => {
    const testRule = { regex: '^pnpm test', familiarType: 'ssh', remoteTargetId: 'ci-box' };
    expect(resolveExecutorRouting('pnpm build', undefined, undefined, [testRule])).toEqual({});
  });

  it('YAML familiarType wins over test routing rule', () => {
    const testRule = { pattern: 'pnpm test', familiarType: 'ssh', remoteTargetId: 'ci-box' };
    expect(resolveExecutorRouting('pnpm test', 'worktree', undefined, [testRule])).toEqual({});
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
