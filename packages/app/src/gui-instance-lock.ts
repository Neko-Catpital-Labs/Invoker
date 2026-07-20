import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface GuiInstanceLock {
  readonly lockDir: string;
  release: () => void;
}

function parsePid(raw: string): number | null {
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export function tryAcquireGuiInstanceLock(
  invokerHomeRoot: string,
  pid: number = process.pid,
): GuiInstanceLock | null {
  const lockDir = join(invokerHomeRoot, 'gui-window.lock');
  try {
    mkdirSync(invokerHomeRoot, { recursive: true });
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), `${pid}\n`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

    const pidPath = join(lockDir, 'pid');
    const existingPid = existsSync(pidPath) ? parsePid(readFileSync(pidPath, 'utf8')) : null;
    if (existingPid && processIsAlive(existingPid)) return null;

    rmSync(lockDir, { recursive: true, force: true });
    return tryAcquireGuiInstanceLock(invokerHomeRoot, pid);
  }

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
