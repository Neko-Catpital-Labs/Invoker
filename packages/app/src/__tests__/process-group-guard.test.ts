import { describe, expect, it, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { readProcessGroupId, killOwnedProcessGroup } from '../../e2e/fixtures/process-group.js';

// Regression fence for 2026-08-05T07:02:45Z: fixture teardown ran
// `process.kill(-child.pid, 'SIGTERM')` behind a bare silent catch without
// verifying the child leads the group with that id. A group id is just a pid;
// when the child is not its own group leader (or the pid matches a foreign
// group after pid reuse) the identical call SIGTERMs an unrelated process
// tree — the production owner survived exactly such a signal, losing all its
// workers and its web bridge. The guard only group-kills a verified leader.

const children: ChildProcess[] = [];

function spawnSleeper(opts: { detached: boolean }): Promise<ChildProcess> {
  const child = spawn('sleep', ['30'], { detached: opts.detached, stdio: 'ignore' });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* not a leader */ }
        child.kill('SIGKILL');
      }
    } catch { /* already gone */ }
  }
});

describe('process group teardown guard', () => {
  it('reads the real pgid: detached child leads its own group, non-detached child does not', async () => {
    const leader = await spawnSleeper({ detached: true });
    const follower = await spawnSleeper({ detached: false });
    expect(readProcessGroupId(leader.pid!)).toBe(leader.pid);
    expect(readProcessGroupId(follower.pid!)).toBe(process.platform === 'linux' ? readProcessGroupId(process.pid) : readProcessGroupId(follower.pid!));
    expect(readProcessGroupId(follower.pid!)).not.toBe(follower.pid);
  });

  it('group-kills a verified leader and its group', async () => {
    const leader = await spawnSleeper({ detached: true });
    const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
      leader.once('exit', (code, signal) => resolve(signal ?? code));
    });
    expect(killOwnedProcessGroup(leader.pid!, 'SIGTERM')).toBe('group-killed');
    expect(await exited).toBe('SIGTERM');
  });

  it('REPRO: the pre-fix unguarded shape signals a foreign process group; the guard refuses', async () => {
    // The victim stands in for the production owner: a detached process
    // leading a group whose id has nothing to do with the fixture's child.
    const victim = await spawnSleeper({ detached: true });
    const nonLeader = await spawnSleeper({ detached: false });

    // Pre-fix shape: kill the group with id == some pid we did not verify.
    // Aimed at the victim's group id, it reaches the victim even though the
    // victim is not the child being torn down.
    const victimExited = new Promise<NodeJS.Signals | number | null>((resolve) => {
      victim.once('exit', (code, signal) => resolve(signal ?? code));
    });
    try {
      process.kill(-victim.pid!, 'SIGTERM');
    } catch {
      // the silent catch from the pre-fix fixture
    }
    expect(await victimExited).toBe('SIGTERM');

    // Fixed shape: the guard refuses to group-kill a pid that does not lead
    // its own group, so a foreign group can never be struck via a non-leader
    // child pid.
    expect(killOwnedProcessGroup(nonLeader.pid!, 'SIGTERM')).toBe('skipped-not-leader');
    expect(nonLeader.exitCode).toBeNull();
  });
});
