import { useEffect, useState } from 'react';
import type { WorkerStatusEntry } from '../types.js';

interface WorkerDetailControlProps {
  worker: WorkerStatusEntry;
  readOnly?: boolean;
  onStartWorker: (kind: string) => Promise<void> | void;
  onStopWorker: (kind: string) => Promise<void> | void;
}

type OptimisticLifecycle = 'running' | 'stopped';

export function WorkerDetailControl({
  worker,
  readOnly = false,
  onStartWorker,
  onStopWorker,
}: WorkerDetailControlProps) {
  const [optimistic, setOptimistic] = useState<OptimisticLifecycle | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setOptimistic(null);
    setPending(false);
  }, [worker.kind]);

  useEffect(() => {
    if (!optimistic) return;
    const serverRunning = worker.lifecycle === 'running';
    if (serverRunning === (optimistic === 'running')) {
      setOptimistic(null);
    }
  }, [worker.lifecycle, optimistic]);

  const lifecycle = optimistic ?? worker.lifecycle;
  const showStart = lifecycle !== 'running';
  const disabledReason = readOnly ? 'Read-only window' : worker.controlDisabledReason;
  const disabled = Boolean(disabledReason) || pending;

  return (
    <button
      type="button"
      data-testid="worker-detail-start-stop"
      data-action={showStart ? 'start' : 'stop'}
      title={disabledReason}
      disabled={disabled}
      className="rounded border border-gray-700 px-3 py-1.5 text-xs text-gray-200 disabled:cursor-not-allowed disabled:opacity-50 hover:bg-gray-800"
      onClick={() => {
        if (disabled) return;
        setOptimistic(showStart ? 'running' : 'stopped');
        setPending(true);
        void Promise.resolve(showStart ? onStartWorker(worker.kind) : onStopWorker(worker.kind))
          .catch((error: unknown) => {
            setOptimistic(null);
            console.error(`Failed to ${showStart ? 'enable' : 'disable'} worker ${worker.kind}`, error);
          })
          .finally(() => setPending(false));
      }}
    >
      {pending ? (showStart ? 'Enabling…' : 'Disabling…') : showStart ? 'Enable worker' : 'Disable worker'}
    </button>
  );
}
