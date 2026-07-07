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
  return 'border-gray-600 bg-gray-700/60 text-gray-300';
}

function activityClass(worker: WorkerStatusEntry): string {
  if (getActiveWorkerAction(worker)) return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  if (worker.lifecycle === 'running') return 'border-gray-600 bg-gray-700/60 text-gray-300';
  if (worker.lifecycle === 'exited') return 'border-amber-500/40 bg-amber-500/10 text-amber-200';
  return 'border-gray-600 bg-gray-700/60 text-gray-300';
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
    <div data-testid="worker-activity-card">
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-gray-100">Worker processes ({snapshot?.workers.length ?? 0})</h3>
        <div className="mt-1 text-sm text-gray-400">Process status is separate from queue work. A running process can be idle.</div>
      </div>

      {!snapshot ? (
        <div className="rounded border border-gray-800 bg-gray-950/60 px-3 py-2 text-sm text-gray-400">Worker status unavailable</div>
      ) : (
        <div className="space-y-3">
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
                    : 'border-gray-800 bg-gray-850/60 hover:border-gray-700 hover:bg-gray-800/80'
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
                    <div className="text-sm font-semibold text-gray-100">{copy.name}</div>
                    <div className="mt-0.5 text-xs text-gray-500">Kind: {worker.kind}</div>
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
                        <span className="rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-200">
                          Auto-starts
                        </span>
                      )}
                    </div>
                    <div className="mt-2 text-sm text-gray-300">{activityExplanation(worker)}</div>
                    {footer ? <div className="mt-1 text-xs text-gray-500">{footer}</div> : null}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded border border-gray-600 px-2 py-1 text-xs text-gray-200 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-gray-700"
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
