import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import {
  InvokerInstanceProfileError,
  resolveInvokerInstanceProfile,
} from '../invoker-instance-profile.js';

const HOME = '/home/user';

describe('resolveInvokerInstanceProfile', () => {
  it('resolves the existing production home and production-compatible defaults for packaged', () => {
    const profile = resolveInvokerInstanceProfile({ kind: 'packaged', homeDir: HOME, platform: 'linux' });

    expect(profile.homeRoot).toBe(join(HOME, '.invoker'));
    expect(profile.configPath).toBe(join(HOME, '.invoker', 'config.json'));
    expect(profile.ipcSocketPath).toBe(join(HOME, '.invoker', 'ipc-transport.sock'));
    expect(profile.logPath).toBe(join(HOME, '.invoker', 'invoker.log'));
    expect(profile.ports).toEqual({ apiPort: 4100, webPort: 4200 });
    expect(profile.isProductionAccessExplicit).toBe(true);
    expect(profile.developmentId).toBeNull();
  });

  it('resolves every resource outside production for a source-development profile', () => {
    const profile = resolveInvokerInstanceProfile({
      kind: 'source-development',
      sourceRoot: '/Users/dev/worktrees/feature-a',
      homeDir: HOME,
      platform: 'linux',
    });

    expect(profile.homeRoot).not.toBe(join(HOME, '.invoker'));
    expect(profile.configPath).not.toBe(join(HOME, '.invoker', 'config.json'));
    expect(profile.envPath).not.toBe(join(HOME, '.invoker', 'env.sh'));
    expect(profile.logPath).not.toBe(join(HOME, '.invoker', 'invoker.log'));
    expect(profile.ipcSocketPath).not.toBe(join(HOME, '.invoker', 'ipc-transport.sock'));
    expect(profile.electronUserDataDir).not.toBe(join(HOME, '.invoker'));
    expect(profile.ports.apiPort).not.toBe(4100);
    expect(profile.ports.webPort).not.toBe(4200);
    expect(profile.isProductionAccessExplicit).toBe(false);
    expect(profile.developmentId).toMatch(/^[0-9a-f]{10}$/);

    // Every resource stays under the derived, isolated home root.
    expect(profile.configPath.startsWith(profile.homeRoot)).toBe(true);
    expect(profile.envPath.startsWith(profile.homeRoot)).toBe(true);
    expect(profile.logPath.startsWith(profile.homeRoot)).toBe(true);
    expect(profile.ipcSocketPath.startsWith(profile.homeRoot)).toBe(true);

    // Unix domain socket paths must stay well within the platform limit (~104-108 bytes).
    expect(profile.ipcSocketPath.length).toBeLessThan(100);
  });

  it('resolves two distinct worktree roots to distinct, stable development profiles', () => {
    const a1 = resolveInvokerInstanceProfile({ kind: 'source-development', sourceRoot: '/Users/dev/worktrees/a', homeDir: HOME });
    const a2 = resolveInvokerInstanceProfile({ kind: 'source-development', sourceRoot: '/Users/dev/worktrees/a', homeDir: HOME });
    const b = resolveInvokerInstanceProfile({ kind: 'source-development', sourceRoot: '/Users/dev/worktrees/b', homeDir: HOME });

    expect(a1).toEqual(a2);

    expect(a1.developmentId).not.toBe(b.developmentId);
    expect(a1.homeRoot).not.toBe(b.homeRoot);
    expect(a1.ipcSocketPath).not.toBe(b.ipcSocketPath);
    expect(a1.configPath).not.toBe(b.configPath);
    expect(a1.envPath).not.toBe(b.envPath);
    expect(a1.logPath).not.toBe(b.logPath);
    expect(a1.electronUserDataDir).not.toBe(b.electronUserDataDir);
    expect(a1.ports).not.toEqual(b.ports);
  });

  it('preserves explicit overrides regardless of profile kind', () => {
    const profile = resolveInvokerInstanceProfile({
      kind: 'test',
      homeDir: HOME,
      env: {
        INVOKER_DB_DIR: '/tmp/invoker-explicit',
        INVOKER_IPC_SOCKET: '/tmp/custom.sock',
        INVOKER_REPO_CONFIG_PATH: '/tmp/custom-config.json',
        INVOKER_ENV_PATH: '/tmp/custom.env',
        INVOKER_LOG_PATH: '/tmp/custom.log',
      },
    });

    expect(profile.homeRoot).toBe('/tmp/invoker-explicit');
    expect(profile.ipcSocketPath).toBe('/tmp/custom.sock');
    expect(profile.configPath).toBe('/tmp/custom-config.json');
    expect(profile.envPath).toBe('/tmp/custom.env');
    expect(profile.logPath).toBe('/tmp/custom.log');
  });

  it('produces a deterministic error for a malformed profile name', () => {
    const attempt = () => resolveInvokerInstanceProfile({ kind: 'production' });

    expect(attempt).toThrow(InvokerInstanceProfileError);
    expect(attempt).toThrow(
      'Unknown Invoker runtime profile "production". Expected one of: packaged, source-development, test.',
    );

    // Same malformed input always produces the same error message.
    let firstMessage = '';
    let secondMessage = '';
    try {
      attempt();
    } catch (error) {
      firstMessage = (error as Error).message;
    }
    try {
      attempt();
    } catch (error) {
      secondMessage = (error as Error).message;
    }
    expect(firstMessage).toBe(secondMessage);
  });

  it('requires a sourceRoot for source-development profiles', () => {
    expect(() => resolveInvokerInstanceProfile({ kind: 'source-development' })).toThrow(
      InvokerInstanceProfileError,
    );
  });

  it('keeps a profile\'s own resource paths disjoint from one another', () => {
    const profile = resolveInvokerInstanceProfile({
      kind: 'source-development',
      sourceRoot: '/Users/dev/worktrees/c',
      homeDir: HOME,
    });

    const paths = [profile.ipcSocketPath, profile.configPath, profile.envPath, profile.logPath];
    expect(new Set(paths).size).toBe(paths.length);
  });
});
