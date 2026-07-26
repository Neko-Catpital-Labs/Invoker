import { useEffect, useMemo, useState } from 'react';
import type { TaskState } from '../types.js';
import {
  summarizePoolReassignment,
  type PoolReassignmentResult,
} from '../lib/pool-reassignment.js';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/index.js';

interface BulkPoolReassignmentModalProps {
  readonly tasks: readonly TaskState[];
  readonly executionPools: readonly string[];
  readonly onConfirm: (sourcePoolId: string, destinationPoolId: string) => Promise<PoolReassignmentResult>;
  readonly onClose: () => void;
}

function uniquePoolIds(poolIds: readonly string[]): string[] {
  return Array.from(new Set(poolIds.filter((poolId) => poolId.trim().length > 0)));
}

function formatFailureList(failures: PoolReassignmentResult['failures']): string {
  const visibleFailures = failures.slice(0, 3).map((failure) => `${failure.taskId}: ${failure.error}`);
  const hiddenCount = failures.length - visibleFailures.length;
  return hiddenCount > 0
    ? `${visibleFailures.join(' | ')} | ${hiddenCount} more`
    : visibleFailures.join(' | ');
}

export function BulkPoolReassignmentModal({
  tasks,
  executionPools,
  onConfirm,
  onClose,
}: BulkPoolReassignmentModalProps) {
  const poolOptions = useMemo(() => uniquePoolIds(executionPools), [executionPools]);
  const [sourcePoolId, setSourcePoolId] = useState(() => poolOptions[0] ?? '');
  const [destinationPoolId, setDestinationPoolId] = useState(() => poolOptions.find((poolId) => poolId !== sourcePoolId) ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PoolReassignmentResult | null>(null);

  useEffect(() => {
    setSourcePoolId((current) => (poolOptions.includes(current) ? current : poolOptions[0] ?? ''));
  }, [poolOptions]);

  const destinationOptions = useMemo(
    () => poolOptions.filter((poolId) => poolId !== sourcePoolId),
    [poolOptions, sourcePoolId],
  );

  useEffect(() => {
    setDestinationPoolId((current) => (destinationOptions.includes(current) ? current : destinationOptions[0] ?? ''));
  }, [destinationOptions]);

  useEffect(() => {
    setResult(null);
  }, [sourcePoolId, destinationPoolId]);

  const preview = useMemo(
    () => summarizePoolReassignment(tasks, sourcePoolId, destinationPoolId),
    [destinationPoolId, sourcePoolId, tasks],
  );
  const locked = submitting || result !== null;
  const canConfirm = !locked
    && sourcePoolId.length > 0
    && destinationPoolId.length > 0
    && sourcePoolId !== destinationPoolId
    && preview.matchedTaskIds.length > 0;

  const handleConfirm = async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    setResult(null);
    try {
      setResult(await onConfirm(sourcePoolId, destinationPoolId));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !submitting) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="bulk-pool-reassignment-dialog">
        <div data-testid="bulk-pool-reassignment-modal">
          <DialogHeader>
            <DialogTitle>Move Tasks Between Pools</DialogTitle>
            <DialogDescription>
              Reassign loaded non-merge tasks from one execution pool to another.
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                Source Pool
                <select
                  value={sourcePoolId}
                  onChange={(event) => setSourcePoolId(event.target.value)}
                  disabled={locked || poolOptions.length === 0}
                  className="h-8 rounded border border-border-strong bg-muted px-2 text-xs normal-case text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="bulk-pool-source-select"
                >
                  {poolOptions.map((poolId) => (
                    <option key={poolId} value={poolId}>{poolId}</option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1.5 text-xs font-medium uppercase text-muted-foreground">
                Destination Pool
                <select
                  value={destinationPoolId}
                  onChange={(event) => setDestinationPoolId(event.target.value)}
                  disabled={locked || destinationOptions.length === 0}
                  className="h-8 rounded border border-border-strong bg-muted px-2 text-xs normal-case text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="bulk-pool-destination-select"
                >
                  {destinationOptions.map((poolId) => (
                    <option key={poolId} value={poolId}>{poolId}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="grid gap-1.5 text-xs font-medium uppercase text-muted-foreground">
              Scope
              <select
                value="loaded-non-merge"
                disabled
                className="h-8 rounded border border-border bg-muted px-2 text-xs normal-case text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70"
                data-testid="bulk-pool-scope-select"
              >
                <option value="loaded-non-merge">Loaded tasks in current UI state, excluding merge nodes</option>
              </select>
            </label>

            <div className="rounded border border-border bg-secondary/60 p-3 text-sm" data-testid="bulk-pool-preview">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Tasks to move</span>
                <span className="font-medium text-foreground" data-testid="bulk-pool-match-count">
                  <span data-testid="bulk-pool-preview-count">{preview.matchedTaskIds.length}</span>
                </span>
              </div>
              <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                <span>Loaded: {preview.loadedTaskCount}</span>
                <span data-testid="bulk-pool-skipped-count">Skipped: {preview.skippedCount}</span>
                <span data-testid="bulk-pool-merge-skipped-count">Merge nodes: {preview.skippedMergeCount}</span>
                <span data-testid="bulk-pool-already-targeted-count">Already in destination: {preview.skippedAlreadyTargetedCount}</span>
                <span className="sm:col-span-2">Other pools or no pool: {preview.skippedNonSourceCount}</span>
              </div>
            </div>

            {poolOptions.length < 2 && (
              <p className="rounded border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-100">
                At least two execution pools are required to move tasks.
              </p>
            )}

            {poolOptions.length >= 2 && preview.matchedTaskIds.length === 0 && !result && (
              <p className="rounded border border-border bg-secondary/70 p-3 text-xs text-muted-foreground">
                No loaded non-merge tasks currently match the selected source pool.
              </p>
            )}

            {result && (
              <div
                className={`rounded border p-3 text-sm ${
                  result.failedCount > 0
                    ? 'border-amber-700 bg-amber-950/30 text-amber-100'
                    : 'border-emerald-700 bg-emerald-950/30 text-emerald-100'
                }`}
                data-testid="bulk-pool-result"
              >
                <div>
                  Moved {result.successCount} task{result.successCount === 1 ? '' : 's'}.
                  {' '}Skipped {result.skippedCount}.
                  {' '}Failed {result.failedCount}.
                </div>
                {result.failures.length > 0 && (
                  <div className="mt-2 break-words text-xs">{formatFailureList(result.failures)}</div>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            {result ? (
              <Button type="button" onClick={onClose} data-testid="bulk-pool-done">
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onClose}
                  disabled={submitting}
                  data-testid="bulk-pool-cancel"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  onClick={() => void handleConfirm()}
                  disabled={!canConfirm}
                  data-testid="bulk-pool-confirm"
                >
                  {submitting ? 'Moving...' : `Move ${preview.matchedTaskIds.length} task${preview.matchedTaskIds.length === 1 ? '' : 's'}`}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
