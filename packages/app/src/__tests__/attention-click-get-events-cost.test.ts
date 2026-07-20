import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_EVENTS_PAGE, normalizeGetEventsOptions } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';

import { getEventsPage } from '../get-events-page.js';
import { seedMainProcessHitchFixture } from '../main-process-hitch-fixture.js';

/**
 * Repro: Needs Attention list clicks select a task and WorkflowInspector loads
 * logs via getEvents. An unbounded main-process read of a fat events table
 * stalls the Electron window loop (macOS beach ball). A limited page stays cheap.
 */
describe('attention-click getEvents pagination cost', () => {
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

  it('proves unbounded getEvents is expensive for an attention task while a page stays cheap', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-attention-click-events-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 1,
      eventsPerTask: 20_000,
      actionsPerKind: 1,
    });
    const taskId = `${seeded.workflowId}/t0`;
    const task = adapter.loadTask(taskId);
    expect(task).toBeDefined();
    adapter.saveTask(seeded.workflowId, {
      ...task!,
      status: 'failed',
      description: 'Attention task with fat event history',
    });

    const unboundedStarted = performance.now();
    const unbounded = adapter.getEvents(taskId);
    const unboundedMs = performance.now() - unboundedStarted;

    const boundedStarted = performance.now();
    const bounded = getEventsPage(adapter, taskId, { limit: 50, sortBy: 'desc' });
    const boundedMs = performance.now() - boundedStarted;

    expect(adapter.loadTask(taskId)?.status).toBe('failed');
    expect(unbounded.length).toBe(20_000);
    expect(bounded.length).toBe(50);
    expect(unboundedMs).toBeGreaterThan(boundedMs);
    expect(boundedMs).toBeLessThan(25);
    expect(unboundedMs).toBeGreaterThan(10);
  });

  it('rejects missing or oversized limits at the public getEvents boundary', () => {
    expect(() => normalizeGetEventsOptions(undefined)).toThrow(/requires options/);
    expect(() => normalizeGetEventsOptions({})).toThrow(/limit is required/);
    expect(() => normalizeGetEventsOptions({ limit: 0 })).toThrow(/between 1 and/);
    expect(() => normalizeGetEventsOptions({ limit: MAX_EVENTS_PAGE + 1 })).toThrow(/between 1 and/);
    expect(normalizeGetEventsOptions({ limit: 50, sortBy: 'desc' })).toEqual({
      sortBy: 'desc',
      limit: 50,
    });
  });
});
