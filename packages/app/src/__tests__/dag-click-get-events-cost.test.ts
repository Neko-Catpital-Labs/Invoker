import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_EVENTS_PAGE, normalizeGetEventsOptions } from '@invoker/contracts';
import { SQLiteAdapter } from '@invoker/data-store';

import { getEventsPage } from '../get-events-page.js';
import { registerReadOnlyIpcHandlers } from '../ipc-read-handlers.js';
import { buildOwnerReadQueryHandlers } from '../owner-read-query.js';
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

  it('proves unbounded getEvents is expensive while a bounded page stays cheap', async () => {
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
    const bounded = getEventsPage(adapter, taskId, { limit: 50, sortBy: 'desc' });
    const boundedMs = performance.now() - boundedStarted;

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

  it('rejects an oversized limit at the IPC handler and owner-read-query getEvents call sites', async () => {
    const getEvents = vi.fn();
    const oversized = { limit: MAX_EVENTS_PAGE + 1, sortBy: 'desc' as const };

    const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
    registerReadOnlyIpcHandlers({
      ipcMain: {
        handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
          ipcHandlers.set(channel, handler);
        },
      } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      persistence: { getEvents } as never,
      getOrchestrator: () => ({}) as never,
      agentRegistry: {} as never,
      loadTaskByIdFromPersistence: () => undefined,
      resolveAgentSession: vi.fn(async () => null),
      recordStartupDuration: vi.fn(),
      getTaskDeltaStreamSequence: () => 0,
    });
    await expect(ipcHandlers.get('invoker:get-events')?.({}, 't-1', oversized)).rejects.toThrow(/between 1 and/);
    expect(getEvents).not.toHaveBeenCalled();

    const ownerReadHandlers = buildOwnerReadQueryHandlers({
      ownerModeLabel: 'gui',
      getUiPerfStats: () => ({}),
      resetUiPerfStats: () => {},
      getStreamSequence: () => 0,
      getWorkerStatus: () => ({ generatedAt: 'now', workers: [] }),
      getWorkers: () => ({ generatedAt: 'now', workers: [] }),
      resolveInvokerHomeRoot: () => '/home',
      orchestrator: {} as never,
      persistence: { getEvents } as never,
      getActionGraphSnapshot: () => ({}),
      getPlanningChatSession: () => null,
    });
    expect(() => ownerReadHandlers.getEvents('t-1', oversized)).toThrow(/between 1 and/);
    expect(getEvents).not.toHaveBeenCalled();
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

    const first = getEventsPage(adapter, taskId, { limit: 50, sortBy: 'desc' });
    expect(first).toHaveLength(50);
    const oldestOnPage = first[first.length - 1]!;
    const second = getEventsPage(adapter, taskId, {
      limit: 50,
      sortBy: 'desc',
      beforeId: oldestOnPage.id,
    });
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((event) => event.id < oldestOnPage.id)).toBe(true);
    expect(new Set([...first, ...second].map((e) => e.id)).size).toBe(first.length + second.length);
  });
});
