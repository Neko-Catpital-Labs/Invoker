import { describe, it, expect } from 'vitest';
import { resolveGuiLaunch } from '../invoker-launcher.js';

describe('resolveGuiLaunch', () => {
  it('prefers INVOKER_GUI_COMMAND when set', () => {
    const spec = resolveGuiLaunch({
      repoRoot: '/repo',
      platform: 'darwin',
      env: { INVOKER_GUI_COMMAND: '/opt/Invoker.app/Contents/MacOS/Invoker --flag' },
      which: () => undefined,
      existsSync: () => false,
    });
    expect(spec).toEqual({
      command: '/opt/Invoker.app/Contents/MacOS/Invoker',
      args: ['--flag'],
    });
  });

  it('uses invoker-ui on PATH before macOS open', () => {
    const spec = resolveGuiLaunch({
      repoRoot: '/repo',
      platform: 'darwin',
      env: {},
      which: (cmd) => (cmd === 'invoker-ui' ? '/usr/local/bin/invoker-ui' : undefined),
      existsSync: () => false,
    });
    expect(spec).toEqual({ command: '/usr/local/bin/invoker-ui', args: [] });
  });

  it('falls back to open -a Invoker on macOS', () => {
    const spec = resolveGuiLaunch({
      repoRoot: '/repo',
      platform: 'darwin',
      env: {},
      which: () => undefined,
      existsSync: () => false,
    });
    expect(spec).toEqual({ command: 'open', args: ['-a', 'Invoker'] });
  });

  it('uses monorepo xvfb-run path on Linux when checkout artifacts exist', () => {
    const spec = resolveGuiLaunch({
      repoRoot: '/repo',
      platform: 'linux',
      env: {},
      which: () => undefined,
      existsSync: (path) =>
        path === '/repo/scripts/electron.cjs' || path === '/repo/packages/app/dist/main.js',
    });
    expect(spec).toEqual({
      command: 'xvfb-run',
      args: ['--auto-servernum', './scripts/electron.cjs', 'packages/app/dist/main.js', '--no-sandbox'],
      cwd: '/repo',
    });
  });

  it('throws on Linux when no GUI launch path is available', () => {
    expect(() =>
      resolveGuiLaunch({
        repoRoot: '/repo',
        platform: 'linux',
        env: {},
        which: () => undefined,
        existsSync: () => false,
      }),
    ).toThrow(/Cannot launch Invoker GUI/);
  });
});
