import { useEffect, useMemo, useState } from 'react';
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
  successCount: number;
  skippedCount: number;
  failedCount: number;
}

interface BulkPoolReassignmentModalProps {
  executionPools: string[];
  loadedTaskCount: number;
  nonMergeTaskCount: number;
  result: BulkPoolReassignmentResult | null;
  submitting: boolean;
  onPreview: (sourcePool: string, destinationPool: string) => number;
  onConfirm: (sourcePool: string, destinationPool: string) => Promise<void>;
  onClose: () => void;
}

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function BulkPoolReassignmentModal({
  executionPools,
  loadedTaskCount,
  nonMergeTaskCount,
  result,
  submitting,
  onPreview,
  onConfirm,
  onClose,
}: BulkPoolReassignmentModalProps) {
  const [sourcePool, setSourcePool] = useState(executionPools[0] ?? '');
  const destinationOptions = useMemo(
    () => executionPools.filter((poolId) => poolId !== sourcePool),
    [executionPools, sourcePool],
  );
  const [destinationPool, setDestinationPool] = useState(destinationOptions[0] ?? '');

  useEffect(() => {
    if (!executionPools.includes(sourcePool)) {
      setSourcePool(executionPools[0] ?? '');
    }
  }, [executionPools, sourcePool]);

  useEffect(() => {
    const options = executionPools.filter((poolId) => poolId !== sourcePool);
    if (!options.includes(destinationPool)) {
      setDestinationPool(options[0] ?? '');
    }
  }, [destinationPool, executionPools, sourcePool]);

  const previewCount = sourcePool && destinationPool
    ? onPreview(sourcePool, destinationPool)
    : 0;
  const controlsDisabled = submitting || result !== null;
  const canConfirm = Boolean(sourcePool && destinationPool) && previewCount > 0 && !controlsDisabled;

  const handleConfirm = () => {
    if (!canConfirm) return;
    void onConfirm(sourcePool, destinationPool);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg" data-testid="bulk-pool-reassignment-modal">
        <DialogHeader>
          <DialogTitle>Move Tasks Between Pools</DialogTitle>
          <DialogDescription>
            Applies to loaded non-merge tasks in the current graph state.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">Source Pool</span>
              <select
                value={sourcePool}
                onChange={(event) => setSourcePool(event.target.value)}
                disabled={controlsDisabled || executionPools.length === 0}
                className="w-full rounded border border-border-strong bg-muted px-2 py-2 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="bulk-pool-source-select"
              >
                {executionPools.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">Destination Pool</span>
              <select
                value={destinationPool}
                onChange={(event) => setDestinationPool(event.target.value)}
                disabled={controlsDisabled || destinationOptions.length === 0}
                className="w-full rounded border border-border-strong bg-muted px-2 py-2 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="bulk-pool-destination-select"
              >
                {destinationOptions.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="block space-y-1 text-xs text-muted-foreground">
            <span className="uppercase tracking-wide">Scope</span>
            <select
              value="loaded-non-merge"
              disabled
              className="w-full rounded border border-border-strong bg-muted px-2 py-2 text-xs text-foreground opacity-80"
              data-testid="bulk-pool-scope-select"
            >
              <option value="loaded-non-merge">Loaded non-merge tasks</option>
            </select>
          </label>

          <div
            className="rounded border border-border bg-secondary/70 p-3 text-xs text-muted-foreground"
            data-testid="bulk-pool-preview"
          >
            <div className="flex items-center justify-between gap-3">
              <span>Loaded tasks</span>
              <span className="font-mono text-foreground">{loadedTaskCount}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span>Non-merge scope</span>
              <span className="font-mono text-foreground">{nonMergeTaskCount}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-3">
              <span>Will move</span>
              <span className="font-mono text-foreground">{previewCount}</span>
            </div>
          </div>

          {result && (
            <div
              className={`rounded border p-3 text-xs ${
                result.failedCount > 0
                  ? 'border-red-800/70 bg-red-950/30 text-red-200'
                  : 'border-emerald-800/70 bg-emerald-950/30 text-emerald-200'
              }`}
              data-testid="bulk-pool-result"
            >
              Moved {formatCount(result.successCount, 'task')}; skipped {formatCount(result.skippedCount, 'task')}; failed {formatCount(result.failedCount, 'task')}.
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
          {!result && (
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              data-testid="bulk-pool-confirm"
            >
              {submitting ? 'Moving...' : `Move ${formatCount(previewCount, 'task')}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
