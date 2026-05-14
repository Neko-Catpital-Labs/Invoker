import type { TaskState, WorkflowMeta } from '../types.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';

interface WorkflowInspectorProps {
  workflow: WorkflowMeta | null;
  task: TaskState | null;
  collapsed: boolean;
  advancedExpanded: boolean;
  onToggleCollapsed: () => void;
  onToggleAdvanced: () => void;
}

function summarizePrompt(task: TaskState | null): string {
  if (!task) return 'No task selected.';
  return task.config.prompt ?? task.config.command ?? 'No prompt or command available.';
}

export function WorkflowInspector({
  workflow,
  task,
  collapsed,
  advancedExpanded,
  onToggleCollapsed,
  onToggleAdvanced,
}: WorkflowInspectorProps): JSX.Element {
  if (collapsed) {
    return (
      <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex items-start justify-center pt-3">
        <button
          onClick={onToggleCollapsed}
          className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800"
        >
          Show
        </button>
      </aside>
    );
  }

  const visual = workflow ? workflowStatusVisual(workflow.status) : null;
  const reviewUrl = task?.execution.reviewUrl;
  const agent = task?.config.executionAgent ?? task?.execution.agentName ?? 'n/a';

  return (
    <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex flex-col">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-300">Inspector</div>
          <div className="text-[11px] text-gray-400 truncate max-w-[240px]">{workflow?.name ?? workflow?.id ?? 'No workflow selected'}</div>
        </div>
        <button
          onClick={onToggleCollapsed}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          Minimize
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3 text-sm">
        <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">AI Agent</div>
          <div className="mt-1 text-gray-100">{agent}</div>
          <div className="mt-2 text-[11px] uppercase tracking-wide text-gray-400">Prompt</div>
          <p className="mt-1 text-gray-200 text-xs leading-relaxed whitespace-pre-wrap break-words">
            {summarizePrompt(task)}
          </p>
        </section>

        <section className={`rounded border p-3 ${visual?.borderClass ?? 'border-gray-700'} bg-gray-800/70`}>
          <div className="text-[11px] uppercase tracking-wide text-gray-400">Status</div>
          <div className={`mt-1 text-xs ${visual?.textClass ?? 'text-gray-300'}`}>
            {workflow?.status?.replaceAll('_', ' ') ?? 'unknown'}
          </div>
          {task?.execution.error && (
            <p className="mt-2 text-xs text-red-300 break-words">{task.execution.error}</p>
          )}
        </section>

        <section className="rounded border border-gray-700 bg-gray-800/70 p-3">
          <div className="text-[11px] uppercase tracking-wide text-gray-400">Pull Request</div>
          {reviewUrl ? (
            <a
              href={reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-xs text-blue-300 underline break-all"
            >
              {reviewUrl}
            </a>
          ) : (
            <div className="mt-1 text-xs text-gray-400">No PR linked</div>
          )}
        </section>

        <section className="rounded border border-gray-700 bg-gray-800/70">
          <button
            onClick={onToggleAdvanced}
            className="w-full px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-300 hover:bg-gray-800"
          >
            Advanced metadata {advancedExpanded ? '▲' : '▼'}
          </button>
          {advancedExpanded && (
            <div className="border-t border-gray-700 px-3 py-2 space-y-1 text-xs text-gray-300">
              <div>workflow id: {workflow?.id ?? 'n/a'}</div>
              <div>task id: {task?.id ?? 'n/a'}</div>
              <div>target branch: {workflow?.featureBranch ?? task?.config.featureBranch ?? 'n/a'}</div>
              <div>base branch: {workflow?.baseBranch ?? 'n/a'}</div>
              <div>heartbeat: {String(task?.execution.lastHeartbeatAt ?? 'n/a')}</div>
              <div>executor: {task?.config.executorType ?? 'n/a'}</div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
