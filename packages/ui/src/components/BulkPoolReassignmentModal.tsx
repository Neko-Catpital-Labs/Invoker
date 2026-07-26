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
  moved: number;
  failed: number;
  skipped: number;
  skippedMerge: number;
  skippedAlreadyTargeted: number;
  attempted: number;
  failureDetails: Array<{ taskId: string; message: string }>;
}

interface BulkPoolReassignmentPreview {
  movable: number;
  sourceMerge: number;
  alreadyTargeted: number;
  loadedNonMerge: number;
}

interface BulkPoolReassignmentModalProps {
  executionPools: string[];
  tasks: TaskState[];
  onConfirm: (sourcePoolId: string, destinationPoolId: string) => Promise<BulkPoolReassignmentResult>;
  onClose: () => void;
}

function getPreview(
  tasks: TaskState[],
  sourcePoolId: string,
  destinationPoolId: string,
): BulkPoolReassignmentPreview {
  let movable = 0;
  let sourceMerge = 0;
  let alreadyTargeted = 0;
  let loadedNonMerge = 0;

  for (const task of tasks) {
    if (task.config.isMergeNode) {
      if (task.config.poolId === sourcePoolId) sourceMerge += 1;
      continue;
    }
    loadedNonMerge += 1;
    if (task.config.poolId === destinationPoolId) alreadyTargeted += 1;
    if (sourcePoolId && destinationPoolId && task.config.poolId === sourcePoolId && task.config.poolId !== destinationPoolId) {
      movable += 1;
    }
  }

  return { movable, sourceMerge, alreadyTargeted, loadedNonMerge };
}

function formatFailureDetails(result: BulkPoolReassignmentResult): string {
  if (result.failureDetails.length === 0) return '';
  return result.failureDetails
    .slice(0, 3)
    .map((failure) => `${failure.taskId}: ${failure.message}`)
    .join('\n');
}

export function BulkPoolReassignmentModal({
  executionPools,
  tasks,
  onConfirm,
  onClose,
}: BulkPoolReassignmentModalProps) {
  const poolOptions = useMemo(
    () => [...new Set(executionPools)].filter((poolId) => poolId.trim().length > 0),
    [executionPools],
  );
  const [sourcePoolId, setSourcePoolId] = useState(poolOptions[0] ?? '');
  const [destinationPoolId, setDestinationPoolId] = useState(poolOptions.find((poolId) => poolId !== sourcePoolId) ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BulkPoolReassignmentResult | null>(null);

  useEffect(() => {
    if (poolOptions.includes(sourcePoolId)) return;
    setSourcePoolId(poolOptions[0] ?? '');
  }, [poolOptions, sourcePoolId]);

  const destinationOptions = useMemo(
    () => poolOptions.filter((poolId) => poolId !== sourcePoolId),
    [poolOptions, sourcePoolId],
  );

  useEffect(() => {
    if (destinationOptions.includes(destinationPoolId)) return;
    setDestinationPoolId(destinationOptions[0] ?? '');
  }, [destinationOptions, destinationPoolId]);

  const preview = useMemo(
    () => getPreview(tasks, sourcePoolId, destinationPoolId),
    [tasks, sourcePoolId, destinationPoolId],
  );
  const locked = submitting || result !== null;
  const canSubmit = !locked && sourcePoolId.length > 0 && destinationPoolId.length > 0 && preview.movable > 0;

  const handleConfirm = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const nextResult = await onConfirm(sourcePoolId, destinationPoolId);
      setResult(nextResult);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="bulk-pool-reassignment-modal">
        <DialogHeader>
          <DialogTitle>Move Tasks Between Pools</DialogTitle>
          <DialogDescription>
            Reassign loaded non-merge tasks from one execution pool to another.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">Source pool</span>
              <select
                value={sourcePoolId}
                onChange={(event) => {
                  setSourcePoolId(event.target.value);
                  setResult(null);
                }}
                disabled={locked || poolOptions.length === 0}
                className="h-9 min-w-0 rounded border border-border-strong bg-muted px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="bulk-pool-source-select"
              >
                {poolOptions.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>

            <label className="grid gap-1.5 text-xs text-muted-foreground">
              <span className="uppercase tracking-wide">Destination pool</span>
              <select
                value={destinationPoolId}
                onChange={(event) => {
                  setDestinationPoolId(event.target.value);
                  setResult(null);
                }}
                disabled={locked || destinationOptions.length === 0}
                className="h-9 min-w-0 rounded border border-border-strong bg-muted px-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="bulk-pool-destination-select"
              >
                {destinationOptions.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>
          </div>

          <fieldset
            className="rounded border border-border bg-secondary/70 p-3"
            data-testid="bulk-pool-scope"
          >
            <legend className="px-1 text-xs uppercase tracking-wide text-muted-foreground">Apply scope</legend>
            <label className="mt-1 flex items-start gap-2 text-sm text-foreground">
              <input type="radio" checked readOnly className="mt-1" />
              <span>
                Loaded tasks in the current UI state
                <span className="block text-xs text-muted-foreground">
                  {preview.loadedNonMerge} non-merge tasks are eligible for pool reassignment.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="grid gap-2 rounded border border-border bg-muted/40 p-3 text-xs sm:grid-cols-3">
            <div>
              <div className="text-muted-foreground">Will move</div>
              <div className="mt-1 text-lg font-semibold text-foreground" data-testid="bulk-pool-preview-count">
                {preview.movable}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Already in destination</div>
              <div className="mt-1 text-lg font-semibold text-foreground" data-testid="bulk-pool-already-targeted-count">
                {preview.alreadyTargeted}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Merge nodes skipped</div>
              <div className="mt-1 text-lg font-semibold text-foreground" data-testid="bulk-pool-merge-skipped-count">
                {preview.sourceMerge}
              </div>
            </div>
          </div>

          {poolOptions.length < 2 && (
            <p className="rounded border border-amber-700 bg-amber-950/40 p-3 text-xs text-amber-100">
              At least two execution pools are required to move tasks.
            </p>
          )}

          {poolOptions.length >= 2 && preview.movable === 0 && !result && (
            <p className="rounded border border-border bg-secondary/70 p-3 text-xs text-muted-foreground">
              No loaded non-merge tasks currently match the selected source pool.
            </p>
          )}

          {result && (
            <div
              className="rounded border border-border-strong bg-card p-3 text-sm"
              data-testid="bulk-pool-result"
            >
              <div className="font-medium text-foreground">
                Moved {result.moved} of {result.attempted} matching tasks.
              </div>
              <div className="mt-1 text-xs text-muted-foreground" data-testid="bulk-pool-skipped-count">
                Skipped {result.skipped} tasks ({result.skippedMerge} merge, {result.skippedAlreadyTargeted} already in destination).
                {result.failed > 0 ? ` Failed ${result.failed}.` : ''}
              </div>
              {result.failed > 0 && (
                <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs text-red-200">
                  {formatFailureDetails(result)}
                </pre>
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
              <Button type="button" variant="ghost" onClick={onClose} disabled={submitting} data-testid="bulk-pool-cancel">
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={!canSubmit}
                data-testid="bulk-pool-confirm"
              >
                {submitting ? 'Moving...' : `Move ${preview.movable} Tasks`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
