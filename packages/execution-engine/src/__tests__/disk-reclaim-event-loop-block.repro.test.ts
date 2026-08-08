import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupLocalInvokerHome } from '../workers/disk-headroom-reclaim.js';

const tempDirs: string[] = [];
const FILE_CONTENT = 'x'.repeat(256);
const DIR_COUNT = 100;
const FILES_PER_DIR = 200;
const WATCHDOG_PERIOD_MS = 25;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function buildInvokerHomeWithLargeWorktree(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-disk-reclaim-event-loop-'));
  tempDirs.push(root);
  const home = join(root, '.invoker');
  const worktree = join(home, 'worktrees', 'wt-1');

  for (let dirIndex = 0; dirIndex < DIR_COUNT; dirIndex += 1) {
    const dir = join(worktree, `dir-${dirIndex}`);
    mkdirSync(dir, { recursive: true });
    for (let fileIndex = 0; fileIndex < FILES_PER_DIR; fileIndex += 1) {
      writeFileSync(join(dir, `file-${fileIndex}.txt`), FILE_CONTENT);
    }
  }

  return home;
}

async function cleanupLargeWorktree(home: string) {
  return cleanupLocalInvokerHome({
    invokerHome: home,
    userHome: join(home, '..'),
  });
}

describe('cleanupLocalInvokerHome event-loop blocking repro', () => {
  it('clears a large local worktree tree successfully', async () => {
    const home = buildInvokerHomeWithLargeWorktree();

    const result = await cleanupLargeWorktree(home);

    expect(result.ok).toBe(true);
    expect(readdirSync(join(home, 'worktrees'))).toEqual([]);
  });

  it.fails('keeps watchdog-sized event-loop lag below 250ms while sweeping local worktrees', async () => {
    const home = buildInvokerHomeWithLargeWorktree();
    let lastTick = process.hrtime.bigint();
    let maxLagMs = 0;

    const interval = setInterval(() => {
      const now = process.hrtime.bigint();
      const elapsedMs = Number(now - lastTick) / 1_000_000;
      maxLagMs = Math.max(maxLagMs, elapsedMs - WATCHDOG_PERIOD_MS);
      lastTick = now;
    }, WATCHDOG_PERIOD_MS);

    try {
      await cleanupLargeWorktree(home);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      clearInterval(interval);
    }

    expect(maxLagMs).toBeLessThan(250);
  });
});
