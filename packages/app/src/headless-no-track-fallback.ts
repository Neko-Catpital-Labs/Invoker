import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveInvokerHomeRoot, type WorkflowMutationAcceptedResult } from '@invoker/contracts';
import { SQLiteAdapter, type WorkflowMutationPriority } from '@invoker/data-store';

import { acquireDbWriterLock, type DbWriterLockResult } from './db-writer-lock.js';
import { FileAndDbLogger } from './logger.js';
import { submitWorkflowMutationOrAcknowledgeDeleted } from './workflow-mutation-submit.js';

const FIRE_AND_FORGET_TASK_COMMANDS = new Set([
  'retry-task',
  'recreate-task',
]);

function explicitTaskTargetWorkflowId(args: string[]): string | undefined {
  const target = args[1];
  if (!target) return undefined;
  const slashIndex = target.indexOf('/');
  if (slashIndex <= 0) return undefined;
  const workflowId = target.slice(0, slashIndex);
  return /^wf-[^/]+$/.test(workflowId) ? workflowId : undefined;
}

function shouldUseNoTrackFallback(args: string[], noTrack: boolean | undefined): boolean {
  const command = args[0];
  return noTrack === true
    && command !== undefined
    && FIRE_AND_FORGET_TASK_COMMANDS.has(command)
    && explicitTaskTargetWorkflowId(args) !== undefined;
}

function writeAcceptedNoTrackResult(result: WorkflowMutationAcceptedResult): void {
  if (result.intentId > 0) {
    process.stdout.write(`Queued no-track mutation intent ${result.intentId} for workflow: ${result.workflowId}\n`);
  } else {
    process.stdout.write(`No-track mutation already satisfied for workflow: ${result.workflowId}\n`);
  }
  process.stdout.write('--no-track enabled: delegated submission accepted; exiting without tracking.\n');
}

function fallbackExclusiveLockingEnabled(): boolean {
  return process.env.INVOKER_DISABLE_EXCLUSIVE_LOCKING !== '1'
    && process.env.INVOKER_UNSAFE_DISABLE_DB_WRITER_LOCK !== '1';
}

function fallbackDbPath(): string {
  return join(resolveInvokerHomeRoot(), 'invoker.db');
}

function acknowledgeMissingWorkflowMutation(args: string[], workflowId: string): void {
  const logger = new FileAndDbLogger({ module: 'headless-client' });
  const priority: WorkflowMutationPriority = 'high';
  const payload = {
    args,
    waitForApproval: false,
    noTrack: true,
  };
  const result = submitWorkflowMutationOrAcknowledgeDeleted(workflowId, priority, 'headless.exec', [payload], {
    workflowExists: () => false,
    coordinator: {
      submit: () => {
        throw new Error('Cannot queue workflow mutation because invoker.db does not exist');
      },
    },
    logger,
    deferDrain: true,
  });
  writeAcceptedNoTrackResult(result);
}

export function tryAcknowledgeNoTrackTaskMutationWithoutDb(
  args: string[],
  noTrack: boolean | undefined,
): boolean {
  if (!canAcknowledgeNoTrackTaskMutationWithoutDb(args, noTrack)) return false;

  const workflowId = explicitTaskTargetWorkflowId(args);
  if (!workflowId) return false;

  acknowledgeMissingWorkflowMutation(args, workflowId);
  return true;
}

export function canAcknowledgeNoTrackTaskMutationWithoutDb(
  args: string[],
  noTrack: boolean | undefined,
): boolean {
  return shouldUseNoTrackFallback(args, noTrack) && !existsSync(fallbackDbPath());
}

export async function tryAcknowledgeNoTrackTaskMutationWithoutOwner(
  args: string[],
  noTrack: boolean | undefined,
): Promise<boolean> {
  if (!shouldUseNoTrackFallback(args, noTrack)) return false;

  const workflowId = explicitTaskTargetWorkflowId(args);
  if (!workflowId) return false;

  const priority: WorkflowMutationPriority = 'high';
  const payload = {
    args,
    waitForApproval: false,
    noTrack: true,
  };
  const dbPath = fallbackDbPath();

  if (!existsSync(dbPath)) {
    acknowledgeMissingWorkflowMutation(args, workflowId);
    return true;
  }

  let writerLock: DbWriterLockResult | null = null;
  let persistence: SQLiteAdapter | null = null;
  try {
    writerLock = acquireDbWriterLock(dbPath, `headless-client:no-track-fallback pid=${process.pid}`);
    persistence = await SQLiteAdapter.create(dbPath, {
      ownerCapability: true,
      exclusiveLocking: fallbackExclusiveLockingEnabled(),
    });
    const dbLogger = new FileAndDbLogger({ module: 'headless-client' }, { persistence });
    const result = submitWorkflowMutationOrAcknowledgeDeleted(workflowId, priority, 'headless.exec', [payload], {
      workflowExists: (id) => Boolean(persistence?.loadWorkflow(id)),
      coordinator: {
        submit: (targetWorkflowId, targetPriority, channel, mutationArgs) =>
          persistence!.enqueueWorkflowMutationIntent(targetWorkflowId, channel, mutationArgs, targetPriority),
      },
      logger: dbLogger,
      deferDrain: true,
    });
    writeAcceptedNoTrackResult(result);
    return true;
  } finally {
    persistence?.close();
    writerLock?.release();
  }
}
