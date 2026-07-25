import { useEffect, useMemo, useState } from 'react';
import type { TaskState } from '../types.js';

export interface BulkPoolReassignmentPlan {
  sourcePool: string;
  destinationPool: string;
  loadedTaskCount: number;
  nonMergeTaskCount: number;
  candidateTaskIds: string[];
  skippedCount: number;
  mergeSkippedCount: number;
  alreadyTargetedCount: number;
  outsideSourceCount: number;
}

export interface BulkPoolReassignmentResult extends BulkPoolReassignmentPlan {
  successCount: number;
  failedCount: number;
  failures: Array<{ taskId: string; message: string }>;
}

interface BulkPoolReassignmentModalProps {
  tasks: Map<string, TaskState>;
  executionPools: string[];
  pending: boolean;
  result: BulkPoolReassignmentResult | null;
  onConfirm: (sourcePool: string, destinationPool: string) => void;
  onClose: () => void;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function uniquePoolOptions(pools: string[]): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const rawPool of pools) {
    const pool = rawPool.trim();
    if (!pool || seen.has(pool)) continue;
    seen.add(pool);
    options.push(pool);
  }
  return options;
}

export function planBulkPoolReassignment(
  tasks: Iterable<TaskState>,
  sourcePool: string,
  destinationPool: string,
): BulkPoolReassignmentPlan {
  const loadedTasks = [...tasks];
  const nonMergeTasks = loadedTasks.filter((task) => !task.config.isMergeNode);
  const candidateTaskIds = nonMergeTasks
    .filter((task) => task.config.poolId === sourcePool && task.config.poolId !== destinationPool)
    .map((task) => task.id);
  const mergeSkippedCount = loadedTasks.length - nonMergeTasks.length;
  const alreadyTargetedCount = nonMergeTasks.filter((task) => task.config.poolId === destinationPool).length;
  const outsideSourceCount = nonMergeTasks.filter((task) => (
    task.config.poolId !== sourcePool && task.config.poolId !== destinationPool
  )).length;

  return {
    sourcePool,
    destinationPool,
    loadedTaskCount: loadedTasks.length,
    nonMergeTaskCount: nonMergeTasks.length,
    candidateTaskIds,
    skippedCount: mergeSkippedCount + alreadyTargetedCount + outsideSourceCount,
    mergeSkippedCount,
    alreadyTargetedCount,
    outsideSourceCount,
  };
}

