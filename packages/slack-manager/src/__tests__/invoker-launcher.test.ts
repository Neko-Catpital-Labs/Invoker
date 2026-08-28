import { describe, it, expect } from 'vitest';

import { LINUX_HEADLESS_ELECTRON_FLAGS } from '@invoker/contracts';

import { buildOwnerSpawnEnv, resolveOwnerLaunch, withoutMissingPathEntries } from '../invoker-launcher.js';

describe('withoutMissingPathEntries', () => {
  const exists = (path: string) => path !== '/snap/bin' && path !== '/gone';

  it('drops directories that do not exist so the owner does not segfault at startup', () => {
    expect(withoutMissingPathEntries('/usr/bin:/snap/bin', exists)).toBe('/usr/bin');
  });

  it('keeps a PATH whose entries all exist unchanged', () => {
    expect(withoutMissingPathEntries('/usr/local/bin:/usr/bin:/bin', exists)).toBe(
      '/usr/local/bin:/usr/bin:/bin',
    );
  });

  it('drops empty entries rather than leaving an implicit current directory', () => {
    expect(withoutMissingPathEntries('/usr/bin::/bin', exists)).toBe('/usr/bin:/bin');
  });

  it('passes an unset PATH through untouched', () => {
    expect(withoutMissingPathEntries(undefined, exists)).toBeUndefined();
  });
});

describe('resolveOwnerLaunch', () => {
  it('prefers INVOKER_GUI_COMMAND when set', () => {
    const spec = resolveOwnerLaunch({
      repoRoot: '/repo',
      platform: 'darwin',
      env: { INVOKER_GUI_COMMAND: '/opt/invoker-owner --flag' },
      which: () => undefined,
      existsSync: () => false,
    });
    expect(spec).toEqual({
      command: '/opt/invoker-owner',
      args: ['--flag', '--headless', 'owner-serve'],
    });
  });

  it('uses invoker-ui in headless owner mode when it is on PATH', () => {
    const spec = resolveOwnerLaunch({
      repoRoot: '/repo',
      platform: 'darwin',
      env: {},
      which: (command) => (command === 'invoker-ui' ? '/usr/local/bin/invoker-ui' : undefined),
      existsSync: () => false,
    });
    expect(spec).toEqual({
      command: '/usr/local/bin/invoker-ui',
      args: ['--headless', 'owner-serve'],
    });
  });

  it('launches invoker-ui with the Linux stability flags so a host without a configured Chromium sandbox still starts', () => {
    const spec = resolveOwnerLaunch({
      repoRoot: '/repo',
      platform: 'linux',
      env: {},
      which: (command) => (command === 'invoker-ui' ? '/usr/local/bin/invoker-ui' : undefined),
      existsSync: () => false,
    });
    expect(spec).toEqual({
      command: '/usr/local/bin/invoker-ui',
      args: [...LINUX_HEADLESS_ELECTRON_FLAGS, '--headless', 'owner-serve'],
    });
  });

  it('uses the repo headless owner path on Linux when checkout artifacts exist', () => {
    const spec = resolveOwnerLaunch({
      repoRoot: '/repo',
      platform: 'linux',
      env: {},
      which: () => undefined,
      existsSync: (path) =>
        path === '/repo/scripts/electron.cjs' || path === '/repo/packages/app/dist/main.js',
    });
    expect(spec).toEqual({
      command: './scripts/electron.cjs',
      args: [
        ...LINUX_HEADLESS_ELECTRON_FLAGS,
        'packages/app/dist/main.js',
        '--headless',
        'owner-serve',
      ],
      cwd: '/repo',
    });
  });

  it('throws when no headless owner launch path is available', () => {
    expect(() =>
      resolveOwnerLaunch({
        repoRoot: '/repo',
        platform: 'linux',
        env: {},
        which: () => undefined,
        existsSync: () => false,
      }),
    ).toThrow(/Cannot launch Invoker headless owner/);
  });
});

describe('buildOwnerSpawnEnv', () => {
  it('declares the spawn as the real production owner service', () => {
    // Regression: scripts/electron.cjs wraps every launch into an isolated
    // source-development database unless this flag says otherwise. Confirmed
    // live on DigitalOcean 1 (a source-checkout host with no packaged
    // invoker-ui on PATH): production's invoker.db stopped being written
    // while a fresh ~/.invoker/dev/<hash>/ sandbox was written instead.
    const env = buildOwnerSpawnEnv({}, 'linux');
    expect(env.INVOKER_PRODUCTION_OWNER_SERVICE).toBe('1');
  });

  it('still strips Slack credentials and normalizes PATH/LIBGL as before', () => {
    const env = buildOwnerSpawnEnv(
      { SLACK_BOT_TOKEN: 'xoxb-test', PATH: '/usr/bin:/snap/bin' },
      'linux',
      (path) => path !== '/snap/bin',
    );
    expect(env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LIBGL_ALWAYS_SOFTWARE).toBe('1');
  });
});
