import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInvokerHomeCleanupScript,
  cleanupLocalInvokerHome,
  DiskCleanupCooldownTracker,
  isSafeInvokerHome,
  isSafeRemoteInvokerHomePath,
  resolveDiskCleanupCooldownMs,
  resolveDiskCleanupEnabled,
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

  it('embeds path guards and provision-only pkill in the remote script', () => {
    const script = buildInvokerHomeCleanupScript('~/.invoker');
    expect(script).toContain('Refusing unsafe INVOKER_HOME');
    expect(script).toContain("pkill -9 -f 'pnpm install");
    expect(script).not.toContain('pkill -9 -f "$INVOKER_HOME"');
    expect(script).toContain('$INVOKER_HOME/runtime');
    expect(script).toContain('$INVOKER_HOME/repos');
    expect(script).toContain('$INVOKER_HOME/worktrees');
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
  it('wipes runtime/repos/worktrees and recreates empty dirs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-disk-cleanup-'));
    tempDirs.push(root);
    const home = join(root, '.invoker');
    const userHome = root;
    mkdirSync(join(home, 'worktrees', 'abc'), { recursive: true });
    writeFileSync(join(home, 'worktrees', 'abc', 'file.txt'), 'x');
    mkdirSync(join(home, 'repos', 'abc'), { recursive: true });
    writeFileSync(join(home, 'repos', 'abc', 'file.txt'), 'x');
    mkdirSync(join(home, 'runtime', 'ssh'), { recursive: true });
    writeFileSync(join(home, 'invoker.db'), 'keep-me');

    const result = await cleanupLocalInvokerHome({
      invokerHome: home,
      userHome,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe('critical-cleanup');
    expect(existsSync(join(home, 'worktrees'))).toBe(true);
    expect(existsSync(join(home, 'repos'))).toBe(true);
    expect(existsSync(join(home, 'runtime'))).toBe(true);
    expect(existsSync(join(home, 'worktrees', 'abc'))).toBe(false);
    expect(existsSync(join(home, 'invoker.db'))).toBe(true);
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
