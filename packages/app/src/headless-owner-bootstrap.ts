import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

export const OWNER_BOOTSTRAP_LOCK_DIR = 'headless-owner-bootstrap.lock';
const DEFAULT_BOOTSTRAPPED_OWNER_IDLE_TIMEOUT_MS = '5000';
const requireFromHere = createRequire(__filename);

export type OwnerBootstrapLock = {
  lockDir: string;
  release: () => void;
};

export function tryAcquireOwnerBootstrapLock(invokerHomeRoot: string): OwnerBootstrapLock | null {
  const lockDir = join(invokerHomeRoot, OWNER_BOOTSTRAP_LOCK_DIR);

  try {
    mkdirSync(invokerHomeRoot, { recursive: true });
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
      rmSync(lockDir, { recursive: true, force: true });
      return tryAcquireOwnerBootstrapLock(invokerHomeRoot);
    } catch {
      rmSync(lockDir, { recursive: true, force: true });
      return tryAcquireOwnerBootstrapLock(invokerHomeRoot);
    }
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

function resolveInstalledElectronBinary(repoRoot: string): string | null {
  let electronPackageJson: string;
  try {
    electronPackageJson = requireFromHere.resolve('electron/package.json', {
      paths: [
        join(repoRoot, 'packages', 'app'),
        repoRoot,
      ],
    });
  } catch {
    return null;
  }

  const electronPackageDir = dirname(electronPackageJson);
  const pathFile = join(electronPackageDir, 'path.txt');
  if (!existsSync(pathFile)) return null;

  const executablePath = readFileSync(pathFile, 'utf8').trim();
  if (!executablePath) return null;

  const distRoot = process.env.ELECTRON_OVERRIDE_DIST_PATH || join(electronPackageDir, 'dist');
  const binaryPath = join(distRoot, executablePath);
  return existsSync(binaryPath) ? binaryPath : null;
}

export function spawnDetachedStandaloneOwner(
  repoRoot: string,
  extraEnv: NodeJS.ProcessEnv = {},
): void {
  const electronLauncher = resolve(repoRoot, 'scripts', 'electron.cjs');
  const electronBinary = resolveInstalledElectronBinary(repoRoot);
  const mainJs = resolve(repoRoot, 'packages', 'app', 'dist', 'main.js');
  const electronArgs = [
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
    mainJs,
    '--headless',
    'owner-serve',
  ];
  const child = spawn(electronBinary ?? process.execPath, electronBinary ? electronArgs : [electronLauncher, ...electronArgs], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...extraEnv,
      INVOKER_HEADLESS_STANDALONE: '1',
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
        extraEnv.INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS
        ?? process.env.INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS
        ?? DEFAULT_BOOTSTRAPPED_OWNER_IDLE_TIMEOUT_MS,
      LIBGL_ALWAYS_SOFTWARE: process.platform === 'linux' ? '1' : process.env.LIBGL_ALWAYS_SOFTWARE,
    },
  });
  child.unref();
}
