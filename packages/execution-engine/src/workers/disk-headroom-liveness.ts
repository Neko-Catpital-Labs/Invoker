import { resolve } from 'node:path';

import { computeRepoCacheHash } from '../git-utils.js';

export interface DiskHeadroomLivenessStore {
  listWorkflows(): ReadonlyArray<{ id: string; repoUrl?: string }>;
  loadTasks(workflowId: string): ReadonlyArray<{
    status: string;
    execution?: { workspacePath?: string };
  }>;
}

export const TERMINAL_TASK_STATUSES = ['completed', 'closed', 'stale'] as const;

const TERMINAL_TASK_STATUS_SET = new Set<string>(TERMINAL_TASK_STATUSES);

export function computeProtectedInvokerPaths(
  store: DiskHeadroomLivenessStore,
  opts?: { logger?: { warn?: (msg: string, meta?: unknown) => void } },
): { protectedRepoHashes: Set<string>; protectedWorkspacePaths: Set<string> } {
  try {
    const protectedRepoHashes = new Set<string>();
    const protectedWorkspacePaths = new Set<string>();

    for (const workflow of store.listWorkflows()) {
      for (const task of store.loadTasks(workflow.id)) {
        if (TERMINAL_TASK_STATUS_SET.has(task.status)) {
          continue;
        }

        if (workflow.repoUrl) {
          protectedRepoHashes.add(computeRepoCacheHash(workflow.repoUrl));
        }

        if (task.execution?.workspacePath) {
          protectedWorkspacePaths.add(resolve(task.execution.workspacePath));
        }
      }
    }

    return { protectedRepoHashes, protectedWorkspacePaths };
  } catch (err) {
    opts?.logger?.warn?.('Failed to compute disk-headroom liveness paths', err);
    return { protectedRepoHashes: new Set(), protectedWorkspacePaths: new Set() };
  }
}
