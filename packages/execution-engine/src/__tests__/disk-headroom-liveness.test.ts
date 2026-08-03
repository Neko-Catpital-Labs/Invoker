import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { computeRepoCacheHash } from '../git-utils.js';
import {
  computeProtectedInvokerPaths,
  type DiskHeadroomLivenessStore,
} from '../workers/disk-headroom-liveness.js';

describe('computeProtectedInvokerPaths', () => {
  it('protects repo cache and workspace paths for failed tasks', () => {
    const repoUrl = 'https://github.com/example/invoker-fixture.git';
    const workspacePath = 'relative/worktree/path';
    const store = {
      listWorkflows: () => [{ id: 'wf-live', repoUrl }],
      loadTasks: () => [{ status: 'failed', execution: { workspacePath } }],
    } satisfies DiskHeadroomLivenessStore;

    const result = computeProtectedInvokerPaths(store);

    expect(result.protectedRepoHashes).toEqual(new Set([computeRepoCacheHash(repoUrl)]));
    expect(result.protectedWorkspacePaths).toEqual(new Set([resolve(workspacePath)]));
  });

  it('does not protect paths for workflows whose only task is completed', () => {
    const store = {
      listWorkflows: () => [{ id: 'wf-complete', repoUrl: 'https://github.com/example/complete.git' }],
      loadTasks: () => [{ status: 'completed', execution: { workspacePath: '/tmp/completed-worktree' } }],
    } satisfies DiskHeadroomLivenessStore;

    const result = computeProtectedInvokerPaths(store);

    expect(result.protectedRepoHashes).toEqual(new Set());
    expect(result.protectedWorkspacePaths).toEqual(new Set());
  });

  it('returns empty sets when workflow listing throws', () => {
    const error = new Error('store unavailable');
    const logger = { warn: vi.fn() };
    const store = {
      listWorkflows: () => {
        throw error;
      },
      loadTasks: () => [{ status: 'failed' }],
    } satisfies DiskHeadroomLivenessStore;

    const result = computeProtectedInvokerPaths(store, { logger });

    expect(result.protectedRepoHashes).toEqual(new Set());
    expect(result.protectedWorkspacePaths).toEqual(new Set());
    expect(logger.warn).toHaveBeenCalledWith('Failed to compute disk-headroom liveness paths', error);
  });
});
