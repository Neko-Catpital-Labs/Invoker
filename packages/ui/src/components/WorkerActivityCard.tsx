import { useEffect, useState } from 'react';
import type { WorkerStatusEntry, WorkerStatusSnapshot } from '../types.js';
import { formatWorkerValue, getActiveWorkerAction, getWorkerDisplayCopy } from '../lib/worker-display.js';

interface WorkerActivityCardProps {
  snapshot: WorkerStatusSnapshot | null;
  selectedWorkerKind: string | null;
  readOnly: boolean;
  onStartWorker: (kind: string) => Promise<void> | void;
  onStopWorker: (kind: string) => Promise<void> | void;
  onSelectWorker: (kind: string) => void;
}

type OptimisticLifecycle = 'running' | 'stopped';

function processClass(lifecycle: string): string {
  if (lifecycle === 'running') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
  if (lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-border-strong bg-muted/60 text-muted-foreground';
}

function activityClass(worker: WorkerStatusEntry, lifecycle: string): string {
  if (getActiveWorkerAction(worker)) return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  if (lifecycle === 'running') return 'border-border-strong bg-muted/60 text-muted-foreground';
  if (lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-border-strong bg-muted/60 text-muted-foreground';
}

function policyClass(worker: WorkerStatusEntry): string {
  if (worker.policy === 'disabled') return 'border-rose-500/40 bg-rose-500/10 text-rose-200';
  return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
}

function activityLabel(worker: WorkerStatusEntry, lifecycle: string): string {
  if (getActiveWorkerAction(worker)) return 'Active work';
  if (lifecycle === 'running') return 'Idle';
  if (lifecycle === 'exited') return 'Exited';
  return 'Stopped';
}

function activityExplanation(worker: WorkerStatusEntry, lifecycle: string): string {
  const action = getActiveWorkerAction(worker);
  if (action) return `Active work: ${formatWorkerValue(action.actionType)} · ${formatWorkerValue(action.status)}`;
  if (lifecycle === 'running') return getWorkerDisplayCopy(worker.kind).idleText;
  if (lifecycle === 'exited') return 'Process exited. Enable it to create a fresh runtime.';
  return 'Worker disabled. Enable it to listen for work.';
}

export function WorkerActivityCard({
  snapshot,
  selectedWorkerKind,
  readOnly,
  onStartWorker,
  onStopWorker,
  onSelectWorker,
}: WorkerActivityCardProps) {
  const [optimisticByKind, setOptimisticByKind] = useState<Record<string, OptimisticLifecycle>>({});
  const [pendingByKind, setPendingByKind] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!snapshot) return;
    setOptimisticByKind((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const worker of snapshot.workers) {
        if (!(worker.kind in next)) continue;
        const serverRunning = worker.lifecycle === 'running';
        const optimisticRunning = next[worker.kind] === 'running';
        if (serverRunning === optimisticRunning) {
          delete next[worker.kind];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    setPendingByKind((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const worker of snapshot.workers) {
        if (!next[worker.kind]) continue;
        const optimistic = optimisticByKind[worker.kind];
        if (!optimistic) {
          delete next[worker.kind];
          changed = true;
          continue;
        }
        const serverRunning = worker.lifecycle === 'running';
        const optimisticRunning = optimistic === 'running';
        if (serverRunning === optimisticRunning) {
          delete next[worker.kind];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [snapshot, optimisticByKind]);

  return (
    <div data-testid="worker-activity-card">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-foreground">Worker processes ({snapshot?.workers.length ?? 0})</h3>
        <div className="mt-1 text-sm text-muted-foreground">Enabled workers are restored on launch. A running process can be idle.</div>
      </div>

      {!snapshot ? (
        <div className="rounded border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">Worker status unavailable</div>
      ) : (
        <div className="space-y-3">
          {snapshot.workers.map((worker) => {
            const copy = getWorkerDisplayCopy(worker.kind);
            const disabledTitle = readOnly ? 'Read-only window' : worker.controlDisabledReason;
            const lifecycle = optimisticByKind[worker.kind] ?? worker.lifecycle;
            const showStart = lifecycle !== 'running';
            const pending = Boolean(pendingByKind[worker.kind]);
            const isControlDisabled = Boolean(disabledTitle) || pending;
            const selected = selectedWorkerKind === worker.kind;
            const launchesOnStart = worker.desiredEnabled ?? worker.autoStarts;
            const footer = worker.kind === 'pr-status'
              ? 'No queue task is expected for this worker.'
              : selected
                ? 'Details are in the right panel.'
                : null;
            return (
              <div
                key={worker.kind}
                role="button"
                tabIndex={0}
                className={`block w-full cursor-pointer rounded-xl border p-3 text-left transition-colors ${
                  selected
                    ? 'border-cyan-500/80 bg-cyan-950/30 ring-1 ring-cyan-500/60'
                    : 'border-border bg-card/60 hover:border-border hover:bg-secondary/80'
                }`}
                data-testid={`worker-row-${worker.kind}`}
                onClick={() => onSelectWorker(worker.kind)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectWorker(worker.kind);
                  }
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground">{copy.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">Kind: {worker.kind}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[11px] ${processClass(lifecycle)}`}
                        data-testid={`worker-lifecycle-${worker.kind}`}
                        data-lifecycle={lifecycle}
                      >
                        Process: {formatWorkerValue(lifecycle)}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${activityClass(worker, lifecycle)}`}>
                        {activityLabel(worker, lifecycle)}
                      </span>
                      {worker.policy !== 'enabled' && (
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${policyClass(worker)}`}>
                          {formatWorkerValue(worker.policy)}{worker.policyReason ? ` · ${worker.policyReason}` : ''}
                        </span>
                      )}
                      {launchesOnStart && (
                        <span className="rounded-full border border-border-strong bg-accent/30 px-2 py-0.5 text-[11px] text-muted-foreground">
                          Starts on launch
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-sm text-muted-foreground">{activityExplanation(worker, lifecycle)}</div>
                    {footer ? <div className="mt-1 text-xs text-muted-foreground">{footer}</div> : null}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted"
                    title={disabledTitle}
                    disabled={isControlDisabled}
                    data-testid={`worker-start-stop-${worker.kind}`}
                    data-action={showStart ? 'start' : 'stop'}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (pending || isControlDisabled) return;
                      const nextLifecycle: OptimisticLifecycle = showStart ? 'running' : 'stopped';
                      setOptimisticByKind((prev) => ({ ...prev, [worker.kind]: nextLifecycle }));
                      setPendingByKind((prev) => ({ ...prev, [worker.kind]: true }));
                      const action = showStart ? onStartWorker(worker.kind) : onStopWorker(worker.kind);
                      void Promise.resolve(action).finally(() => {
                        setPendingByKind((prev) => {
                          const next = { ...prev };
                          delete next[worker.kind];
                          return next;
                        });
                      });
                    }}
                  >
                    {pending ? (showStart ? 'Enabling…' : 'Disabling…') : showStart ? 'Enable worker' : 'Disable worker'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
