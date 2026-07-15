import type { QueueStatus } from '@invoker/contracts';
import type { JSX } from 'react';
import type { TaskState, WorkflowMeta, WorkerStatusSnapshot } from '../types.js';
import type { SidebarSurface } from '../lib/workflow-progress-surfaces.js';
import { getAttentionTaskEntries, getSortedWorkflows } from '../lib/workflow-progress-surfaces.js';
import { countActiveWorkerActions } from '../lib/worker-display.js';
import {
  AttentionIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InvokerIcon,
  MoonIcon,
  PlanningTerminalIcon,
  SettingsIcon,
  SunIcon,
  WorkerIcon,
  WorkflowsIcon,
} from './icons/index.js';
import type { ThemeMode } from '../lib/theme.js';

interface LeftStatusColumnProps {
  workflows: Map<string, WorkflowMeta>;
  tasks: Map<string, TaskState>;
  queueStatus: QueueStatus | null;
  workerStatus: WorkerStatusSnapshot | null;
  selectedSurface: SidebarSurface;
  collapsed: boolean;
  attentionTaskIdsWithFailures?: Set<string>;
  onSelectSurface: (surface: SidebarSurface) => void;
  onToggleCollapsed: () => void;
  planningSessionCount: number;
  planningAttentionCount: number;
  onOpenSettings: () => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}

interface SourceItem {
  key: Exclude<SidebarSurface, 'home'>;
  label: string;
  count: number;
  tone: 'neutral' | 'attention' | 'running';
  icon: JSX.Element;
}

const ICON_CLASS = 'h-4 w-4';

function CollapseIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return collapsed ? <ChevronRightIcon className={ICON_CLASS} /> : <ChevronLeftIcon className={ICON_CLASS} />;
}

function navButtonClass(selected: boolean, collapsed: boolean): string {
  return [
    'flex w-full items-center rounded-md text-left transition-colors duration-100',
    collapsed ? 'justify-center px-2 py-2' : 'justify-between gap-3 px-2.5 py-1.5',
    selected
      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground',
  ].join(' ');
}

function countClass(tone: SourceItem['tone']): string {
  const base = 'border border-border';
  if (tone === 'attention') return `${base} text-amber-300`;
  if (tone === 'running') return `${base} text-foreground`;
  return `${base} text-muted-foreground`;
}

