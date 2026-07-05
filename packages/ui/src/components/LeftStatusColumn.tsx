import type { QueueStatus } from '@invoker/contracts';
import type { JSX } from 'react';
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
  planningSessionCount: number;
  onOpenSettings: () => void;
}

interface SourceItem {
  key: Exclude<SidebarSurface, 'home'>;
  label: string;
  count: number;
  tone: 'neutral' | 'attention' | 'running';
  icon: JSX.Element;
}

function SidebarIcon({ children }: { children: JSX.Element }): JSX.Element {
  return <span className="inline-flex h-4 w-4 items-center justify-center" aria-hidden="true">{children}</span>;
}

function HomeIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5 12 3l9 7.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 9.75V21h13.5V9.75" />
      </svg>
    </SidebarIcon>
  );
}

function AttentionIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 17.25h.008v.008H12z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.29 3.86 1.82 18a1.5 1.5 0 0 0 1.28 2.25h16.94A1.5 1.5 0 0 0 21.32 18L12.85 3.86a1 1 0 0 0-1.72 0Z" />
      </svg>
    </SidebarIcon>
  );
}

function RunningIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <circle cx="12" cy="12" r="8.25" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 7.5v4.75l3 1.75" />
      </svg>
    </SidebarIcon>
  );
}

function WorkflowsIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <rect x="3.75" y="4.5" width="7.5" height="6.75" rx="1.5" />
        <rect x="12.75" y="4.5" width="7.5" height="6.75" rx="1.5" />
        <rect x="8.25" y="12.75" width="7.5" height="6.75" rx="1.5" />
      </svg>
    </SidebarIcon>
  );
}
function PlanningTerminalIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 5.25h15A1.5 1.5 0 0 1 21 6.75v9a1.5 1.5 0 0 1-1.5 1.5h-6L9 20.25v-3h-4.5A1.5 1.5 0 0 1 3 15.75v-9a1.5 1.5 0 0 1 1.5-1.5Z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m7.5 9 2 2-2 2" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 13h4.5" />
      </svg>
    </SidebarIcon>
  );
}


function SettingsIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.2 3.86a1 1 0 0 1 1.6 0l.66.95a1 1 0 0 0 1.02.4l1.14-.23a1 1 0 0 1 1.13.88l.11 1.15a1 1 0 0 0 .67.84l1.08.38a1 1 0 0 1 .54 1.5l-.6.99a1 1 0 0 0 0 1.08l.6.99a1 1 0 0 1-.54 1.5l-1.08.38a1 1 0 0 0-.67.84l-.11 1.15a1 1 0 0 1-1.13.88l-1.14-.23a1 1 0 0 0-1.02.4l-.66.95a1 1 0 0 1-1.6 0l-.66-.95a1 1 0 0 0-1.02-.4l-1.14.23a1 1 0 0 1-1.13-.88l-.11-1.15a1 1 0 0 0-.67-.84l-1.08-.38a1 1 0 0 1-.54-1.5l.6-.99a1 1 0 0 0 0-1.08l-.6-.99a1 1 0 0 1 .54-1.5l1.08-.38a1 1 0 0 0 .67-.84l.11-1.15a1 1 0 0 1 1.13-.88l1.14.23a1 1 0 0 0 1.02-.4l.66-.95Z" />
        <circle cx="12" cy="12" r="2.75" />
      </svg>
    </SidebarIcon>
  );
}

function InvokerIcon(): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.75v4.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75v4.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m5.64 5.64 3.18 3.18" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m15.18 15.18 3.18 3.18" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h4.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 12h4.5" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m5.64 18.36 3.18-3.18" />
        <path strokeLinecap="round" strokeLinejoin="round" d="m15.18 8.82 3.18-3.18" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    </SidebarIcon>
  );
}

function CollapseIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <SidebarIcon>
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d={collapsed ? 'm10 6 6 6-6 6' : 'm14 6-6 6 6 6'} />
      </svg>
    </SidebarIcon>
  );
}

