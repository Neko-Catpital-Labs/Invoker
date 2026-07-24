import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { tryAcquireGuiInstanceLock } from '../gui-instance-lock.js';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-gui-lock-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('GUI instance lock', () => {
  it('rejects a second visible GUI for the same Invoker home', () => {
    const root = makeRoot();
    const first = tryAcquireGuiInstanceLock(root, process.pid);
    const second = tryAcquireGuiInstanceLock(root, process.pid);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    first?.release();
  });

  it('reclaims a stale GUI lock when the recorded pid is gone', () => {
    const root = makeRoot();
    const stale = tryAcquireGuiInstanceLock(root, 999_999);
    expect(stale).not.toBeNull();

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('not found'), { code: 'ESRCH' });
      throw err;
    });
    const next = tryAcquireGuiInstanceLock(root, process.pid);

    expect(killSpy).toHaveBeenCalledWith(999_999, 0);
    expect(next).not.toBeNull();
    next?.release();
  });

  it('reclaims the lock when the recorded pid was recycled by a newer process', () => {
    const root = makeRoot();
    const stale = tryAcquireGuiInstanceLock(root, 999_999);
    expect(stale).not.toBeNull();

    // Pid is "alive" (recycled by an unrelated process)…
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    // …but that process started well after the lock was written.
    const next = tryAcquireGuiInstanceLock(root, process.pid, () => Date.now() + 60_000);

    expect(next).not.toBeNull();
    next?.release();
  });

  it('keeps the lock when the holder is alive and its start time is unknown', () => {
    const root = makeRoot();
    const first = tryAcquireGuiInstanceLock(root, 999_999);
    expect(first).not.toBeNull();

    vi.spyOn(process, 'kill').mockImplementation(() => true);
    const second = tryAcquireGuiInstanceLock(root, process.pid, () => null);

    expect(second).toBeNull();
    first?.release();
  });

  it('keeps the lock when the holder started before the lock was written', () => {
    const root = makeRoot();
    // Real path: this test process acquired the lock, so ps-derived start
    // time predates the lock file.
    const first = tryAcquireGuiInstanceLock(root, process.pid);
    const second = tryAcquireGuiInstanceLock(root, process.pid);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    first?.release();
  });
});
