import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { PersistedWorkflowMutationCoordinator } from './persisted-workflow-mutation-coordinator.js';

type RecoveryPersistence = Pick<SQLiteAdapter, 'requeueExpiredWorkflowMutationLeases'>
  & Partial<Pick<SQLiteAdapter, 'requeueOrphanedWorkflowMutationIntents'>>;

type RecoveryDeps = {
  ownerMode: boolean;
  persistence: RecoveryPersistence;
  workflowMutationCoordinator?: Pick<PersistedWorkflowMutationCoordinator, 'resumePending'>;
  logger: Logger;
  maybeDelayResume?: () => Promise<void>;
};

export async function recoverWorkflowMutationsOnStartup({
  ownerMode,
  persistence,
  workflowMutationCoordinator,
  logger,
  maybeDelayResume,
}: RecoveryDeps): Promise<void> {
  if (!ownerMode || !workflowMutationCoordinator) {
    return;
  }

  try {
    const expired = persistence.requeueExpiredWorkflowMutationLeases();
    const orphaned = persistence.requeueOrphanedWorkflowMutationIntents?.() ?? 0;
    logger.info('requeued expired workflow mutation leases on startup', {
      module: 'init',
      expired,
      orphaned,
    });
  } catch (err) {
    logger.error(
      `requeueExpiredWorkflowMutationLeases failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      { module: 'init' },
    );
    return;
  }

  try {
    await maybeDelayResume?.();
    logger.info('resuming pending workflow mutations on startup', { module: 'init' });
    await workflowMutationCoordinator.resumePending();
    logger.info('workflow mutation recovery finished on startup', { module: 'init' });
  } catch (err) {
    logger.error(
      `resumePending failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      { module: 'init' },
    );
  }
}
