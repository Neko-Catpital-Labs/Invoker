import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './primitives/index.js';

export interface BulkPoolReassignmentResult {
  moved: number;
  failed: number;
  skipped: number;
  skippedMerge: number;
  skippedAlreadyTargeted: number;
  matched: number;
  failureTaskIds: string[];
}

interface BulkPoolReassignmentModalProps {
  pools: readonly string[];
  totalLoadedTasks: number;
  nonMergeTaskCount: number;
  countMatchingTasks: (sourcePool: string, destinationPool: string) => BulkPoolReassignmentResult;
  onConfirm: (sourcePool: string, destinationPool: string) => Promise<BulkPoolReassignmentResult>;
  onClose: () => void;
}

function firstDifferentPool(pools: readonly string[], sourcePool: string): string {
  return pools.find((poolId) => poolId !== sourcePool) ?? '';
}

export function BulkPoolReassignmentModal({
  pools,
  totalLoadedTasks,
  nonMergeTaskCount,
  countMatchingTasks,
  onConfirm,
  onClose,
}: BulkPoolReassignmentModalProps): JSX.Element {
  const [sourcePool, setSourcePool] = useState(pools[0] ?? '');
  const [destinationPool, setDestinationPool] = useState(firstDifferentPool(pools, pools[0] ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkPoolReassignmentResult | null>(null);

  useEffect(() => {
    if (!sourcePool || !pools.includes(sourcePool)) {
      const nextSource = pools[0] ?? '';
      setSourcePool(nextSource);
      setDestinationPool(firstDifferentPool(pools, nextSource));
      return;
    }
    if (!destinationPool || destinationPool === sourcePool || !pools.includes(destinationPool)) {
      setDestinationPool(firstDifferentPool(pools, sourcePool));
    }
  }, [destinationPool, pools, sourcePool]);

  const destinationOptions = useMemo(
    () => pools.filter((poolId) => poolId !== sourcePool),
    [pools, sourcePool],
  );
  const preview = useMemo(
    () => sourcePool && destinationPool
      ? countMatchingTasks(sourcePool, destinationPool)
      : null,
    [countMatchingTasks, destinationPool, sourcePool],
  );
  const canSubmit = Boolean(sourcePool && destinationPool && !submitting && preview && preview.matched > 0);

  const handleConfirm = async () => {
    if (!sourcePool || !destinationPool || submitting) return;
    setSubmitting(true);
    try {
      setResult(await onConfirm(sourcePool, destinationPool));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="bulk-pool-reassignment-dialog">
        <DialogHeader>
          <DialogTitle>Move Tasks Between Pools</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Applies to loaded tasks in this UI state. Merge tasks are skipped.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Source Pool</span>
              <select
                value={sourcePool}
                onChange={(event) => {
                  const nextSource = event.target.value;
                  setSourcePool(nextSource);
                  if (destinationPool === nextSource) {
                    setDestinationPool(firstDifferentPool(pools, nextSource));
                  }
                  setResult(null);
                }}
                disabled={pools.length === 0 || submitting}
                className="w-full rounded border border-border-strong bg-muted px-2 py-1.5 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="bulk-pool-source-select"
              >
                {pools.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Destination Pool</span>
              <select
                value={destinationPool}
                onChange={(event) => {
                  setDestinationPool(event.target.value);
                  setResult(null);
                }}
                disabled={destinationOptions.length === 0 || submitting}
                className="w-full rounded border border-border-strong bg-muted px-2 py-1.5 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="bulk-pool-destination-select"
              >
                {destinationOptions.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>
          </div>

          <div
            className="rounded border border-border bg-secondary/70 p-3 text-sm"
            data-testid="bulk-pool-task-count"
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Loaded non-merge tasks</span>
              <span className="font-medium text-foreground">{nonMergeTaskCount} / {totalLoadedTasks}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Tasks matching source</span>
              <span className="font-medium text-foreground">{preview?.matched ?? 0}</span>
            </div>
          </div>

          {pools.length < 2 && (
            <div className="rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-200">
              At least two execution pools are required for reassignment.
            </div>
          )}

          {result && (
            <div
              className={`rounded border p-3 text-sm ${
                result.failed > 0
                  ? 'border-amber-700 bg-amber-950/40 text-amber-100'
                  : 'border-emerald-700 bg-emerald-950/30 text-emerald-100'
              }`}
              data-testid="bulk-pool-result"
            >
              <div className="font-medium">
                Moved {result.moved} task{result.moved === 1 ? '' : 's'}.
              </div>
              <div className="mt-1 text-xs">
                Failed {result.failed}; skipped {result.skipped}.
              </div>
              {result.skipped > 0 && (
                <div className="mt-1 text-xs">
                  Skipped details: {result.skippedMerge} merge; {result.skippedAlreadyTargeted} already destination.
                </div>
              )}
              {result.failureTaskIds.length > 0 && (
                <div className="mt-1 break-all text-xs">
                  Failed task IDs: {result.failureTaskIds.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={submitting}
            data-testid="bulk-pool-cancel"
          >
            {result ? 'Done' : 'Cancel'}
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={handleConfirm}
            data-testid="bulk-pool-confirm"
          >
            {submitting ? 'Moving...' : `Move ${preview?.matched ?? 0} Task${preview?.matched === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
