import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
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
  resolveDiskCleanupCooldownMs,
  resolveDiskCleanupEnabled,
  TMP_SCRATCH_GLOBS,
  TMP_SCRATCH_MIN_AGE_MINUTES,
} from '../workers/disk-headroom-reclaim.js';

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

  it('never reaps a temp entry that holds mineable .jsonl session data', () => {
    const script = buildInvokerHomeCleanupScript('~/.invoker');
    // The reaper skips any entry containing a .jsonl (agent-session transcripts).
    expect(script).toContain('reap_tmp');
    expect(script).toContain("-name '*.jsonl'");
    // Every temp removal routes through the guard, not a raw rm.
    expect(script).toContain('reap_tmp "$entry"');
    expect(script).not.toContain('rm -rf "$TMP_CLEAN"/$pat');
    expect(script).not.toMatch(/-mmin \+\d+[\s\S]*?-exec rm -rf/);
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
});
