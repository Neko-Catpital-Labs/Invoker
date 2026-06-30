import type { MouseEvent } from 'react';
import type { WorkflowStatus } from '../types.js';

export type ShellViewMode = 'dag' | 'history' | 'timeline' | 'queue' | 'actionGraph';

export interface StatusColumnItem {
  id: string;
  label: string;
  detail?: string;
}

interface LeftStatusColumnProps {
  planName: string | null;
  workflowCount: number;
  activeView: ShellViewMode;
  showStart: boolean;
  showStop: boolean;
  onOpenFile: () => void;
  onStart: () => void;
  onStop: () => void;
  onSelectView: (view: ShellViewMode) => void;
  onRefresh: () => void;
  onClear: () => void;
  onDeleteHistory: () => void;
  onOpenSettings: () => void;
  attentionItems: StatusColumnItem[];
  runningItems: StatusColumnItem[];
  visibleStatusKeys: readonly WorkflowStatus[];
  activeStatusKey: WorkflowStatus | null;
  onStatusClick: (status: WorkflowStatus, event: MouseEvent) => void;
  settingsIcon: JSX.Element;
}

const NAV_ITEMS: Array<{ view: ShellViewMode; label: string; testId: string }> = [
  { view: 'dag', label: 'Home', testId: 'rail-home' },
  { view: 'timeline', label: 'Timeline', testId: 'rail-timeline' },
  { view: 'history', label: 'History', testId: 'rail-history' },
  { view: 'actionGraph', label: 'Action Graph', testId: 'rail-action-graph' },
  { view: 'queue', label: 'Queue', testId: 'rail-queue' },
];

function sectionTitle(title: string): JSX.Element {
  return <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">{title}</h2>;
}

export function LeftStatusColumn({
  planName,
  workflowCount,
  activeView,
  showStart,
  showStop,
  onOpenFile,
  onStart,
  onStop,
  onSelectView,
  onRefresh,
  onClear,
  onDeleteHistory,
  onOpenSettings,
  attentionItems,
  runningItems,
  visibleStatusKeys,
  activeStatusKey,
  onStatusClick,
  settingsIcon,
}: LeftStatusColumnProps): JSX.Element {
  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-gray-800 bg-[#080b10]">
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            {sectionTitle('Run')}
            <button
              data-testid="rail-open-file"
              type="button"
              onClick={onOpenFile}
              className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
            >
              Open
            </button>
          </div>

          <div className="rounded-lg border border-gray-800 bg-gray-950/70 p-3">
            {workflowCount === 0 ? (
              <div className="text-sm font-medium text-gray-300">No runs yet</div>
            ) : (
              <div className="text-sm font-medium text-gray-200">
                {workflowCount} {workflowCount === 1 ? 'run' : 'runs'}
              </div>
            )}
            <div className="mt-1 truncate text-xs text-gray-500" title={planName ?? undefined}>
              {planName ?? 'Start with a goal.'}
            </div>
            <div className="mt-3 flex gap-2">
              {showStart && (
                <button
                  data-testid="rail-start"
                  type="button"
                  onClick={onStart}
                  className="rounded border border-emerald-700 bg-emerald-950 px-3 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-900"
                >
                  Run
                </button>
              )}
              {showStop && (
                <button
                  data-testid="rail-stop"
                  type="button"
                  onClick={onStop}
                  className="rounded border border-red-800 bg-red-950 px-3 py-1.5 text-xs font-medium text-red-100 hover:bg-red-900"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="space-y-2">
          {sectionTitle('Views')}
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.view}
                data-testid={item.testId}
                type="button"
                onClick={() => onSelectView(item.view)}
                className={`w-full rounded px-3 py-2 text-left text-xs ${
                  activeView === item.view
                    ? 'bg-gray-800 text-white'
                    : 'text-gray-300 hover:bg-gray-800/70'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          {sectionTitle('Attention')}
          {attentionItems.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-sm text-gray-400">All clear</div>
          ) : (
            <div data-testid="rail-attention" className="space-y-1">
              {attentionItems.map((item) => (
                <div key={item.id} className="rounded border border-amber-800/60 bg-amber-950/30 px-3 py-2">
                  <div className="truncate text-sm text-amber-100">{item.label}</div>
                  {item.detail && <div className="truncate text-xs text-amber-300/70">{item.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          {sectionTitle('Running Tasks')}
          {runningItems.length === 0 ? (
            <div className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2 text-sm text-gray-400">No tasks running</div>
          ) : (
            <div className="space-y-1">
              {runningItems.map((item) => (
                <div key={item.id} className="rounded border border-cyan-900/70 bg-cyan-950/20 px-3 py-2">
                  <div className="truncate text-sm text-cyan-100">{item.label}</div>
                  {item.detail && <div className="truncate text-xs text-cyan-300/70">{item.detail}</div>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          {sectionTitle('Workflow Status')}
          <div className="flex flex-wrap gap-1">
            {visibleStatusKeys.map((key) => (
              <button
                key={key}
                type="button"
                data-testid={`workflow-status-pill-${key}`}
                onClick={(event) => onStatusClick(key, event)}
                className={`rounded border px-2 py-1 text-[11px] ${
                  activeStatusKey === key
                    ? 'border-blue-500 bg-blue-950 text-blue-100'
                    : 'border-gray-800 bg-gray-950 text-gray-400 hover:bg-gray-800'
                }`}
              >
                {key.replaceAll('_', ' ')}
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-1 border-t border-gray-800 pt-4">
          <button
            data-testid="rail-refresh"
            type="button"
            onClick={onRefresh}
            className="w-full rounded px-3 py-2 text-left text-xs text-gray-300 hover:bg-gray-800/70"
          >
            Refresh
          </button>
          <button
            data-testid="rail-clear"
            type="button"
            onClick={onClear}
            className="w-full rounded px-3 py-2 text-left text-xs text-gray-300 hover:bg-gray-800/70"
          >
            Clear
          </button>
          <button
            data-testid="rail-delete-history"
            type="button"
            onClick={onDeleteHistory}
            className="w-full rounded px-3 py-2 text-left text-xs text-red-300 hover:bg-red-950/50"
          >
            Delete
          </button>
        </section>
      </div>

      <div className="border-t border-gray-800 p-3">
        <button
          data-testid="rail-settings"
          type="button"
          onClick={onOpenSettings}
          className="flex h-9 w-full items-center justify-center rounded text-gray-300 hover:bg-gray-800/70 hover:text-white"
          aria-label="Settings"
          title="Settings"
        >
          {settingsIcon}
        </button>
      </div>
    </aside>
  );
}