function navButtonClass(selected: boolean, collapsed: boolean): string {
  return [
    'flex w-full items-center rounded-lg text-left transition-colors',
    collapsed ? 'justify-center px-2 py-2.5' : 'justify-between gap-3 px-3 py-2',
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
  planningSessionCount,
  onOpenSettings,
}: LeftStatusColumnProps): JSX.Element {
  const workflowEntries = getSortedWorkflows(workflows, tasks);
  const attentionEntries = getAttentionTaskEntries(tasks, workflows);
  const runningEntries = getRunningTaskEntries(tasks, workflows, queueStatus);

  const sources: SourceItem[] = [
    { key: 'attention', label: 'Needs Attention', count: attentionEntries.length, tone: 'attention', icon: <AttentionIcon /> },
    { key: 'running', label: 'Running', count: runningEntries.length, tone: 'running', icon: <RunningIcon /> },
    { key: 'workflows', label: 'Workflows', count: workflowEntries.length, tone: 'neutral', icon: <WorkflowsIcon /> },
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
        aria-current={selectedSurface === 'home' ? 'page' : undefined}
        onClick={() => onSelectSurface('home')}
        className={[
          'rounded-xl text-left hover:bg-gray-900/80',
          collapsed ? 'px-2 py-3 text-center' : 'px-3 py-2',
        ].join(' ')}
      >
        {collapsed ? (
          <div className={`inline-flex text-gray-100 ${selectedSurface === 'home' ? 'text-white' : 'text-gray-100'}`}>
            <InvokerIcon />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className={`inline-flex rounded-lg border border-gray-800 bg-gray-900/80 p-2 ${selectedSurface === 'home' ? 'text-white' : 'text-gray-100'}`}>
              <InvokerIcon />
            </span>
            <div>
              <div className={`text-base font-semibold ${selectedSurface === 'home' ? 'text-white' : 'text-gray-100'}`}>Invoker</div>
              <div className="mt-1 text-xs text-gray-500">Home</div>
            </div>
          </div>
        )}
      </button>

      <button
        type="button"
        aria-label="Planning Terminal"
        data-testid="sidebar-planning"
        data-sidebar-nav-item
        data-sidebar-nav-order="2"
        aria-current={selectedSurface === 'planning' ? 'page' : undefined}
        onClick={() => onSelectSurface('planning')}
        className={[
          'mt-4',
          navButtonClass(selectedSurface === 'planning', collapsed),
        ].join(' ')}
      >
        {collapsed ? (
          <div className="relative inline-flex h-9 w-9 items-center justify-center">
            <span><PlanningTerminalIcon /></span>
            {planningSessionCount > 0 && (
              <span className={`absolute -right-1 -top-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${countClass('neutral')}`}>
                {planningSessionCount}
              </span>
            )}
          </div>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-3">
              <span className="inline-flex rounded-md border border-gray-800 bg-gray-900/70 p-1.5 text-gray-300">
                <PlanningTerminalIcon />
              </span>
              <span className="truncate">Planning Terminal</span>
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${countClass('neutral')}`}>
              {planningSessionCount}
            </span>
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
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelectSurface(source.key)}
              className={navButtonClass(selected, collapsed)}
            >
              {collapsed ? (
                <div className="relative inline-flex h-9 w-9 items-center justify-center">
                  <span>{source.icon}</span>
                  {source.count > 0 && (
                    <span className={`absolute -right-1 -top-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none ${countClass(source.tone)}`}>
                      {source.count}
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="inline-flex rounded-md border border-gray-800 bg-gray-900/70 p-1.5 text-gray-300">
                      {source.icon}
                    </span>
                    <span className="truncate">{source.label}</span>
                  </span>
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
              : `${attentionEntries.length} item${attentionEntries.length === 1 ? ' needs' : 's need'} attention.`
          )}
          {selectedSurface === 'running' && (
            runningEntries.length === 0
              ? 'No tasks are running right now.'
              : `${runningEntries.length} task${runningEntries.length === 1 ? '' : 's'} active now.`
          )}
          {selectedSurface === 'home' && 'Plan graph details live here.'}
          {selectedSurface === 'planning' && `${planningSessionCount} planning chat${planningSessionCount === 1 ? '' : 's'}.`}
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
            collapsed ? 'justify-center px-2 py-2.5' : 'justify-center gap-2 px-3 py-2',
          ].join(' ')}
        >
          <SettingsIcon />
          {!collapsed && <span>Settings</span>}
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
            <CollapseIcon collapsed={collapsed} />
          ) : (
            <span className="flex items-center gap-2">
              <CollapseIcon collapsed={collapsed} />
              <span>Collapse</span>
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
