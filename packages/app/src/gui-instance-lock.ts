import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pidWasRecycledSince, readProcessStartTimeMs } from './process-start-time.js';

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
  readStartTimeMs: (pid: number) => number | null = readProcessStartTimeMs,
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
    if (existingPid && processIsAlive(existingPid)) {
      let lockCreatedAtMs: number | null = null;
      try {
        lockCreatedAtMs = statSync(pidPath).mtimeMs;
      } catch (statErr) {
        // Rare race (owner may be releasing right now): keep the lock held
        // conservatively for this attempt. Logged for debuggability.
        console.warn(`[gui-instance-lock] could not stat ${pidPath}:`, statErr);
      }
      if (!pidWasRecycledSince(existingPid, lockCreatedAtMs, readStartTimeMs)) return null;
    }

    rmSync(lockDir, { recursive: true, force: true });
    return tryAcquireGuiInstanceLock(invokerHomeRoot, pid, readStartTimeMs);
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
