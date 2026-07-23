import { describe, expect, it } from 'vitest';

import {
  buildElectronHeadlessArgs,
  LINUX_HEADLESS_ELECTRON_FLAGS,
  resolveHeadlessOwnerLaunchSpec,
} from '../headless-owner-launch.js';

describe('buildElectronHeadlessArgs', () => {
  it('prepends the Linux stability flags before the app entry point', () => {
    expect(buildElectronHeadlessArgs('/repo/packages/app/dist/main.js', ['owner-serve'], 'linux')).toEqual([
      ...LINUX_HEADLESS_ELECTRON_FLAGS,
      '/repo/packages/app/dist/main.js',
      '--headless',
      'owner-serve',
    ]);
  });

  it('keeps non-Linux launches free of Linux-only switches', () => {
    expect(buildElectronHeadlessArgs('/repo/packages/app/dist/main.js', ['owner-serve'], 'darwin')).toEqual([
      '/repo/packages/app/dist/main.js',
      '--headless',
      'owner-serve',
    ]);
  });
});

describe('resolveHeadlessOwnerLaunchSpec', () => {
  it('prefers INVOKER_GUI_COMMAND when set', () => {
    expect(resolveHeadlessOwnerLaunchSpec({
      repoRoot: '/repo',
      platform: 'linux',
      env: { INVOKER_GUI_COMMAND: '/usr/local/bin/custom-owner --flag' },
      which: () => undefined,
      existsSync: () => false,
    })).toEqual({
      command: '/usr/local/bin/custom-owner',
      args: ['--flag'],
    });
  });

  it('uses the packaged invoker-ui wrapper when present', () => {
    expect(resolveHeadlessOwnerLaunchSpec({
      repoRoot: '/repo',
      platform: 'linux',
      env: {},
      which: (command) => (command === 'invoker-ui' ? '/usr/local/bin/invoker-ui' : undefined),
      existsSync: () => false,
    })).toEqual({
      command: '/usr/local/bin/invoker-ui',
      args: ['--headless', 'owner-serve'],
    });
  });

  it('falls back to the repo Electron owner-serve path on Linux', () => {
    expect(resolveHeadlessOwnerLaunchSpec({
      repoRoot: '/repo',
      platform: 'linux',
      env: {},
      which: () => undefined,
      existsSync: (path) => path === '/repo/scripts/electron.cjs' || path === '/repo/packages/app/dist/main.js',
    })).toEqual({
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

  it('falls back to the repo Electron owner-serve path on macOS', () => {
    expect(resolveHeadlessOwnerLaunchSpec({
      repoRoot: '/repo',
      platform: 'darwin',
      env: {},
      which: () => undefined,
      existsSync: (path) => path === '/repo/scripts/electron.cjs' || path === '/repo/packages/app/dist/main.js',
    })).toEqual({
      command: './scripts/electron.cjs',
      args: ['packages/app/dist/main.js', '--headless', 'owner-serve'],
      cwd: '/repo',
    });
  });

  it('throws when no packaged or repo owner path exists', () => {
    expect(() => resolveHeadlessOwnerLaunchSpec({
      repoRoot: '/repo',
      platform: 'linux',
      env: {},
      which: () => undefined,
      existsSync: () => false,
    })).toThrow(/Cannot launch Invoker headless owner/);
  });
});
