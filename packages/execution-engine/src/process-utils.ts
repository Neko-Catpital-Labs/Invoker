import type { ChildProcess } from 'node:child_process';

export const SIGKILL_TIMEOUT_MS = 5_000;

/**
 * Sends a signal to the entire process group.
 * Uses negative PID to target the group when the process was spawned with detached: true.
 */
export function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}

/** Strip Electron-specific env vars so child processes use the system Node.js. */
export function cleanElectronEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}
