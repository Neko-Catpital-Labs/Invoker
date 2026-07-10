import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';

import { seedMainProcessHitchFixture } from '../main-process-hitch-fixture.js';

describe('dag-click getEvents pagination cost', () => {
  let tmpDir: string | undefined;
  let adapter: SQLiteAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('proves unbounded getEvents is expensive while a limited page stays cheap', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-dag-click-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 1,
      eventsPerTask: 20_000,
      actionsPerKind: 1,
    });
    const taskId = `${seeded.workflowId}/t0`;

    const unboundedStarted = performance.now();
    const unbounded = adapter.getEvents(taskId);
    const unboundedMs = performance.now() - unboundedStarted;

    const boundedStarted = performance.now();
    const bounded = adapter.getEvents(taskId, 'desc', 50);
    const boundedMs = performance.now() - boundedStarted;

    expect(unbounded.length).toBe(20_000);
    expect(bounded.length).toBe(50);
    expect(unboundedMs).toBeGreaterThan(boundedMs);
    expect(boundedMs).toBeLessThan(25);
    expect(unboundedMs).toBeGreaterThan(10);
  });

  it('supports beforeId cursor pages without loading full history', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-dag-click-cursor-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 1,
      eventsPerTask: 120,
      actionsPerKind: 1,
    });
    const taskId = `${seeded.workflowId}/t0`;

    const first = adapter.getEvents(taskId, 'desc', 50);
    expect(first).toHaveLength(50);
    const oldestOnPage = first[first.length - 1]!;
    const second = adapter.getEvents(taskId, 'desc', 50, oldestOnPage.id);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((event) => event.id < oldestOnPage.id)).toBe(true);
    expect(new Set([...first, ...second].map((e) => e.id)).size).toBe(first.length + second.length);
  });
});
