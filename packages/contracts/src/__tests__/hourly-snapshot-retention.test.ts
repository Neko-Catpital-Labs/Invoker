import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pruneHourlySnapshots } from '../hourly-snapshot-retention.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'invoker-hourly-snapshot-retention-'));
  dirs.push(dir);
  return dir;
}

function snapshotName(index: number): string {
  return `invoker.db.hourly-auto-202601010${index}0000-000Z`;
}

function writeSnapshot(dir: string, index: number, bytes: number): string {
  const name = snapshotName(index);
  writeFileSync(join(dir, name), Buffer.alloc(bytes));
  return name;
}

describe('pruneHourlySnapshots', () => {
  it('prunes to fewer than retain when total size exceeds the byte budget', () => {
    const dir = makeDir();
    for (let i = 0; i < 5; i += 1) writeSnapshot(dir, i, 100);

    const removed = pruneHourlySnapshots(dir, 5, 250);

    expect(removed).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([snapshotName(3), snapshotName(4)]);
  });

  it('prunes by count alone when total size fits inside the byte budget', () => {
    const dir = makeDir();
    for (let i = 0; i < 5; i += 1) writeSnapshot(dir, i, 100);

    const removed = pruneHourlySnapshots(dir, 3, 10_000);

    expect(removed).toBe(2);
    expect(readdirSync(dir).sort()).toEqual([snapshotName(2), snapshotName(3), snapshotName(4)]);
  });

  it('always keeps the newest snapshot even when its own size exceeds the budget', () => {
    const dir = makeDir();
    writeSnapshot(dir, 0, 10);
    writeSnapshot(dir, 1, 10_000);

    const removed = pruneHourlySnapshots(dir, 5, 1);

    expect(removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([snapshotName(1)]);
  });

  it('deletes nothing when retain is zero or less', () => {
    const dir = makeDir();
    writeSnapshot(dir, 0, 100);
    writeSnapshot(dir, 1, 100);

    expect(pruneHourlySnapshots(dir, 0, 1)).toBe(0);
    expect(pruneHourlySnapshots(dir, -1, 1)).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([snapshotName(0), snapshotName(1)]);
  });

  it('falls back to the count rule alone for a snapshot whose size cannot be read', () => {
    const dir = makeDir();
    writeSnapshot(dir, 0, 100);
    const brokenName = snapshotName(1);
    symlinkSync(join(dir, 'missing-target'), join(dir, brokenName));
    writeSnapshot(dir, 2, 100);

    const removed = pruneHourlySnapshots(dir, 2, 10_000);

    expect(removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([brokenName, snapshotName(2)]);
  });

  it('never deletes snapshots without the hourly-auto prefix', () => {
    const dir = makeDir();
    writeFileSync(join(dir, 'invoker.db.manual-20260101-000000-000Z'), Buffer.alloc(100));
    for (let i = 0; i < 3; i += 1) writeSnapshot(dir, i, 100);

    const removed = pruneHourlySnapshots(dir, 1, 10_000);

    expect(removed).toBe(2);
    expect(readdirSync(dir).sort()).toEqual(
      ['invoker.db.manual-20260101-000000-000Z', snapshotName(2)].sort(),
    );
  });
});