export function BulkPoolReassignmentModal({
  tasks,
  executionPools,
  pending,
  result,
  onConfirm,
  onClose,
}: BulkPoolReassignmentModalProps): JSX.Element {
  const poolOptions = useMemo(() => uniquePoolOptions(executionPools), [executionPools]);
  const [sourcePool, setSourcePool] = useState(poolOptions[0] ?? '');
  const [destinationPool, setDestinationPool] = useState(poolOptions.find((pool) => pool !== sourcePool) ?? '');

  useEffect(() => {
    if (poolOptions.length === 0) {
      setSourcePool('');
      setDestinationPool('');
      return;
    }

    setSourcePool((current) => (current && poolOptions.includes(current) ? current : poolOptions[0] ?? ''));
  }, [poolOptions]);

  useEffect(() => {
    setDestinationPool((current) => {
      const availableDestination = poolOptions.find((pool) => pool !== sourcePool) ?? '';
      if (current && current !== sourcePool && poolOptions.includes(current)) return current;
      return availableDestination;
    });
  }, [poolOptions, sourcePool]);

  const destinationOptions = useMemo(
    () => poolOptions.filter((pool) => pool !== sourcePool),
    [poolOptions, sourcePool],
  );
  const preview = useMemo(
    () => planBulkPoolReassignment(tasks.values(), sourcePool, destinationPool),
    [destinationPool, sourcePool, tasks],
  );
  const visibleResult = result?.sourcePool === sourcePool && result.destinationPool === destinationPool ? result : null;
  const canConfirm = Boolean(sourcePool && destinationPool && sourcePool !== destinationPool && preview.candidateTaskIds.length > 0);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-pool-reassignment-title"
      data-testid="bulk-pool-reassignment-dialog"
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/45 px-4 pt-[14vh]"
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        className="w-full max-w-lg rounded-lg border border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 id="bulk-pool-reassignment-title" className="text-sm font-semibold text-foreground">
            Move Tasks Between Pools
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Applies to loaded tasks in the current UI state.
          </p>
        </div>

        <div className="space-y-4 px-4 py-4 text-sm">
          <label className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Source Pool</span>
            <select
              value={sourcePool}
              onChange={(event) => setSourcePool(event.target.value)}
              disabled={pending || poolOptions.length === 0}
              className="min-w-0 w-64 rounded border border-border-strong bg-muted px-2 py-1.5 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="bulk-pool-source-select"
            >
              {poolOptions.length === 0 && <option value="">No pools available</option>}
              {poolOptions.map((poolId) => (
                <option key={poolId} value={poolId}>{poolId}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Destination Pool</span>
            <select
              value={destinationPool}
              onChange={(event) => setDestinationPool(event.target.value)}
              disabled={pending || destinationOptions.length === 0}
              className="min-w-0 w-64 rounded border border-border-strong bg-muted px-2 py-1.5 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="bulk-pool-destination-select"
            >
              {destinationOptions.length === 0 && <option value="">No other pool available</option>}
              {destinationOptions.map((poolId) => (
                <option key={poolId} value={poolId}>{poolId}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center justify-between gap-3">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Scope</span>
            <select
              value="loaded-non-merge"
              disabled
              className="min-w-0 w-64 rounded border border-border-strong bg-muted px-2 py-1.5 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-70"
              data-testid="bulk-pool-scope-select"
            >
              <option value="loaded-non-merge">Loaded non-merge tasks</option>
            </select>
          </label>

          <div
            data-testid="bulk-pool-preview"
            className="rounded border border-border bg-secondary/70 px-3 py-2 text-xs text-muted-foreground"
          >
            <div className="font-medium text-foreground">
              Will move {formatCount(preview.candidateTaskIds.length, 'task')} from {sourcePool || 'source'} to {destinationPool || 'destination'}.
            </div>
            <div className="mt-1">
              Loaded scope: {formatCount(preview.nonMergeTaskCount, 'non-merge task')} ({formatCount(preview.loadedTaskCount, 'task')} total).
            </div>
            <div className="mt-1">
              Skips: {formatCount(preview.mergeSkippedCount, 'merge node')}, {formatCount(preview.alreadyTargetedCount, 'task')} already in destination, {formatCount(preview.outsideSourceCount, 'task')} outside source pool.
            </div>
            {poolOptions.length < 2 && (
              <div className="mt-2 text-amber-200">At least two execution pools are required.</div>
            )}
            {poolOptions.length >= 2 && preview.candidateTaskIds.length === 0 && (
              <div className="mt-2 text-amber-200">No loaded non-merge tasks currently use the selected source pool.</div>
            )}
          </div>

          {visibleResult && (
            <div
              data-testid="bulk-pool-result"
              className={`rounded border px-3 py-2 text-xs ${
                visibleResult.failedCount > 0
                  ? 'border-red-900/70 bg-red-950/30 text-red-100'
                  : 'border-emerald-900/70 bg-emerald-950/30 text-emerald-100'
              }`}
            >
              <div className="font-medium">
                Moved {formatCount(visibleResult.successCount, 'task')}. Skipped {formatCount(visibleResult.skippedCount, 'task')}. Failed {formatCount(visibleResult.failedCount, 'task')}.
              </div>
              {visibleResult.failures.length > 0 && (
                <div className="mt-2 space-y-1">
                  {visibleResult.failures.slice(0, 3).map((failure) => (
                    <div key={failure.taskId} className="break-words">
                      {failure.taskId}: {failure.message}
                    </div>
                  ))}
                  {visibleResult.failures.length > 3 && (
                    <div>{formatCount(visibleResult.failures.length - 3, 'more failure')}</div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            data-testid="bulk-pool-cancel"
            disabled={pending}
            className="rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            data-testid="bulk-pool-confirm"
            disabled={pending || !canConfirm}
            className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => onConfirm(sourcePool, destinationPool)}
          >
            {pending ? 'Moving…' : 'Move tasks'}
          </button>
        </div>
      </div>
    </div>
  );
}