export function LeftStatusColumn({
  workflows,
  tasks,
  queueStatus,
  workerStatus,
  selectedSurface,
  collapsed,
  attentionTaskIdsWithFailures,
  onSelectSurface,
  onToggleCollapsed,
  planningSessionCount,
  planningAttentionCount,
  onOpenSettings,
  theme,
  onToggleTheme,
}: LeftStatusColumnProps): JSX.Element {
  const workflowEntries = getSortedWorkflows(workflows, tasks);
  const attentionEntries = getAttentionTaskEntries(tasks, workflows, attentionTaskIdsWithFailures);
  const runningWorkers = workerStatus?.workers.filter((worker) => worker.lifecycle === 'running').length ?? 0;
  const registeredWorkers = workerStatus?.workers.length ?? 0;
  const activeWorkerActions = workerStatus ? countActiveWorkerActions(workerStatus.workers) : 0;

  const sources: SourceItem[] = [
    { key: 'attention', label: 'Needs Attention', count: attentionEntries.length, tone: 'attention', icon: <AttentionIcon className={ICON_CLASS} /> },
    { key: 'workers', label: 'Workers', count: registeredWorkers, tone: activeWorkerActions > 0 ? 'running' : 'neutral', icon: <WorkerIcon className={ICON_CLASS} /> },
    { key: 'workflows', label: 'Workflows', count: workflowEntries.length, tone: 'neutral', icon: <WorkflowsIcon className={ICON_CLASS} /> },
  ];

  return (
    <aside
      data-testid="app-sidebar"
      className={[
        'flex h-full shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-4 text-sm text-sidebar-foreground transition-all duration-150',
        collapsed ? 'w-16 px-2' : 'w-60 px-3',
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
          'rounded-md text-left transition-colors duration-100 hover:bg-sidebar-accent/60',
          collapsed ? 'px-2 py-2.5 text-center' : 'px-2.5 py-2',
        ].join(' ')}
      >
        {collapsed ? (
          <div className="inline-flex text-sidebar-foreground">
            <InvokerIcon className={ICON_CLASS} />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="inline-flex rounded-md border border-border bg-sidebar-accent/60 p-1.5 text-sidebar-foreground">
              <InvokerIcon className={ICON_CLASS} />
            </span>
            <div>
              <div className="text-sm font-semibold text-sidebar-foreground">Invoker</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">Home</div>
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
            <span><PlanningTerminalIcon className={ICON_CLASS} /></span>
            {planningAttentionCount > 0 && (
              <span className={`absolute -right-1 -top-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none bg-background ${countClass('neutral')}`}>
                {planningAttentionCount}
              </span>
            )}
          </div>
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-3">
              <span className="inline-flex rounded-md border border-border bg-sidebar-accent/40 p-1.5 text-muted-foreground">
                <PlanningTerminalIcon className={ICON_CLASS} />
              </span>
              <span className="truncate">Planning Terminal</span>
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${countClass('neutral')}`}>
              {planningAttentionCount}
            </span>
          </>
        )}
      </button>

      {!collapsed && <div className="mt-6 px-2.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">Library</div>}
      <nav className={collapsed ? 'mt-4 space-y-1' : 'mt-2 space-y-0.5'}>
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
                    <span className={`absolute -right-1 -top-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none bg-background ${countClass(source.tone)}`}>
                      {source.count}
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="inline-flex text-muted-foreground">
                      {source.icon}
                    </span>
                    <span className="truncate">{source.label}</span>
                  </span>
                  <span className={`rounded-full px-1.5 py-0 text-[10px] leading-4 ${countClass(source.tone)}`}>
                    {source.count}
                  </span>
                </>
              )}
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <div className="mt-6 flex-1 overflow-y-auto scrollbar-sleek px-2.5 text-xs text-muted-foreground">
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
          {selectedSurface === 'workers' && (
            workerStatus === null
              ? 'Worker status is not available yet.'
              : `${runningWorkers} process${runningWorkers === 1 ? '' : 'es'} running · ${activeWorkerActions} active action${activeWorkerActions === 1 ? '' : 's'}`
          )}
          {selectedSurface === 'home' && 'Plan graph details live here.'}
          {selectedSurface === 'planning' && `${planningSessionCount} planning chat${planningSessionCount === 1 ? '' : 's'}.`}
        </div>
      )}

      <div className={[collapsed ? 'mt-auto space-y-1.5' : 'mt-auto border-t border-sidebar-border px-2.5 pt-3 space-y-1.5'].join(' ')}>
        <button
          type="button"
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
          data-testid="rail-theme-toggle"
          data-theme={theme}
          onClick={onToggleTheme}
          className={[
            'flex w-full items-center rounded-md border border-border text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors duration-100',
            collapsed ? 'justify-center px-2 py-2' : 'justify-center gap-2 px-2.5 py-1.5',
          ].join(' ')}
        >
          {theme === 'dark' ? <SunIcon className={ICON_CLASS} /> : <MoonIcon className={ICON_CLASS} />}
          {!collapsed && <span>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>}
        </button>
        <button
          type="button"
          aria-label="Open settings"
          data-testid="rail-settings"
          data-sidebar-nav-item
          data-sidebar-nav-order="5"
          onClick={onOpenSettings}
          className={[
            'flex w-full items-center rounded-md border border-border text-xs font-medium text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors duration-100',
            collapsed ? 'justify-center px-2 py-2' : 'justify-center gap-2 px-2.5 py-1.5',
          ].join(' ')}
        >
          <SettingsIcon className={ICON_CLASS} />
          {!collapsed && <span>Settings</span>}
        </button>
        <button
          type="button"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          data-testid="sidebar-collapse-toggle"
          onClick={onToggleCollapsed}
          className={[
            'flex w-full items-center rounded-md border border-border text-xs text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground transition-colors duration-100',
            collapsed ? 'justify-center px-2 py-2' : 'justify-between px-2.5 py-1.5',
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
