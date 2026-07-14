import { useMemo, useState } from 'react';
import type { WorkerActionSummary } from '../types.js';
import { useWorkerDecisions } from '../hooks/useWorkerDecisions.js';
import { displayWorkerTaskId, formatWorkerValue } from '../lib/worker-display.js';

type DecisionFilter = 'all' | 'act' | 'skip';

const FILTERS: DecisionFilter[] = ['all', 'act', 'skip'];

function decisionClass(action: WorkerActionSummary): 'act' | 'skip' {
  return action.decision ?? (action.status === 'skipped' ? 'skip' : 'act');
}

function decisionTimestamp(action: WorkerActionSummary): string {
  const value = action.completedAt ?? action.updatedAt ?? action.createdAt;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toLocaleTimeString();
}

interface WorkerDecisionsSectionProps {
  workerKind?: string;
  workflowId?: string;
  taskId?: string;
  title?: string;
  emptyText?: string;
}

export function WorkerDecisionsSection({
  workerKind,
  workflowId,
  taskId,
  title = 'Decision timeline',
  emptyText,
}: WorkerDecisionsSectionProps) {
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [decisions] = useWorkerDecisions({
    ...(workerKind ? { workerKind } : {}),
    ...(workflowId ? { workflowId } : {}),
    ...(filter === 'all' ? {} : { decision: filter }),
    limit: 25,
  });
  const visibleDecisions = useMemo(
    () => (taskId ? decisions.filter((decision) => decision.taskId === taskId || decision.subjectId === taskId) : decisions),
    [decisions, taskId],
  );

  return (
    <section className="rounded border border-border bg-card/60 p-3" data-testid="worker-decisions-section">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        <div className="flex gap-1">
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`worker-decisions-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                filter === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-secondary'
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {visibleDecisions.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">
          {emptyText ?? `No ${filter === 'all' ? '' : `${filter} `}decisions recorded yet.`}
        </div>
      ) : (
        <ul className="mt-2 space-y-1">
          {visibleDecisions.map((decision) => {
            const cls = decisionClass(decision);
            const timestamp = decisionTimestamp(decision);
            return (
              <li
                key={decision.id}
                data-testid="worker-decision-row"
                className="rounded border border-border/80 bg-background/40 px-2 py-1 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${
                      cls === 'skip' ? 'bg-amber-900/50 text-amber-200' : 'bg-emerald-900/50 text-emerald-200'
                    }`}
                  >
                    {cls}
                  </span>
                  <span className="text-muted-foreground">{formatWorkerValue(decision.status)}</span>
                  {decision.taskId ? (
                    <span className="truncate text-muted-foreground">{displayWorkerTaskId(decision.taskId)}</span>
                  ) : (
                    <span className="truncate text-muted-foreground">{decision.subjectId}</span>
                  )}
                  {timestamp ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{timestamp}</span> : null}
                </div>
                {decision.reason ? <div className="mt-0.5 text-muted-foreground">reason: {decision.reason}</div> : null}
                {decision.summary ? <div className="mt-0.5 text-muted-foreground">{decision.summary}</div> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
