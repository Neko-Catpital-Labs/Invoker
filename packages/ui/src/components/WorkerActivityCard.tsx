import { useEffect, useState } from 'react';
import type { WorkerStatusEntry, WorkerStatusSnapshot } from '../types.js';
import { formatWorkerValue, getActiveWorkerAction, getWorkerDisplayCopy } from '../lib/worker-display.js';

interface WorkerActivityCardProps {
  snapshot: WorkerStatusSnapshot | null;
  selectedWorkerKind: string | null;
  readOnly?: boolean;
  onStartWorker?: (kind: string) => Promise<void> | void;
  onStopWorker?: (kind: string) => Promise<void> | void;
  onSetWorkersEnabled?: (enabled: boolean) => Promise<void> | void;
  onSelectWorker: (kind: string) => void;
  showControls?: boolean;
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
  readOnly = false,
  onStartWorker,
  onStopWorker,
  onSetWorkersEnabled,
  onSelectWorker,
  showControls = true,
}: WorkerActivityCardProps) {
  const [optimisticByKind, setOptimisticByKind] = useState<Record<string, OptimisticLifecycle>>({});
  const [pendingByKind, setPendingByKind] = useState<Record<string, boolean>>({});
  const [optimisticGlobalEnabled, setOptimisticGlobalEnabled] = useState<boolean | null>(null);
  const [globalPending, setGlobalPending] = useState(false);

  const serverGlobalEnabled = snapshot?.globalEnabled ?? true;
  const globalEnabled = optimisticGlobalEnabled ?? serverGlobalEnabled;

  useEffect(() => {
    if (optimisticGlobalEnabled === null) return;
    if (serverGlobalEnabled === optimisticGlobalEnabled) {
      setOptimisticGlobalEnabled(null);
    }
  }, [serverGlobalEnabled, optimisticGlobalEnabled]);

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
    <div data-testid="worker-activity-card" className="flex min-h-0 flex-col">
      {snapshot && showControls ? (
        <div
          data-testid="worker-global-switch-row"
          className="mb-3 flex shrink-0 items-center justify-between gap-3 rounded border border-border bg-card/60 px-3 py-2"
        >
          <div className="min-w-0">
            <div className="text-sm text-foreground">All workers</div>
            <div className="text-xs text-muted-foreground">
              {globalEnabled
                ? 'Workers run as configured below.'
                : 'Master switch is off. No worker runs, and each worker keeps its own setting for when you turn this back on.'}
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={globalEnabled}
            aria-label="Turn all workers on or off"
            className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted"
            title={readOnly ? 'Read-only window' : undefined}
            disabled={readOnly || globalPending || !onSetWorkersEnabled}
            data-testid="worker-global-switch"
            data-action={globalEnabled ? 'disable-all' : 'enable-all'}
            onClick={() => {
              if (globalPending || readOnly || !onSetWorkersEnabled) return;
              const next = !globalEnabled;
              setOptimisticGlobalEnabled(next);
              setGlobalPending(true);
              void Promise.resolve(onSetWorkersEnabled(next)).finally(() => setGlobalPending(false));
            }}
          >
            {globalPending
              ? (globalEnabled ? 'Turning off…' : 'Turning on…')
              : globalEnabled ? 'Turn workers off' : 'Turn workers on'}
          </button>
        </div>
      ) : null}
      {!snapshot ? (
        <div className="rounded border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">Worker status unavailable</div>
      ) : (
        <div data-testid="worker-process-list" className="min-h-0 space-y-3">
          {snapshot.workers.map((worker) => {
            const copy = getWorkerDisplayCopy(worker.kind);
            const disabledTitle = readOnly
              ? 'Read-only window'
              : !globalEnabled
                ? 'Workers are turned off'
                : worker.controlDisabledReason;
            const lifecycle = optimisticByKind[worker.kind] ?? worker.lifecycle;
            const showStart = lifecycle !== 'running';
            const pending = Boolean(pendingByKind[worker.kind]);
            const controlUnavailable = showStart ? !onStartWorker : !onStopWorker;
            const isControlDisabled = Boolean(disabledTitle) || pending || controlUnavailable;
            const controlTitle = disabledTitle ?? (controlUnavailable ? 'Worker control unavailable' : undefined);
            const selected = selectedWorkerKind === worker.kind;
            const launchesOnStart = worker.desiredEnabled ?? worker.autoStarts;
            const recentLogs = worker.recentLogs ?? [];
            const latestLog = recentLogs[0];
            const latestAction = worker.recentActions[0];
            const footer = latestLog
              ? `Latest log: ${latestLog.summary ?? formatWorkerValue(latestLog.eventType ?? latestLog.actionType ?? latestLog.source)}`
              : latestAction
                ? `Latest response: ${latestAction.summary ?? `${formatWorkerValue(latestAction.actionType)} · ${formatWorkerValue(latestAction.status)}`}`
                : worker.kind === 'pr-status'
                  ? 'No queue task is expected for this worker.'
                  : selected
                    ? 'Details are in the right panel.'
                    : 'No worker responses have been logged yet.';
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
                    {worker.note ? <div className="mt-1 text-xs text-muted-foreground">{worker.note}</div> : null}
                    <div className="mt-1 text-xs text-muted-foreground">Source: {formatWorkerValue(worker.source)}</div>
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
                  {showControls ? (
                    <button
                      type="button"
                      className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted"
                      title={controlTitle}
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
                        const action = showStart ? onStartWorker?.(worker.kind) : onStopWorker?.(worker.kind);
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
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
