import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  maybeAutoInstallCli,
  resolveCliInstallerStatus,
  updateInvokerCli,
  type CliInstallerContext,
} from '../cli-installer.js';

const APP_VERSION = '0.0.3';

function writeFakeCli(filePath: string, version: string): void {
  writeFileSync(filePath, `#!/usr/bin/env bash\necho "${version}"\n`, 'utf8');
  chmodSync(filePath, 0o755);
}

describe('cli-installer', () => {
  let scratchDir: string;
  let bundledCliPath: string;
  let lockedDirs: string[];

  function makeContext(overrides: Partial<CliInstallerContext> = {}): CliInstallerContext {
    return {
      isPackaged: true,
      bundledCliPath,
      appVersion: APP_VERSION,
      platform: 'darwin',
      env: { PATH: '/usr/bin:/bin' },
      homeDir: path.join(scratchDir, 'home'),
      ...overrides,
    };
  }

  beforeEach(() => {
    scratchDir = mkdtempSync(path.join(tmpdir(), 'invoker-cli-installer-'));
    bundledCliPath = path.join(scratchDir, 'bundled-invoker-cli');
    writeFakeCli(bundledCliPath, APP_VERSION);
    lockedDirs = [];
  });

  afterEach(() => {
    for (const dir of lockedDirs) chmodSync(dir, 0o755);
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('installs into the first writable candidate dir when not installed', () => {
    const installDir = path.join(scratchDir, 'bin');
    mkdirSync(installDir);
    const context = makeContext({ candidateInstallDirs: [installDir] });

    const result = updateInvokerCli(context);

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(true);
    const installedPath = path.join(installDir, 'invoker-cli');
    expect(result.installedTo).toBe(installedPath);
    expect(statSync(installedPath).mode & 0o777).toBe(0o755);
    expect(result.status.installedVersion).toBe(APP_VERSION);
    expect(result.status.upToDate).toBe(true);
  });

  it('overwrites an outdated install found on PATH, in place', () => {
    const pathDir = path.join(scratchDir, 'on-path-bin');
    mkdirSync(pathDir);
    const existing = path.join(pathDir, 'invoker-cli');
    writeFakeCli(existing, '0.0.1');
    const context = makeContext({
      env: { PATH: `${pathDir}:/usr/bin:/bin` },
      candidateInstallDirs: [path.join(scratchDir, 'unused-bin')],
    });

    const result = updateInvokerCli(context);

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.installedTo).toBe(existing);
    expect(readFileSync(existing, 'utf8')).toContain(APP_VERSION);
    expect(result.status.upToDate).toBe(true);
  });

  it('is a no-op when the installed version matches the app version', () => {
    const pathDir = path.join(scratchDir, 'on-path-bin');
    mkdirSync(pathDir);
    const existing = path.join(pathDir, 'invoker-cli');
    writeFakeCli(existing, APP_VERSION);
    const before = readFileSync(existing, 'utf8');
    const context = makeContext({ env: { PATH: `${pathDir}:/usr/bin:/bin` } });

    const result = updateInvokerCli(context);

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(false);
    expect(readFileSync(existing, 'utf8')).toBe(before);
  });

  it('falls back to the next candidate when the first dir is unwritable', () => {
    const locked = path.join(scratchDir, 'locked-bin');
    const fallback = path.join(scratchDir, 'fallback-bin');
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    lockedDirs.push(locked);
    const context = makeContext({ candidateInstallDirs: [locked, fallback] });

    const result = updateInvokerCli(context);

    expect(result.ok).toBe(true);
    expect(result.installedTo).toBe(path.join(fallback, 'invoker-cli'));
  });

  it('warns when the install dir is not on PATH', () => {
    const installDir = path.join(scratchDir, 'off-path-bin');
    const context = makeContext({ candidateInstallDirs: [installDir] });

    const result = updateInvokerCli(context);

    expect(result.ok).toBe(true);
    expect(result.status.warning).toContain(installDir);
    expect(result.status.warning).toContain('PATH');
  });

  it('scopes detection and install to INVOKER_CLI_INSTALL_DIR when set', () => {
    const pathDir = path.join(scratchDir, 'on-path-bin');
    mkdirSync(pathDir);
    writeFakeCli(path.join(pathDir, 'invoker-cli'), APP_VERSION);
    const overrideDir = path.join(scratchDir, 'override-bin');
    const context = makeContext({
      env: { PATH: `${pathDir}:/usr/bin:/bin`, INVOKER_CLI_INSTALL_DIR: overrideDir },
    });

    const result = updateInvokerCli(context);

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.installedTo).toBe(path.join(overrideDir, 'invoker-cli'));
  });

  it('resolves status in under 4s when the installed binary hangs (main-thread guard)', () => {
    const pathDir = path.join(scratchDir, 'on-path-bin');
    mkdirSync(pathDir);
    const hanging = path.join(pathDir, 'invoker-cli');
    writeFileSync(hanging, '#!/usr/bin/env bash\nsleep 60\nexit 0\n', 'utf8');
    chmodSync(hanging, 0o755);
    const context = makeContext({ env: { PATH: `${pathDir}:/usr/bin:/bin` } });

    const startedAt = Date.now();
    const status = resolveCliInstallerStatus(context);
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(4000);
    expect(status.installedVersion).toBeUndefined();
    expect(status.upToDate).toBe(false);
  }, 6000);

  it('does nothing in non-packaged (dev) runs', () => {
    const context = makeContext({ isPackaged: false });

    expect(maybeAutoInstallCli(context, () => {})).toBeNull();
    expect(resolveCliInstallerStatus(context).supported).toBe(false);
  });

  it('reports unsupported when the bundled binary is missing', () => {
    const context = makeContext({ bundledCliPath: path.join(scratchDir, 'missing') });

    expect(resolveCliInstallerStatus(context).supported).toBe(false);
    expect(maybeAutoInstallCli(context, () => {})).toBeNull();
  });
});
