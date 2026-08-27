import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import { LocalBus } from '@invoker/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../index.js';
import { invokerHomeDir } from '../onboarding.js';
import { resolveCliInstanceProfile, resolveInvokerDbPath } from '../worker-toggles.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSourceCheckout(prefix: string): string {
  const sourceRoot = makeTempDir(prefix);
  writeFileSync(join(sourceRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  return sourceRoot;
}

function captureProcessOutput() {
  let stdout = '';
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout += chunk.toString();
    return true;
  });
  return {
    get stdout() { return stdout; },
    restore() {
      stdoutSpy.mockRestore();
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveCliInstanceProfile', () => {
  it('retains the production ~/.invoker layout for an installed CLI (no workspace marker above it)', () => {
    const fakeHome = makeTempDir('invoker-profile-home-');
    const installedStartDir = makeTempDir('invoker-profile-installed-');

    const profile = resolveCliInstanceProfile({ startDir: installedStartDir, homeDir: fakeHome, env: {} });

    expect(profile.kind).toBe('packaged');
    expect(profile.homeRoot).toBe(join(fakeHome, '.invoker'));
    expect(profile.isProductionAccessExplicit).toBe(true);
  });

  it('uses a disjoint per-checkout profile for a source-development CLI (workspace marker present)', () => {
    const fakeHome = makeTempDir('invoker-profile-home-');
    const sourceRoot = makeSourceCheckout('invoker-profile-source-');
    const nestedStartDir = join(sourceRoot, 'packages', 'cli', 'dist');
    mkdirSync(nestedStartDir, { recursive: true });

    const profile = resolveCliInstanceProfile({ startDir: nestedStartDir, homeDir: fakeHome, env: {} });

    expect(profile.kind).toBe('source-development');
    expect(profile.homeRoot).not.toBe(join(fakeHome, '.invoker'));
    expect(profile.homeRoot.startsWith(join(fakeHome, '.invoker', 'dev'))).toBe(true);
    expect(profile.isProductionAccessExplicit).toBe(false);
  });

  it('resolves two distinct source checkouts to two distinct, stable profiles', () => {
    const fakeHome = makeTempDir('invoker-profile-home-');
    const sourceRootA = makeSourceCheckout('invoker-profile-source-a-');
    const sourceRootB = makeSourceCheckout('invoker-profile-source-b-');

    const a1 = resolveCliInstanceProfile({ startDir: sourceRootA, homeDir: fakeHome, env: {} });
    const a2 = resolveCliInstanceProfile({ startDir: sourceRootA, homeDir: fakeHome, env: {} });
    const b = resolveCliInstanceProfile({ startDir: sourceRootB, homeDir: fakeHome, env: {} });

    expect(a1.homeRoot).toBe(a2.homeRoot);
    expect(a1.homeRoot).not.toBe(b.homeRoot);
  });

  it('lets an explicit INVOKER_DB_DIR override win for both installed and source profiles', () => {
    const fakeHome = makeTempDir('invoker-profile-home-');
    const explicitDbDir = join(fakeHome, 'explicit-db-dir');
    const installedStartDir = makeTempDir('invoker-profile-installed-override-');
    const sourceRoot = makeSourceCheckout('invoker-profile-source-override-');

    const installedProfile = resolveCliInstanceProfile({
      startDir: installedStartDir,
      homeDir: fakeHome,
      env: { INVOKER_DB_DIR: explicitDbDir },
    });
    const sourceProfile = resolveCliInstanceProfile({
      startDir: sourceRoot,
      homeDir: fakeHome,
      env: { INVOKER_DB_DIR: explicitDbDir },
    });

    expect(installedProfile.homeRoot).toBe(explicitDbDir);
    expect(sourceProfile.homeRoot).toBe(explicitDbDir);
  });
});

describe('invokerHomeDir', () => {
  const previousDbDir = process.env.INVOKER_DB_DIR;

  afterEach(() => {
    if (previousDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousDbDir;
    }
  });

  it('matches the shared CLI instance profile home root', () => {
    delete process.env.INVOKER_DB_DIR;
    expect(invokerHomeDir()).toBe(resolveCliInstanceProfile().homeRoot);
  });

  it('honors an explicit INVOKER_DB_DIR override', () => {
    const explicitDbDir = makeTempDir('invoker-home-dir-override-');
    process.env.INVOKER_DB_DIR = explicitDbDir;
    expect(invokerHomeDir()).toBe(explicitDbDir);
  });
});

describe('resolveInvokerDbPath', () => {
  const previousDbDir = process.env.INVOKER_DB_DIR;
  const previousConfigPath = process.env.INVOKER_REPO_CONFIG_PATH;

  afterEach(() => {
    if (previousDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousDbDir;
    }
    if (previousConfigPath === undefined) {
      delete process.env.INVOKER_REPO_CONFIG_PATH;
    } else {
      process.env.INVOKER_REPO_CONFIG_PATH = previousConfigPath;
    }
  });

  it('falls back to the shared CLI instance profile home root when no explicit location is set', () => {
    delete process.env.INVOKER_DB_DIR;
    delete process.env.INVOKER_REPO_CONFIG_PATH;
    expect(resolveInvokerDbPath()).toBe(join(resolveCliInstanceProfile().homeRoot, 'invoker.db'));
  });

  it('prefers INVOKER_DB_DIR over the profile default', () => {
    const explicitDbDir = makeTempDir('invoker-db-path-override-');
    delete process.env.INVOKER_REPO_CONFIG_PATH;
    process.env.INVOKER_DB_DIR = explicitDbDir;
    expect(resolveInvokerDbPath()).toBe(join(explicitDbDir, 'invoker.db'));
  });

  it('prefers INVOKER_REPO_CONFIG_PATH over the profile default when INVOKER_DB_DIR is unset', () => {
    const explicitConfigDir = makeTempDir('invoker-db-path-config-override-');
    delete process.env.INVOKER_DB_DIR;
    process.env.INVOKER_REPO_CONFIG_PATH = join(explicitConfigDir, 'config.json');
    expect(resolveInvokerDbPath()).toBe(join(explicitConfigDir, 'invoker.db'));
  });
});

describe('invoker-cli query respects an explicit db-dir location', () => {
  const previousDbDir = process.env.INVOKER_DB_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = previousDbDir;
    }
  });

  it('uses INVOKER_DB_DIR rather than falling back to a production or unrelated default', async () => {
    const explicitDbDir = makeTempDir('invoker-cli-query-profile-defaults-');
    const seeded = await SQLiteAdapter.create(join(explicitDbDir, 'invoker.db'), {
      ownerCapability: true,
      outputDir: join(explicitDbDir, 'outputs'),
      slowQueryThresholdMs: 0,
    });
    try {
      seeded.saveWorkflow({
        id: 'wf-explicit-db-dir',
        name: 'Explicit db-dir workflow',
        onFinish: 'none',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    } finally {
      seeded.close();
    }

    process.env.INVOKER_DB_DIR = explicitDbDir;
    const bus = new LocalBus();
    const output = captureProcessOutput();

    const code = await main(['query', 'workflows', '--output', 'json'], { createMessageBus: () => bus });
    output.restore();

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout) as Array<{ id: string }>;
    expect(parsed.map((item) => item.id)).toEqual(['wf-explicit-db-dir']);
  });
});
