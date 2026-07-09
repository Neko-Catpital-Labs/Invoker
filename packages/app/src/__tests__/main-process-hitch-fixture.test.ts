import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';

import { seedMainProcessHitchFixture } from '../main-process-hitch-fixture.js';

describe('seedMainProcessHitchFixture', () => {
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

  it('seeds enough events and worker actions for hitch e2e', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'invoker-hitch-seed-'));
    adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });

    const seeded = seedMainProcessHitchFixture(adapter, {
      taskCount: 4,
      eventsPerTask: 10,
      actionsPerKind: 2,
    });

    expect(seeded.eventCount).toBe(40);
    expect(seeded.workerActionCount).toBeGreaterThan(0);
    expect(adapter.listWorkflows().some((wf) => wf.id === seeded.workflowId)).toBe(true);
    expect(adapter.listWorkerActions({ limit: 5 }).length).toBeGreaterThan(0);
  });
});
