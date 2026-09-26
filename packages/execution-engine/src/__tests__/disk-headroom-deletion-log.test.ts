import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildInvokerHomeCleanupScript,
  cleanupLocalInvokerHome,
  type DiskHeadroomWorkerStore,
} from '../workers/disk-headroom-reclaim.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function messages(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((call) => String(call[0]));
}

describe('disk-headroom cleanup deletion log', () => {
  it('logs every local path it removes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-disk-deletion-log-'));
    tempDirs.push(root);
    const home = join(root, '.invoker');
    const doomed = join(home, 'worktrees', 'abc');
    mkdirSync(doomed, { recursive: true });
    writeFileSync(join(doomed, 'file.txt'), 'x');
    const logger = makeLogger();

    await cleanupLocalInvokerHome({ invokerHome: home, userHome: root, logger: logger as never });

    expect(existsSync(doomed)).toBe(false);
    expect(messages(logger.info).some((m) => m.includes('removed') && m.includes(doomed))).toBe(true);
  });

  it('logs the store error when the in-use lookup fails, and skips the pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-disk-deletion-store-error-'));
    tempDirs.push(root);
    const home = join(root, '.invoker');
    const someDir = join(home, 'worktrees', 'some-task');
    mkdirSync(someDir, { recursive: true });
    writeFileSync(join(someDir, 'file.txt'), 'x');
    const throwingStore: DiskHeadroomWorkerStore = {
      listWorkflows: () => { throw new Error('db unavailable'); },
      loadTasks: () => [],
    };
    const logger = makeLogger();

    const result = await cleanupLocalInvokerHome({ invokerHome: home, userHome: root, store: throwingStore, logger: logger as never });

    expect(result.ok).toBe(false);
    expect(existsSync(someDir)).toBe(true);
    const errors = messages(logger.error);
    expect(errors.some((m) => m.includes('in-use lookup failed') && m.includes('db unavailable'))).toBe(true);
  });

  it('prints one line per path the remote script removes', () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-remote-deletion-log-'));
    tempDirs.push(root);
    const invokerHome = join(root, 'home');
    const isolatedTmp = join(root, 'scratch-tmp');
    mkdirSync(isolatedTmp, { recursive: true });
    const otherDir = join(invokerHome, 'repos', 'other-hash');
    mkdirSync(otherDir, { recursive: true });
    writeFileSync(join(otherDir, 'file.txt'), 'clear-me');
    const scriptPath = join(root, 'cleanup.sh');
    writeFileSync(scriptPath, buildInvokerHomeCleanupScript(invokerHome, []));

    const result = spawnSync('bash', [scriptPath], { encoding: 'utf8', env: { ...process.env, TMPDIR: isolatedTmp } });

    expect(result.status).toBe(0);
    expect(existsSync(otherDir)).toBe(false);
    expect(result.stdout).toContain(`[disk-headroom-cleanup] remove ${otherDir}`);
  });
});
