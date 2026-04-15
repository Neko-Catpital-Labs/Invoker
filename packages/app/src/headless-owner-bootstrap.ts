import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

export const OWNER_BOOTSTRAP_LOCK_DIR = 'headless-owner-bootstrap.lock';

export type OwnerBootstrapLock = {
  lockDir: string;
  release: () => void;
};

export function tryAcquireOwnerBootstrapLock(invokerHomeRoot: string): OwnerBootstrapLock | null {
  const lockDir = join(invokerHomeRoot, OWNER_BOOTSTRAP_LOCK_DIR);

  try {
    mkdirSync(lockDir);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pidFile = join(lockDir, 'pid');
    try {
      const holderPid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (!Number.isNaN(holderPid)) {
        try {
          process.kill(holderPid, 0);
          return null;
        } catch {
          rmSync(lockDir, { recursive: true, force: true });
          return tryAcquireOwnerBootstrapLock(invokerHomeRoot);
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  writeFileSync(join(lockDir, 'pid'), String(process.pid), 'utf8');
  let released = false;
  return {
    lockDir,
    release: () => {
      if (released) return;
      released = true;
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

export function spawnDetachedStandaloneOwner(
  repoRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  const electronBin = resolve(repoRoot, 'packages', 'app', 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const mainJs = resolve(repoRoot, 'packages', 'app', 'dist', 'main.js');
  const args = [
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    mainJs,
    '--headless',
    'owner-serve',
  ];
  const child = spawn(electronBin, args, {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...extraEnv,
      INVOKER_HEADLESS_STANDALONE: '1',
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
  });
  child.unref();
}
