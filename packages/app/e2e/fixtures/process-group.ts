import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Process-group helpers for fixture teardown. A group kill aimed at
 * `-child.pid` only reaches the child's own tree when the child leads its own
 * process group (pgid === pid). When it does not — the child was not spawned
 * detached, or its pid matches an unrelated group's id — the same call
 * signals whichever process group happens to carry that id. On 2026-08-05 a
 * SIGTERM the production owner survived (worker + web-bridge teardown, owner
 * pgid 1164189, a long-freed pid) showed why an unverified group kill behind
 * a silent catch is not acceptable teardown behavior.
 */
export function readProcessGroupId(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
    const fields = afterComm.split(' ');
    const pgid = Number.parseInt(fields[2] ?? '', 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    // /proc unavailable (non-linux) — fall through to ps.
  }
  try {
    const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
    const pgid = Number.parseInt(out.trim(), 10);
    return Number.isFinite(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

/**
 * SIGTERM the child's process group only when the child verifiably leads it.
 * Returns what happened so callers can log it; never throws.
 */
export function killOwnedProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): 'group-killed' | 'skipped-not-leader' | 'skipped-unknown-pgid' | 'kill-failed' {
  const pgid = readProcessGroupId(pid);
  if (pgid === null) return 'skipped-unknown-pgid';
  if (pgid !== pid) return 'skipped-not-leader';
  try {
    process.kill(-pid, signal);
    return 'group-killed';
  } catch {
    return 'kill-failed';
  }
}
