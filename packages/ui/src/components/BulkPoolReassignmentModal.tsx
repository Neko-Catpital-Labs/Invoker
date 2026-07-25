import { useEffect, useMemo, useState } from 'react';
import type { TaskState } from '../types.js';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/index.js';

export interface BulkPoolReassignmentResult {
  sourcePoolId: string;
  destinationPoolId: string;
  matchedCount: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  mergeSkippedCount: number;
  alreadyTargetedCount: number;
  failedTaskIds: string[];
}

interface BulkPoolReassignmentModalProps {
  tasks: readonly TaskState[];
  executionPools: readonly string[];
  onSubmit: (sourcePoolId: string, destinationPoolId: string) => Promise<BulkPoolReassignmentResult>;
  onClose: () => void;
}

function uniquePoolIds(poolIds: readonly string[]): string[] {
  return [...new Set(poolIds)].filter(Boolean);
}

export function BulkPoolReassignmentModal({
  tasks,
  executionPools,
  onSubmit,
  onClose,
}: BulkPoolReassignmentModalProps) {
  const poolOptions = useMemo(() => uniquePoolIds(executionPools), [executionPools]);
  const [sourcePoolId, setSourcePoolId] = useState(poolOptions[0] ?? '');
  const destinationOptions = useMemo(
    () => poolOptions.filter((poolId) => poolId !== sourcePoolId),
    [poolOptions, sourcePoolId],
  );
  const [destinationPoolId, setDestinationPoolId] = useState(destinationOptions[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkPoolReassignmentResult | null>(null);

  useEffect(() => {
    if (sourcePoolId && poolOptions.includes(sourcePoolId)) return;
    setSourcePoolId(poolOptions[0] ?? '');
  }, [poolOptions, sourcePoolId]);

  useEffect(() => {
    if (destinationPoolId && destinationOptions.includes(destinationPoolId)) return;
    setDestinationPoolId(destinationOptions[0] ?? '');
  }, [destinationOptions, destinationPoolId]);

  const scopeCounts = useMemo(() => {
    const nonMergeTasks = tasks.filter((task) => !task.config.isMergeNode);
    const matchingTasks = nonMergeTasks.filter((task) => (
      task.config.poolId === sourcePoolId && task.config.poolId !== destinationPoolId
    ));
    const alreadyTargetedCount = nonMergeTasks.filter((task) => task.config.poolId === destinationPoolId).length;
    return {
      loadedTaskCount: tasks.length,
      nonMergeTaskCount: nonMergeTasks.length,
      mergeSkippedCount: tasks.length - nonMergeTasks.length,
      matchingTaskCount: matchingTasks.length,
      alreadyTargetedCount,
    };
  }, [destinationPoolId, sourcePoolId, tasks]);

  const canSubmit = Boolean(sourcePoolId && destinationPoolId && scopeCounts.matchingTaskCount > 0 && !busy);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setResult(null);
    try {
      const nextResult = await onSubmit(sourcePoolId, destinationPoolId);
      setResult(nextResult);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="bulk-pool-reassignment-dialog">
        <DialogHeader>
          <DialogTitle>Move Tasks Between Pools</DialogTitle>
          <DialogDescription>
            Applies to loaded tasks in the current UI state. Merge nodes are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Source pool</span>
            <select
              value={sourcePoolId}
              onChange={(event) => {
                setResult(null);
                setSourcePoolId(event.target.value);
              }}
              disabled={busy || poolOptions.length === 0}
              data-testid="bulk-pool-source-select"
              className="w-full rounded border border-border-strong bg-muted px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {poolOptions.length === 0 && <option value="">No pools configured</option>}
              {poolOptions.map((poolId) => (
                <option key={poolId} value={poolId}>{poolId}</option>
              ))}
            </select>
          </label>

          <label className="grid gap-1.5 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Destination pool</span>
            <select
              value={destinationPoolId}
              onChange={(event) => {
                setResult(null);
                setDestinationPoolId(event.target.value);
              }}
              disabled={busy || destinationOptions.length === 0}
              data-testid="bulk-pool-destination-select"
              className="w-full rounded border border-border-strong bg-muted px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              {destinationOptions.length === 0 && <option value="">No other pool available</option>}
              {destinationOptions.map((poolId) => (
                <option key={poolId} value={poolId}>{poolId}</option>
              ))}
            </select>
          </label>
        </div>

        <dl
          data-testid="bulk-pool-scope"
          className="grid gap-2 rounded border border-border bg-secondary/70 p-3 text-sm"
        >
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Loaded tasks</dt>
            <dd className="font-medium text-foreground">{scopeCounts.loadedTaskCount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Non-merge scope</dt>
            <dd className="font-medium text-foreground">{scopeCounts.nonMergeTaskCount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Matching source tasks</dt>
            <dd className="font-medium text-foreground">{scopeCounts.matchingTaskCount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Already in destination</dt>
            <dd className="font-medium text-foreground">{scopeCounts.alreadyTargetedCount}</dd>
          </div>
          <div className="flex items-center justify-between gap-4">
            <dt className="text-muted-foreground">Merge nodes skipped</dt>
            <dd className="font-medium text-foreground">{scopeCounts.mergeSkippedCount}</dd>
          </div>
        </dl>

        {scopeCounts.matchingTaskCount === 0 && (
          <p className="text-sm text-muted-foreground">
            No loaded non-merge tasks currently use the selected source pool.
          </p>
        )}

        {result && (
          <div
            data-testid="bulk-pool-summary"
            className={`rounded border p-3 text-sm ${
              result.failedCount > 0
                ? 'border-red-700 bg-red-950/30 text-red-200'
                : 'border-emerald-800 bg-emerald-950/25 text-emerald-200'
            }`}
          >
            <p className="font-medium">
              Moved {result.successCount} of {result.matchedCount} matching tasks from {result.sourcePoolId} to {result.destinationPoolId}.
            </p>
            <p className="mt-1">
              {result.skippedCount} skipped, {result.failedCount} failed.
            </p>
            {result.failedTaskIds.length > 0 && (
              <p className="mt-1 break-all text-xs">
                Failed tasks: {result.failedTaskIds.join(', ')}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
            data-testid="bulk-pool-cancel"
          >
            {result ? 'Done' : 'Cancel'}
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            data-testid="bulk-pool-confirm"
          >
            {busy ? 'Moving...' : 'Move tasks'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
