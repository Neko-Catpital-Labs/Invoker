import type { QueueStatus } from '@invoker/contracts';
import type { TaskState, WorkflowMeta } from '../types.js';
import type { SidebarSurface } from '../lib/workflow-progress-surfaces.js';
import { getAttentionTaskEntries, getRunningTaskEntries, getSortedWorkflows } from '../lib/workflow-progress-surfaces.js';

interface LeftStatusColumnProps {
  workflows: Map<string, WorkflowMeta>;
  tasks: Map<string, TaskState>;
  queueStatus: QueueStatus | null;
  selectedSurface: SidebarSurface;
  onSelectSurface: (surface: SidebarSurface) => void;
  onOpenSettings: () => void;
}

function navButtonClass(selected: boolean): string {
  return [
    'flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors',
    selected
      ? 'bg-gray-800/90 text-white shadow-sm'
      : 'text-gray-300 hover:bg-gray-900/80 hover:text-white',
  ].join(' ');
}

export function LeftStatusColumn({
  workflows,
  tasks,
  queueStatus,
  selectedSurface,
  onSelectSurface,
  onOpenSettings,
}: LeftStatusColumnProps): JSX.Element {
  const workflowEntries = getSortedWorkflows(workflows, tasks);
  const attentionEntries = getAttentionTaskEntries(tasks, workflows);
  const runningEntries = getRunningTaskEntries(tasks, workflows, queueStatus);

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-gray-800 bg-gray-950/85 px-3 py-4 text-sm text-gray-200">
      <button
        type="button"
        data-testid="sidebar-home"
        data-sidebar-nav-item
        data-sidebar-nav-order="1"
        onClick={() => onSelectSurface('home')}
        className="rounded-xl px-3 py-2 text-left hover:bg-gray-900/80"
      >
        <div className={`text-base font-semibold ${selectedSurface === 'home' ? 'text-white' : 'text-gray-100'}`}>Invoker</div>
        <div className="mt-1 text-xs text-gray-500">Home</div>
      </button>

      <div className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-[0.24em] text-gray-500">Library</div>
      <nav className="mt-2 space-y-1">
        <button
          type="button"
          data-testid="sidebar-workflows"
          data-sidebar-nav-item
          data-sidebar-nav-order="2"
          onClick={() => onSelectSurface('workflows')}
          className={navButtonClass(selectedSurface === 'workflows')}
        >
          <span>Workflows</span>
          <span className="text-xs text-gray-500">{workflowEntries.length}</span>
        </button>
        <button
          type="button"
          data-testid="sidebar-attention"
          data-sidebar-nav-item
          data-sidebar-nav-order="3"
          onClick={() => onSelectSurface('attention')}
          className={navButtonClass(selectedSurface === 'attention')}
        >
          <span>Needs Attention</span>
          <span className="text-xs text-gray-500">{attentionEntries.length}</span>
        </button>
        <button
          type="button"
          data-testid="sidebar-running"
          data-sidebar-nav-item
          data-sidebar-nav-order="4"
          onClick={() => onSelectSurface('running')}
          className={navButtonClass(selectedSurface === 'running')}
        >
          <span>Running</span>
          <span className="text-xs text-gray-500">{runningEntries.length}</span>
        </button>
      </nav>

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

      <div className="border-t border-gray-800 px-3 pt-3">
        <button
          type="button"
          data-testid="rail-settings"
          data-sidebar-nav-item
          data-sidebar-nav-order="5"
          onClick={onOpenSettings}
          className="flex w-full items-center justify-center rounded-lg border border-gray-700 px-3 py-2 text-xs font-medium text-gray-200 hover:bg-gray-800"
        >
          Settings
        </button>
      </div>
    </aside>
  );
}
