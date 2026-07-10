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

function processClass(worker: WorkerStatusEntry): string {
  if (worker.lifecycle === 'running') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200';
  if (worker.lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-border-strong bg-muted/60 text-muted-foreground';
}

function activityClass(worker: WorkerStatusEntry): string {
  if (getActiveWorkerAction(worker)) return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  if (worker.lifecycle === 'running') return 'border-border-strong bg-muted/60 text-muted-foreground';
  if (worker.lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-border-strong bg-muted/60 text-muted-foreground';
}

function policyClass(worker: WorkerStatusEntry): string {
  if (worker.policy === 'disabled') return 'border-rose-500/40 bg-rose-500/10 text-rose-200';
  return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
}

function activityLabel(worker: WorkerStatusEntry): string {
  if (getActiveWorkerAction(worker)) return 'Active work';
  if (worker.lifecycle === 'running') return 'Idle';
  if (worker.lifecycle === 'exited') return 'Exited';
  return 'Stopped';
}

function activityExplanation(worker: WorkerStatusEntry): string {
  const action = getActiveWorkerAction(worker);
  if (action) return `Active work: ${formatWorkerValue(action.actionType)} · ${formatWorkerValue(action.status)}`;
  if (worker.lifecycle === 'running') return getWorkerDisplayCopy(worker.kind).idleText;
  if (worker.lifecycle === 'exited') return 'Process exited. Start it to create a fresh runtime.';
  return 'Process stopped. Start it to listen for work.';
}

export function WorkerActivityCard({
  snapshot,
  selectedWorkerKind,
  readOnly,
  onStartWorker,
  onStopWorker,
  onSelectWorker,
}: WorkerActivityCardProps) {
  return (
    <div data-testid="worker-activity-card" className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 shrink-0">
        <h3 className="text-lg font-semibold text-foreground">Worker processes ({snapshot?.workers.length ?? 0})</h3>
        <div className="mt-1 text-sm text-muted-foreground">Process status is separate from queue work. A running process can be idle.</div>
      </div>

      {!snapshot ? (
        <div className="rounded border border-border bg-card/60 px-3 py-2 text-sm text-muted-foreground">Worker status unavailable</div>
      ) : (
        <div data-testid="worker-process-list" className="min-h-0 flex-1 space-y-3">
          {snapshot.workers.map((worker) => {
            const copy = getWorkerDisplayCopy(worker.kind);
            const disabledTitle = readOnly ? 'Read-only window' : worker.controlDisabledReason;
            const showStart = worker.lifecycle !== 'running';
            const isControlDisabled = Boolean(disabledTitle);
            const selected = selectedWorkerKind === worker.kind;
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
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${processClass(worker)}`}>
                        Process: {formatWorkerValue(worker.lifecycle)}
                      </span>
                      <span className={`rounded-full border px-2 py-0.5 text-[11px] ${activityClass(worker)}`}>
                        {activityLabel(worker)}
                      </span>
                      {worker.policy !== 'enabled' && (
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] ${policyClass(worker)}`}>
                          {formatWorkerValue(worker.policy)}{worker.policyReason ? ` · ${worker.policyReason}` : ''}
                        </span>
                      )}
                      {worker.autoStarts && (
                        <span className="rounded-full border border-border-strong bg-accent/30 px-2 py-0.5 text-[11px] text-muted-foreground">
                          Auto-starts
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-sm text-muted-foreground">{activityExplanation(worker)}</div>
                    {footer ? <div className="mt-1 text-xs text-muted-foreground">{footer}</div> : null}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded border border-border-strong px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50 hover:bg-muted"
                    title={disabledTitle}
                    disabled={isControlDisabled}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (showStart) void onStartWorker(worker.kind);
                      else void onStopWorker(worker.kind);
                    }}
                  >
                    {showStart ? 'Start process' : 'Stop process'}
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
