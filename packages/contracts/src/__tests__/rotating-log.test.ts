import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendRotatingLogLine,
  isRotatedLogShard,
  purgeOldLogShards,
} from '../rotating-log.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-rotating-log-'));
  dirs.push(dir);
  return dir;
}

function backdate(path: string, ageMs: number, nowMs: number): void {
  const seconds = (nowMs - ageMs) / 1000;
  utimesSync(path, seconds, seconds);
}

describe('appendRotatingLogLine', () => {
  it('moves the active log to a shard before a line would push it past the size limit', () => {
    const dir = makeDir();
    const logPath = join(dir, 'invoker.log');
    const line = `${'x'.repeat(39)}\n`;

    for (let i = 0; i < 5; i += 1) {
      appendRotatingLogLine(logPath, line, { maxBytes: 100, now: new Date(Date.UTC(2026, 8, 14, 3, 0, i)) });
    }

    const shards = readdirSync(dir).filter((name) => isRotatedLogShard('invoker.log', name)).sort();
    expect(shards).toHaveLength(2);
    for (const shard of shards) {
      expect(statSync(join(dir, shard)).size).toBe(80);
    }
    expect(readFileSync(logPath, 'utf8')).toBe(line);
    const total = shards.reduce((sum, shard) => sum + readFileSync(join(dir, shard), 'utf8').length, 0)
      + readFileSync(logPath, 'utf8').length;
    expect(total).toBe(line.length * 5);
  });

  it('keeps writing when another process already moved the active log away', () => {
    const dir = makeDir();
    const logPath = join(dir, 'invoker.log');
    writeFileSync(logPath, 'y'.repeat(120));
    rmSync(logPath);

    appendRotatingLogLine(logPath, 'after\n', { maxBytes: 100 });

    expect(readFileSync(logPath, 'utf8')).toBe('after\n');
  });
});

describe('purgeOldLogShards', () => {
  it('deletes shards older than the age limit and keeps the active log, recent shards, and other files', () => {
    const dir = makeDir();
    const nowMs = Date.UTC(2026, 8, 20, 0, 0, 0);
    const day = 24 * 60 * 60 * 1000;
    const oldShard = 'invoker.2026-09-10T00-00-00-000Z-1.log';
    const recentShard = 'invoker.2026-09-18T00-00-00-000Z-1.log';
    for (const name of ['invoker.log', oldShard, recentShard, 'merge-trace.log', 'notes.txt']) {
      writeFileSync(join(dir, name), 'z');
      backdate(join(dir, name), 10 * day, nowMs);
    }
    backdate(join(dir, recentShard), 2 * day, nowMs);

    const removed = purgeOldLogShards(dir, { maxAgeMs: 7 * day, nowMs });

    expect(removed).toEqual([join(dir, oldShard)]);
    expect(readdirSync(dir).sort()).toEqual(['invoker.log', 'merge-trace.log', 'notes.txt', recentShard].sort());
  });
});
