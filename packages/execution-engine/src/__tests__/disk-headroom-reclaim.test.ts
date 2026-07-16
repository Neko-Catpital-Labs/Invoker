import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInvokerHomeCleanupScript,
  cleanupLocalInvokerHome,
  DISK_RECLAIMABLE_DIRS,
  DiskCleanupCooldownTracker,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
  reapLocalTmpScratch,
  resolveDiskCleanupCooldownMs,
  resolveDiskCleanupEnabled,
  resolveTmpScratchDir,
  TMP_SCRATCH_GLOBS,
  TMP_SCRATCH_MIN_AGE_MINUTES,
} from '../workers/disk-headroom-reclaim.js';

/** Create a temp entry with an mtime `ageMinutes` in the past. */
function makeAgedDir(parent: string, name: string, ageMinutes: number, nowMs: number): string {
  const full = join(parent, name);
  mkdirSync(full, { recursive: true });
  writeFileSync(join(full, 'payload.bin'), 'x');
  const seconds = (nowMs - ageMinutes * 60_000) / 1000;
  utimesSync(full, seconds, seconds);
  return full;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('disk-headroom cleanup guards', () => {
  it('rejects unsafe invoker homes', () => {
    expect(isSafeInvokerHome('', '/Users/me')).toBe(false);
    expect(isSafeInvokerHome('/', '/Users/me')).toBe(false);
    expect(isSafeInvokerHome('~', '/Users/me')).toBe(false);
    expect(isSafeInvokerHome('/Users/me', '/Users/me')).toBe(false);
    expect(isSafeInvokerHome('/Users/me/', '/Users/me')).toBe(false);
    expect(isSafeInvokerHome('/Users/me/.invoker', '/Users/me')).toBe(true);
    expect(isSafeInvokerHome('~/.invoker', '/Users/me')).toBe(true);
  });

  it('rejects unsafe remote path literals', () => {
    expect(isSafeRemoteInvokerHomePath('')).toBe(false);
    expect(isSafeRemoteInvokerHomePath('/')).toBe(false);
    expect(isSafeRemoteInvokerHomePath('~')).toBe(false);
    expect(isSafeRemoteInvokerHomePath('$HOME')).toBe(false);
    expect(isSafeRemoteInvokerHomePath('~/.invoker')).toBe(true);
    expect(isSafeRemoteInvokerHomePath('/home/invoker/.invoker')).toBe(true);
  });

  it('embeds path guards, reclaimable dirs, and sync delete in the remote script', () => {
    const script = buildInvokerHomeCleanupScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("pkill -9 -f 'pnpm install");
    expect(script).not.toContain('pkill -9 -f "$INVOKER_HOME"');
    for (const name of DISK_RECLAIMABLE_DIRS) {
      expect(script).toContain(`$INVOKER_HOME/${name}`);
    }
    expect(script).toContain('*.deleting.*');
    expect(script).not.toContain('nohup');
    expect(script).not.toMatch(/rm -rf[^\n]*&\s*$/m);
    expect(script).not.toContain('$HOME/.cache/electron');
    expect(script).not.toContain('$HOME/.local/share/pnpm');
    expect(script).not.toContain('$HOME/.pnpm-store');
  });

  it('reclaims the pr-cron-work scratch dir', () => {
    expect(DISK_RECLAIMABLE_DIRS).toContain('pr-cron-work');
    const script = buildInvokerHomeCleanupScript('~/.invoker');
    expect(script).toContain('$INVOKER_HOME/pr-cron-work');
  });

  it('sweeps only Invoker/test scratch from the shared temp dir, never a blanket /tmp wipe', () => {
    const script = buildInvokerHomeCleanupScript('~/.invoker');
    // Resolves the temp dir with a safe fallback, and re-anchors unsafe values to /tmp.
    expect(script).toContain('TMP_CLEAN="${TMPDIR:-/tmp}"');
    expect(script).toContain('TMP_CLEAN=/tmp');
    for (const glob of TMP_SCRATCH_GLOBS) {
      expect(script).toContain(glob);
    }
    // Age guard protects in-flight runs; system + lock entries are excluded.
    expect(script).toContain(`-mmin +${TMP_SCRATCH_MIN_AGE_MINUTES}`);
    expect(script).toContain("! -name 'systemd-private-*'");
    expect(script).toContain("! -name 'ssh-*'");
    expect(script).toContain("! -name '*.lock'");
    // Must never wipe the whole temp dir.
    expect(script).not.toMatch(/rm -rf ["']?\/tmp["']?\s/);
    expect(script).not.toMatch(/rm -rf ["']?\$TMP_CLEAN["']?\s*$/m);
    expect(script).not.toContain('rm -rf "$TMP_CLEAN"/*');
  });

  it('age-gates the targeted glob sweep and never deletes the live invoker home', () => {
    const script = buildInvokerHomeCleanupScript('~/.invoker');
    // The targeted glob loop must be age-gated (find + -mmin), not an un-aged `rm -rf`.
    expect(script).not.toContain('rm -rf "$TMP_CLEAN"/$pat');
    expect(script).toMatch(/find "\$TMP_CLEAN"[^\n]*-name "\$pat"[^\n]*-mmin \+/);
    // Globbing is disabled around the pattern loop so patterns can't expand against the CWD.
    expect(script).toContain('set -f');
    expect(script).toContain('set +f');
    // Both sweeps refuse to touch the live invoker home.
    expect(script.match(/! -path "\$INVOKER_HOME"/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('disk-headroom cleanup env', () => {
  it('enables cleanup by default and honors disable flags', () => {
    expect(resolveDiskCleanupEnabled({})).toBe(true);
    expect(resolveDiskCleanupEnabled({ INVOKER_DISK_CLEANUP_ENABLED: '0' })).toBe(false);
    expect(resolveDiskCleanupEnabled({ INVOKER_DISK_CLEANUP_ENABLED: 'false' })).toBe(false);
    expect(resolveDiskCleanupEnabled({ INVOKER_DISK_CLEANUP_ENABLED: '1' })).toBe(true);
  });

  it('resolves cooldown ms with a 30m default', () => {
    expect(resolveDiskCleanupCooldownMs({})).toBe(30 * 60 * 1000);
    expect(resolveDiskCleanupCooldownMs({ INVOKER_DISK_CLEANUP_COOLDOWN_MS: '1000' })).toBe(1000);
    expect(resolveDiskCleanupCooldownMs({ INVOKER_DISK_CLEANUP_COOLDOWN_MS: 'nope' })).toBe(30 * 60 * 1000);
  });
});

describe('DiskCleanupCooldownTracker', () => {
  it('allows first cleanup then blocks until cooldown elapses', () => {
    const tracker = new DiskCleanupCooldownTracker(60_000);
    expect(tracker.canCleanup('local /tmp/x', 1000)).toBe(true);
    tracker.markCleaned('local /tmp/x', 1000);
    expect(tracker.canCleanup('local /tmp/x', 30_000)).toBe(false);
    expect(tracker.canCleanup('local /tmp/x', 61_000)).toBe(true);
    expect(tracker.canCleanup('other', 30_000)).toBe(true);
  });
});

describe('cleanupLocalInvokerHome', () => {
  it('wipes reclaimable dirs, orphans, and recreates empty dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-disk-cleanup-'));
    tempDirs.push(root);
    const home = join(root, '.invoker');
    const userHome = root;
    mkdirSync(join(home, 'worktrees', 'abc'), { recursive: true });
    writeFileSync(join(home, 'worktrees', 'abc', 'file.txt'), 'x');
    mkdirSync(join(home, 'repos', 'abc'), { recursive: true });
    writeFileSync(join(home, 'repos', 'abc', 'file.txt'), 'x');
    mkdirSync(join(home, 'runtime', 'ssh'), { recursive: true });
    mkdirSync(join(home, 'merge-clones', 'gate-wf'), { recursive: true });
    writeFileSync(join(home, 'merge-clones', 'gate-wf', 'file.txt'), 'x');
    mkdirSync(join(home, 'merge-launches', 'launch-1'), { recursive: true });
    writeFileSync(join(home, 'merge-launches', 'launch-1', 'file.txt'), 'x');
    mkdirSync(join(home, 'merge-clones.deleting.123', 'stale'), { recursive: true });
    writeFileSync(join(home, 'merge-clones.deleting.123', 'stale', 'file.txt'), 'x');
    writeFileSync(join(home, 'invoker.db'), 'keep-me');
    mkdirSync(join(home, 'plans'), { recursive: true });
    writeFileSync(join(home, 'plans', 'keep.yaml'), 'name: keep');
    mkdirSync(join(userHome, '.cache', 'electron'), { recursive: true });
    writeFileSync(join(userHome, '.cache', 'electron', 'keep.bin'), 'x');

    const result = await cleanupLocalInvokerHome({
      invokerHome: home,
      userHome,
      // Isolate the scratch reap onto an empty sandbox so the test never
      // touches the machine's real temp dir.
      tmpDir: join(root, 'empty-tmp'),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('critical-cleanup');
    for (const name of DISK_RECLAIMABLE_DIRS) {
      expect(existsSync(join(home, name))).toBe(true);
      expect(readdirSync(join(home, name))).toEqual([]);
    }
    expect(existsSync(join(home, 'merge-clones.deleting.123'))).toBe(false);
    expect(existsSync(join(home, 'worktrees', 'abc'))).toBe(false);
    expect(existsSync(join(home, 'merge-launches', 'launch-1'))).toBe(false);
    expect(existsSync(join(home, 'invoker.db'))).toBe(true);
    expect(existsSync(join(home, 'plans', 'keep.yaml'))).toBe(true);
    expect(existsSync(join(userHome, '.cache', 'electron', 'keep.bin'))).toBe(true);
  });

  it('refuses to clean the user home itself', async () => {
    const result = await cleanupLocalInvokerHome({
      invokerHome: '/Users/me',
      userHome: '/Users/me',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('path-guard');
  });

  it('reaps a stale orphaned scratch home from the shared temp dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-disk-cleanup-tmp-'));
    tempDirs.push(root);
    const home = join(root, '.invoker');
    mkdirSync(home, { recursive: true });
    const fakeTmp = join(root, 'tmp');
    mkdirSync(fakeTmp, { recursive: true });
    const nowMs = 1_000_000_000_000;
    const stale = makeAgedDir(fakeTmp, 'invoker-e2e-db.OLD', 120, nowMs);
    const fresh = makeAgedDir(fakeTmp, 'invoker-e2e-db.NEW', 5, nowMs);

    const result = await cleanupLocalInvokerHome({
      invokerHome: home,
      userHome: root,
      tmpDir: fakeTmp,
      nowMs,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('resolveTmpScratchDir', () => {
  it('uses TMPDIR when safe and falls back to /tmp otherwise', () => {
    expect(resolveTmpScratchDir({ TMPDIR: '/scratch/tmp/' }, '/home/me')).toBe('/scratch/tmp');
    expect(resolveTmpScratchDir({}, '/home/me')).toBe('/tmp');
    expect(resolveTmpScratchDir({ TMPDIR: '/' }, '/home/me')).toBe('/tmp');
    expect(resolveTmpScratchDir({ TMPDIR: '/home/me' }, '/home/me')).toBe('/tmp');
  });
});

describe('reapLocalTmpScratch', () => {
  const nowMs = 1_000_000_000_000;

  function sandbox(): string {
    const root = mkdtempSync(join(tmpdir(), 'invoker-tmp-reap-'));
    tempDirs.push(root);
    return root;
  }

  it('removes stale Invoker/test scratch but preserves fresh entries', () => {
    const tmp = sandbox();
    const staleInvoker = makeAgedDir(tmp, 'invoker-e2e-db.old', 90, nowMs);
    const staleEsbuild = makeAgedDir(tmp, 'esbuild-abc.map', 90, nowMs);
    const freshInvoker = makeAgedDir(tmp, 'invoker-e2e-db.fresh', 10, nowMs);

    const errors: string[] = [];
    reapLocalTmpScratch({ tmpDir: tmp, nowMs }, errors);

    expect(errors).toEqual([]);
    expect(existsSync(staleInvoker)).toBe(false);
    expect(existsSync(staleEsbuild)).toBe(false);
    expect(existsSync(freshInvoker)).toBe(true);
  });

  it('blanket-sweeps stale non-Invoker entries but never excluded system/lock entries', () => {
    const tmp = sandbox();
    const staleJunk = makeAgedDir(tmp, 'random-junk', 90, nowMs);
    const staleClaude = makeAgedDir(tmp, 'claude-1000', 90, nowMs);
    const staleSystemd = makeAgedDir(tmp, 'systemd-private-abc', 90, nowMs);
    const staleLock = makeAgedDir(tmp, 'session.lock', 90, nowMs);

    const errors: string[] = [];
    reapLocalTmpScratch({ tmpDir: tmp, nowMs }, errors);

    expect(existsSync(staleJunk)).toBe(false);
    expect(existsSync(staleClaude)).toBe(true);
    expect(existsSync(staleSystemd)).toBe(true);
    expect(existsSync(staleLock)).toBe(true);
  });

  it('never deletes the live invoker home even when it is stale scratch under /tmp', () => {
    const tmp = sandbox();
    const selfHome = makeAgedDir(tmp, 'invoker-e2e-db.self', 240, nowMs);

    const errors: string[] = [];
    reapLocalTmpScratch({ tmpDir: tmp, nowMs, selfHome }, errors);

    expect(existsSync(selfHome)).toBe(true);
  });

  it('is a no-op for unsafe or missing temp dirs', () => {
    const errors: string[] = [];
    reapLocalTmpScratch({ tmpDir: '/', nowMs }, errors);
    reapLocalTmpScratch({ tmpDir: '', nowMs }, errors);
    reapLocalTmpScratch({ tmpDir: join(sandbox(), 'does-not-exist'), nowMs }, errors);
    expect(errors).toEqual([]);
  });
});
