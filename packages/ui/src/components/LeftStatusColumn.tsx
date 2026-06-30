import type { QueueStatus } from '@invoker/contracts';
import type { TaskState, WorkflowMeta } from '../types.js';
import type { SidebarSurface } from '../lib/workflow-progress-surfaces.js';
import { getAttentionTaskEntries, getRunningTaskEntries, getSortedWorkflows } from '../lib/workflow-progress-surfaces.js';

interface LeftStatusColumnProps {
  workflows: Map<string, WorkflowMeta>;
  tasks: Map<string, TaskState>;
  queueStatus: QueueStatus | null;
  selectedSurface: SidebarSurface;
  collapsed: boolean;
  onSelectSurface: (surface: SidebarSurface) => void;
  onToggleCollapsed: () => void;
  onOpenSettings: () => void;
}

interface SourceItem {
  key: Exclude<SidebarSurface, 'home'>;
  label: string;
  shortLabel: string;
  count: number;
  tone: 'neutral' | 'attention' | 'running';
}

function navButtonClass(selected: boolean, collapsed: boolean): string {
  return [
    'flex w-full items-center rounded-lg text-left transition-colors',
    collapsed ? 'justify-center px-2 py-2.5' : 'justify-between px-3 py-2',
    selected
      ? 'bg-gray-800/90 text-white shadow-sm'
      : 'text-gray-300 hover:bg-gray-900/80 hover:text-white',
  ].join(' ');
}

function countClass(tone: SourceItem['tone']): string {
  if (tone === 'attention') return 'bg-amber-900/70 text-amber-100';
  if (tone === 'running') return 'bg-blue-900/70 text-blue-100';
  return 'bg-gray-800 text-gray-300';
}

export function LeftStatusColumn({
  workflows,
  tasks,
  queueStatus,
  selectedSurface,
  collapsed,
  onSelectSurface,
  onToggleCollapsed,
  onOpenSettings,
}: LeftStatusColumnProps): JSX.Element {
  const workflowEntries = getSortedWorkflows(workflows, tasks);
  const attentionEntries = getAttentionTaskEntries(tasks, workflows);
  const runningEntries = getRunningTaskEntries(tasks, workflows, queueStatus);

  const sources: SourceItem[] = [
    { key: 'attention', label: 'Needs Attention', shortLabel: '!', count: attentionEntries.length, tone: 'attention' },
    { key: 'running', label: 'Running', shortLabel: 'R', count: runningEntries.length, tone: 'running' },
    { key: 'workflows', label: 'Workflows', shortLabel: 'W', count: workflowEntries.length, tone: 'neutral' },
  ];

  return (
    <aside
      data-testid="app-sidebar"
      className={[
        'flex h-full shrink-0 flex-col border-r border-gray-800 bg-gray-950/85 py-4 text-sm text-gray-200 transition-all duration-150',
        collapsed ? 'w-16 px-2' : 'w-72 px-3',
      ].join(' ')}
    >
      <button
        type="button"
        aria-label="Go home"
        data-testid="sidebar-home"
        data-sidebar-nav-item
        data-sidebar-nav-order="1"
        onClick={() => onSelectSurface('home')}
        className={[
          'rounded-xl text-left hover:bg-gray-900/80',
          collapsed ? 'px-2 py-3 text-center' : 'px-3 py-2',
        ].join(' ')}
      >
        {collapsed ? (
          <div className={`text-lg font-semibold ${selectedSurface === 'home' ? 'text-white' : 'text-gray-100'}`}>I</div>
        ) : (
          <>
            <div className={`text-base font-semibold ${selectedSurface === 'home' ? 'text-white' : 'text-gray-100'}`}>Invoker</div>
            <div className="mt-1 text-xs text-gray-500">Home</div>
          </>
        )}
      </button>

      {!collapsed && <div className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-500">Library</div>}
      <nav className={collapsed ? 'mt-4 space-y-2' : 'mt-2 space-y-1'}>
        {sources.map((source, index) => {
          const selected = selectedSurface === source.key;
          return (
            <button
              key={source.key}
              type="button"
              aria-label={source.label}
              data-testid={`sidebar-${source.key}`}
              data-sidebar-nav-item
              data-sidebar-nav-order={String(index + 2)}
              onClick={() => onSelectSurface(source.key)}
              className={navButtonClass(selected, collapsed)}
            >
              {collapsed ? (
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm font-semibold">{source.shortLabel}</span>
                  {source.count > 0 && (
                    <span className={`rounded-full px-1.5 py-0.5 text-[10px] leading-none ${countClass(source.tone)}`}>
                      {source.count}
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <span>{source.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] ${countClass(source.tone)}`}>
                    {source.count}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="mt-6 flex-1 overflow-y-auto px-3 text-xs text-gray-500">
          {selectedSurface === 'workflows' && (
            workflowEntries.length === 0
              ? 'No workflows yet'
              : `${workflowEntries.length} workflow${workflowEntries.length === 1 ? '' : 's'} ready to browse.`
          )}
          {selectedSurface === 'attention' && (
            attentionEntries.length === 0
              ? 'Nothing needs a decision right now.'
              : `${attentionEntries.length} item${attentionEntries.length === 1 ? '' : 's'} need attention.`
          )}
          {selectedSurface === 'running' && (
            runningEntries.length === 0
              ? 'No tasks are running right now.'
              : `${runningEntries.length} task${runningEntries.length === 1 ? '' : 's'} active now.`
          )}
          {selectedSurface === 'home' && 'Terminal planning and graph details live here.'}
        </div>
      )}

      <div className={[collapsed ? 'mt-auto space-y-2' : 'mt-auto border-t border-gray-800 px-3 pt-3 space-y-2'].join(' ')}>
        <button
          type="button"
          aria-label="Open settings"
          data-testid="rail-settings"
          data-sidebar-nav-item
          data-sidebar-nav-order="5"
          onClick={onOpenSettings}
          className={[
            'flex w-full items-center rounded-lg border border-gray-700 text-xs font-medium text-gray-200 hover:bg-gray-800',
            collapsed ? 'justify-center px-2 py-2.5' : 'justify-center px-3 py-2',
          ].join(' ')}
        >
          {collapsed ? 'S' : 'Settings'}
        </button>
        <button
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          data-testid="sidebar-collapse-toggle"
          onClick={onToggleCollapsed}
          className={[
            'flex w-full items-center rounded-lg border border-gray-800 text-xs text-gray-400 hover:bg-gray-900 hover:text-gray-200',
            collapsed ? 'justify-center px-2 py-2.5' : 'justify-between px-3 py-2',
          ].join(' ')}
        >
          {collapsed ? (
            <span>▸</span>
          ) : (
            <>
              <span>Collapse</span>
              <span>◂</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
