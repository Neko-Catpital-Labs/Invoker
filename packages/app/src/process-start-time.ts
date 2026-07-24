/**
 * PID-recycling detection shared by the mkdir-based lock files
 * (gui-instance-lock, db-writer-lock).
 *
 * A pid sentinel alone cannot prove a lock is still owned: after a hard kill
 * the OS can hand the recorded pid to an unrelated process, so `kill(pid, 0)`
 * keeps succeeding forever. Comparing the live process's start time against
 * the lock's creation time disambiguates — a process that started after the
 * lock was written cannot be the process that wrote it.
 */

import { execFileSync } from 'node:child_process';

/**
 * Tolerance when comparing lock-file mtime against a process start time
 * derived from `ps -o etime=` (1s granularity, plus fs timestamp rounding).
 */
const PID_REUSE_SKEW_MS = 2_000;

/** Parse `ps -o etime=` output ([[dd-]hh:]mm:ss) into seconds. */
export function parseEtimeSeconds(raw: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400
    + Number(hours ?? 0) * 3_600
    + Number(minutes) * 60
    + Number(seconds)
  );
}

/**
 * Best-effort start time (epoch ms) of a live process, via `ps -o etime=`.
 * Returns null when it cannot be determined (Windows, `ps` failure, parse
 * failure) — callers must treat null conservatively.
 */
export function readProcessStartTimeMs(pid: number, now: number = Date.now()): number | null {
  if (process.platform === 'win32') return null;
  let raw: string;
  try {
    raw = execFileSync('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' });
  } catch (err) {
    // Not fatal: callers fall back to treating the lock holder as alive.
    // Logged so a repeatedly-stuck lock can be debugged.
    console.warn(`[process-start-time] could not read start time of pid ${pid}:`, err);
    return null;
  }
  const seconds = parseEtimeSeconds(raw);
  if (seconds === null) return null;
  return now - seconds * 1_000;
}

/**
 * True when the live process at `pid` started after the lock was created,
 * which means the OS recycled the pid after the original owner died (e.g.
 * the owner was SIGKILLed and an unrelated process later got the same pid).
 * A genuine lock owner always starts before it writes the lock.
 *
 * Conservative: returns false when either timestamp is unknown.
 */
export function pidWasRecycledSince(
  pid: number,
  lockCreatedAtMs: number | null,
  readStartTimeMs: (pid: number) => number | null = readProcessStartTimeMs,
): boolean {
  if (lockCreatedAtMs === null) return false;
  const startedAtMs = readStartTimeMs(pid);
  if (startedAtMs === null) return false;
  return startedAtMs > lockCreatedAtMs + PID_REUSE_SKEW_MS;
}
