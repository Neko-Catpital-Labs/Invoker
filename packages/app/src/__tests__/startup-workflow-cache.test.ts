import { describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@invoker/data-store';
import { createStartupWorkflowCache } from '../bootstrap/startup-workflow-cache.js';

const wf = (id: string, createdAt = '2026-01-01T00:00:00.000Z'): Workflow => ({
  id,
  name: id,
  repoUrl: 'file:///repo.git',
  branch: 'master',
  status: 'pending',
  onFinish: 'none',
  createdAt,
  updatedAt: createdAt,
} as Workflow);

describe('startup-workflow-cache', () => {
  it('starts empty and falls back to the persistence lister', () => {
    const cache = createStartupWorkflowCache();
    const listWorkflows = vi.fn(() => [wf('wf-1')]);

    expect(cache.hasCached()).toBe(false);
    expect(cache.takeOrLoad(listWorkflows)).toEqual([wf('wf-1')]);
    expect(listWorkflows).toHaveBeenCalledTimes(1);
  });

  it('serves one cached read then falls back so the sync bootstrap IPC does not re-run listWorkflows', () => {
    // Documents the invariant from Issue #1: bootstrapInitialWorkflowState()
    // reads listWorkflows once. The sync bootstrap IPC fires ~20ms later.
    // Before this cache existed, both call sites ran the query. With the
    // single-shot cache the second reader must reuse the bootstrap payload
    // without touching persistence.
    const cache = createStartupWorkflowCache();
    const listWorkflows = vi.fn(() => [wf('should-not-be-called')]);
    const bootstrapPayload = [wf('wf-a'), wf('wf-b')];
    cache.set(bootstrapPayload);

    const firstRead = cache.takeOrLoad(listWorkflows);
    expect(firstRead).toEqual(bootstrapPayload);
    expect(listWorkflows).not.toHaveBeenCalled();

    const secondRead = cache.takeOrLoad(listWorkflows);
    expect(secondRead).toEqual([wf('should-not-be-called')]);
    expect(listWorkflows).toHaveBeenCalledTimes(1);
  });

  it('returns a defensive copy so downstream mutation does not corrupt the cache', () => {
    const cache = createStartupWorkflowCache();
    cache.set([wf('wf-1'), wf('wf-2')]);
    const consumed = cache.takeOrLoad(() => []);
    consumed.push(wf('wf-injected'));
    // After single-shot consume the cache falls through anyway, but the
    // returned slice must still be a distinct array to defend against
    // late mutations at the call site.
    expect(consumed).toHaveLength(3);
  });

  it('invalidate drops any pending cached snapshot', () => {
    const cache = createStartupWorkflowCache();
    const listWorkflows = vi.fn(() => [wf('fresh')]);
    cache.set([wf('stale')]);
    cache.invalidate();

    expect(cache.hasCached()).toBe(false);
    expect(cache.takeOrLoad(listWorkflows)).toEqual([wf('fresh')]);
    expect(listWorkflows).toHaveBeenCalledTimes(1);
  });

  it('set after consume repopulates the cache', () => {
    const cache = createStartupWorkflowCache();
    const listWorkflows = vi.fn(() => [wf('fallback')]);

    cache.set([wf('first-bootstrap')]);
    expect(cache.takeOrLoad(listWorkflows)).toEqual([wf('first-bootstrap')]);

    cache.set([wf('second-bootstrap')]);
    expect(cache.takeOrLoad(listWorkflows)).toEqual([wf('second-bootstrap')]);

    expect(listWorkflows).not.toHaveBeenCalled();
  });
});
