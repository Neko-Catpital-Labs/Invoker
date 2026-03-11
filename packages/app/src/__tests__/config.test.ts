import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../config.js';
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
});
