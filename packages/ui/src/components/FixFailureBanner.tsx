import type { ReactElement } from 'react';
import type { FixFailureRecord } from '../types.js';

interface FixFailureBannerProps {
  taskId: string;
  record: FixFailureRecord;
  agents: readonly string[];
  dismissedRecordKeys: ReadonlySet<string>;
  onDismissRecordKey: (recordKey: string) => void;
  onRetry?: (agentName: string) => void;
}

function formatResetTime(resetsAt: string | Date): string {
  return new Date(resetsAt).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function fixFailureHeadline(record: FixFailureRecord): string {
  if (record.failureClass === 'agent-usage-limit') {
    const reset = record.resetsAt ? ` · resets ${formatResetTime(record.resetsAt)}` : '';
    return `${record.agent} hit its usage limit${reset}`;
  }
  if (record.failureClass === 'agent-spend-gate') {
    return `${record.agent} is switched off by the daily spend gate`;
  }
  return `${record.agent} fix failed`;
}

export function FixFailureBanner({
  taskId,
  record,
  agents,
  dismissedRecordKeys,
  onDismissRecordKey,
  onRetry,
}: FixFailureBannerProps): ReactElement | null {
  const recordKey = `${taskId}:${String(record.at)}`;
  if (dismissedRecordKeys.has(recordKey)) return null;

  const retryAgents = agents.filter((agent) => agent !== record.agent);
  const showsMessage = record.failureClass !== 'agent-usage-limit' && record.failureClass !== 'agent-spend-gate';

  return (
    <section data-testid="fix-failure-banner" className="rounded border border-amber-500/40 bg-amber-950/40 p-3">
      <h3 className="text-[11px] uppercase tracking-wide text-amber-200">Auto-fix couldn&apos;t run</h3>
      <p data-testid="fix-failure-headline" className="mt-1 text-xs font-semibold text-amber-100 break-words">
        {fixFailureHeadline(record)}
      </p>
      <p className="mt-1 text-xs text-amber-100/80">The task&apos;s own error is shown below, unchanged.</p>
      {showsMessage && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-amber-200">Fix output</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-amber-100">{record.message}</pre>
        </details>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {onRetry && retryAgents.map((agent) => (
          <button
            key={agent}
            type="button"
            data-testid={`fix-failure-retry-${agent}`}
            className="rounded border border-amber-400/50 px-2 py-1 text-xs text-amber-100 hover:bg-amber-900/60"
            onClick={() => onRetry(agent)}
          >
            Retry fix with {agent}
          </button>
        ))}
        <button
          type="button"
          data-testid="fix-failure-dismiss"
          className="rounded px-2 py-1 text-xs text-amber-200/80 hover:text-amber-100"
          onClick={() => onDismissRecordKey(recordKey)}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
