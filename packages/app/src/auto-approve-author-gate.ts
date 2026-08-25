import type { SQLiteAdapter } from '@invoker/data-store';
import {
  authorsFromConfigValue,
  createGithubPrAuthorLookup,
  createPersistedAutoApproveAuthorGate,
  spawnPrMaintenanceCommand,
  type AutoApproveAuthorGateResult,
} from '@invoker/execution-engine';

import { loadConfig } from './config.js';

export type { AutoApproveAuthorGateResult };

/** Owner-side PR-author gate. Re-reads `autoApproveAuthors` from config.json on every call. */
export function buildPersistedAutoApproveAuthorGate(
  persistence: Pick<SQLiteAdapter, 'loadTask' | 'loadTasks'>,
): (taskId: string) => Promise<AutoApproveAuthorGateResult> {
  const defaultRepo = process.env.INVOKER_GITHUB_TARGET_REPO?.trim() || 'Neko-Catpital-Labs/Invoker';
  return createPersistedAutoApproveAuthorGate({
    readAllowlist: () => {
      try {
        return authorsFromConfigValue(
          (loadConfig() as { autoApproveAuthors?: unknown }).autoApproveAuthors,
        );
      } catch (err) {
        console.error('[auto-approve-authors] failed to read config.json', err);
        return { ok: false, reason: 'unreadable' };
      }
    },
    loadTask: (taskId) => persistence.loadTask(taskId),
    loadTasks: (workflowId) => persistence.loadTasks(workflowId),
    lookupPrAuthor: createGithubPrAuthorLookup({
      run: spawnPrMaintenanceCommand,
      defaultRepo,
    }),
    defaultRepo,
  });
}
