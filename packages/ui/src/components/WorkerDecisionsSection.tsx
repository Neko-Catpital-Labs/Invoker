import { useState } from 'react';
import type { WorkerActionSummary } from '../types.js';
import { useWorkerDecisions } from '../hooks/useWorkerDecisions.js';
import { displayWorkerTaskId, formatWorkerValue } from '../lib/worker-display.js';

type DecisionFilter = 'all' | 'act' | 'skip';

const FILTERS: DecisionFilter[] = ['all', 'act', 'skip'];

function decisionClass(action: WorkerActionSummary): 'act' | 'skip' {
  return action.decision ?? (action.status === 'skipped' ? 'skip' : 'act');
}

export function WorkerDecisionsSection({
  workerKind,
  workflowId,
}: {
  workerKind: string;
  workflowId?: string;
}) {
  const [filter, setFilter] = useState<DecisionFilter>('all');
  const [decisions] = useWorkerDecisions({
    workerKind,
    ...(workflowId ? { workflowId } : {}),
    ...(filter === 'all' ? {} : { decision: filter }),
    limit: 25,
  });

  return (
    <section className="rounded border border-gray-800 bg-gray-850/60 p-3" data-testid="worker-decisions-section">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Decisions</h3>
        <div className="flex gap-1">
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              data-testid={`worker-decisions-filter-${value}`}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                filter === value ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:bg-gray-800'
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>
      {decisions.length === 0 ? (
        <div className="mt-2 text-xs text-gray-500">
          No {filter === 'all' ? '' : `${filter} `}decisions recorded yet.
        </div>
      ) : (
        <ul className="mt-2 space-y-1">
          {decisions.map((decision) => {
            const cls = decisionClass(decision);
            return (
              <li
                key={decision.id}
                data-testid="worker-decision-row"
                className="rounded border border-gray-800/80 bg-gray-900/40 px-2 py-1 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1 py-0.5 text-[10px] font-semibold uppercase ${
                      cls === 'skip' ? 'bg-amber-900/50 text-amber-200' : 'bg-emerald-900/50 text-emerald-200'
                    }`}
                  >
                    {cls}
                  </span>
                  <span className="text-gray-300">{formatWorkerValue(decision.status)}</span>
                  {decision.taskId ? (
                    <span className="truncate text-gray-400">{displayWorkerTaskId(decision.taskId)}</span>
                  ) : (
                    <span className="truncate text-gray-400">{decision.subjectId}</span>
                  )}
                </div>
                {decision.reason ? <div className="mt-0.5 text-gray-400">reason: {decision.reason}</div> : null}
                {decision.summary ? <div className="mt-0.5 text-gray-500">{decision.summary}</div> : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
