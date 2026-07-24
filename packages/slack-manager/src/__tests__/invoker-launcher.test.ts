import { describe, it, expect } from 'vitest';

import { LINUX_HEADLESS_ELECTRON_FLAGS } from '@invoker/contracts';

import { resolveOwnerLaunch } from '../invoker-launcher.js';

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
      command: 'xvfb-run',
      args: [
        '--auto-servernum',
        './scripts/electron.cjs',
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
