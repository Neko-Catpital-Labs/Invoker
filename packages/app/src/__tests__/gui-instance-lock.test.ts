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
});
