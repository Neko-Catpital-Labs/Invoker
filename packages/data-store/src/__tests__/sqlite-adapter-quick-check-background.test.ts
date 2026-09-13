import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SQLiteAdapter } from '../sqlite-adapter.js';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-quick-check-bg-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function countEventLoopTurnsWhile<T>(work: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  let running = true;
  const spin = (): void => {
    if (!running) return;
    turns += 1;
    setImmediate(spin);
  };
  setImmediate(spin);
  const result = await work();
  running = false;
  return { result, turns };
}

describe('SQLiteAdapter.quickCheckInBackground (hourly snapshot freeze 2026-09-12)', () => {
  it('reports a healthy database as ok', async () => {
    const adapter = await SQLiteAdapter.create(join(makeDir(), 'invoker.db'), { ownerCapability: true });
    try {
      await expect(adapter.quickCheckInBackground()).resolves.toBe(true);
    } finally {
      adapter.close();
    }
  });

  it('keeps the owner event loop turning while the integrity check runs', async () => {
    const adapter = await SQLiteAdapter.create(join(makeDir(), 'invoker.db'), { ownerCapability: true });
    try {
      const { result, turns } = await countEventLoopTurnsWhile(() => adapter.quickCheckInBackground());

      console.log(`[repro] quickCheckInBackground result=${result} eventLoopTurnsDuringCheck=${turns}`);
      expect(result).toBe(true);
      expect(turns).toBeGreaterThan(0);
    } finally {
      adapter.close();
    }
  });
});
