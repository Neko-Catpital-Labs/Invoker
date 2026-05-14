import type { ExternalGatePolicyUpdate, TaskState, WorkflowMeta } from '../types.js';
import { getEffectiveVisualStatus, getStatusColor } from '../lib/colors.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';
import { TaskPanel } from './TaskPanel.js';

interface WorkflowInspectorProps {
  workflow: WorkflowMeta | null;
  task: TaskState | null;
  workflowTasks?: Map<string, TaskState>;
  remoteTargets?: string[];
  executionPools?: string[];
  executionAgents?: string[];
  actionNode?: unknown;
  collapsed: boolean;
  advancedExpanded: boolean;
  onEditType?: (taskId: string, runnerKind: string, poolMemberId?: string) => void;
  onEditPool?: (taskId: string, poolId: string) => void;
  onEditAgent?: (taskId: string, agentName: string) => void;
  onEditPrompt?: (taskId: string, newPrompt: string) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onProvideInput?: (task: TaskState) => void;
  onApprove?: (task: TaskState) => void;
  onReject?: (task: TaskState) => void;
  onSelectExperiment?: (task: TaskState) => void;
  onSetExternalGatePolicies?: (taskId: string, updates: ExternalGatePolicyUpdate[]) => Promise<void>;
  onSetMergeBranch?: (workflowId: string, baseBranch: string) => Promise<void>;
  onToggleCollapsed: () => void;
  onToggleAdvanced: () => void;
}

function summarizePrompt(task: TaskState | null): string {
  if (!task) return 'No task selected.';
  return task.config.prompt ?? task.config.command ?? 'No prompt or command available.';
}

function formatStatus(value: string | undefined): string {
  return value?.replaceAll('_', ' ') ?? 'unknown';
}

export function WorkflowInspector({
  workflow,
  task,
  workflowTasks,
  remoteTargets,
  executionPools,
  executionAgents,
  actionNode,
  collapsed,
  advancedExpanded,
  onEditType,
  onEditPool,
  onEditAgent,
  onEditPrompt,
  onEditCommand,
  onProvideInput,
  onApprove,
  onReject,
  onSelectExperiment,
  onSetExternalGatePolicies,
  onSetMergeBranch,
  onToggleCollapsed,
  onToggleAdvanced,
}: WorkflowInspectorProps): JSX.Element {
  if (collapsed) {
    return (
      <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex items-start justify-center pt-3">
        <button
          onClick={onToggleCollapsed}
          aria-label="Maximize inspector"
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

  if (task) {
    const taskVisualStatus = getEffectiveVisualStatus(task.status, task.execution);
    const taskColors = getStatusColor(taskVisualStatus);
    const poolOptions = [...new Set([...(executionPools ?? []), task.config.poolId].filter(Boolean) as string[])];
    const isTaskBusy = task.status === 'running' || task.status === 'fixing_with_ai';

    return (
      <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-300">Inspector</div>
            <div data-testid="workflow-inspector-title" className="mt-1 text-sm font-medium text-gray-100 truncate max-w-[270px]">
              {actionNode ? task.description : 'Task details'}
            </div>
            <div className="text-[11px] text-gray-400 truncate max-w-[270px]">{workflow?.name ?? task.config.workflowId ?? 'Task'}</div>
            <div data-testid="workflow-inspector-status-label" className={`mt-1 inline-flex items-center gap-2 text-xs ${taskColors.text}`}>
              <span className={`h-2 w-2 rounded-full ${taskColors.dot} ${task.status === 'running' ? 'animate-pulse' : ''}`} />
              {formatStatus(task.status)}
            </div>
          </div>
          <button
            onClick={onToggleCollapsed}
            aria-label="Minimize inspector"
            className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
          >
            Minimize
          </button>
        </div>

        {onEditPool && !task.config.isMergeNode && (
          <section className="border-b border-gray-800 bg-gray-900 px-3 py-2">
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-gray-400">Executor Pool</span>
              <select
                value={task.config.poolId ?? ''}
                onChange={(event) => {
                  if (event.target.value) onEditPool(task.id, event.target.value);
                }}
                disabled={isTaskBusy || poolOptions.length === 0}
                className="min-w-0 max-w-[190px] rounded border border-gray-600 bg-gray-700 px-2 py-1 text-xs text-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="executor-pool-select"
              >
                {!task.config.poolId && <option value="">No pool</option>}
                {poolOptions.map((poolId) => (
                  <option key={poolId} value={poolId}>{poolId}</option>
                ))}
              </select>
            </label>
          </section>
        )}

        {reviewUrl && (
          <section className="border-b border-gray-800 bg-gray-900 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-gray-400">Pull Request</div>
            <a
              href={reviewUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block text-xs text-blue-300 underline break-all"
            >
              {reviewUrl}
            </a>
          </section>
        )}

        <div className="min-h-0 flex-1">
          <TaskPanel
            task={task}
            allTasks={workflowTasks}
            baseBranch={workflow?.baseBranch}
            workflowRepoUrl={workflow?.repoUrl ?? workflow?.intermediateRepoUrl}
            remoteTargets={remoteTargets}
            executionAgents={executionAgents}
            onProvideInput={onProvideInput ?? (() => {})}
            onApprove={onApprove ?? (() => {})}
            onReject={onReject ?? (() => {})}
            onSelectExperiment={onSelectExperiment ?? (() => {})}
            onEditCommand={onEditCommand}
            onEditPrompt={onEditPrompt}
            onEditType={onEditType}
            onEditAgent={onEditAgent}
            onSetExternalGatePolicies={onSetExternalGatePolicies}
            onSetMergeBranch={onSetMergeBranch}
            mergeMode={workflow?.mergeMode}
            showApprovalActions={false}
          />
        </div>

        <section className="border-t border-gray-800 bg-gray-900">
          <button
            onClick={onToggleAdvanced}
            className="w-full px-3 py-2 text-left text-[11px] uppercase tracking-wide text-gray-300 hover:bg-gray-800"
          >
            Advanced metadata {advancedExpanded ? '▲' : '▼'}
          </button>
          {advancedExpanded && (
            <div className="border-t border-gray-700 px-3 py-2 space-y-1 text-xs text-gray-300">
              <div>workflow id: {workflow?.id ?? 'n/a'}</div>
              <div>task id: {task.id}</div>
              <div>target branch: {workflow?.featureBranch ?? task.config.featureBranch ?? 'n/a'}</div>
              <div>base branch: {workflow?.baseBranch ?? 'n/a'}</div>
              <div>heartbeat: {String(task.execution.lastHeartbeatAt ?? 'n/a')}</div>
              <div>pool id: {task.config.poolId ?? 'n/a'}</div>
            </div>
          )}
        </section>
      </aside>
    );
  }

  return (
    <aside className="h-full w-full border-l border-gray-800 bg-gray-900 flex flex-col">
      <div className="flex items-center justify-between border-b border-gray-800 px-3 py-2">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-300">Inspector</div>
          <div data-testid="workflow-inspector-title" className="text-[11px] text-gray-400 truncate max-w-[240px]">
            {workflow?.name ?? workflow?.id ?? 'No workflow selected'}
          </div>
        </div>
        <button
          onClick={onToggleCollapsed}
          aria-label="Minimize inspector"
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
          <div data-testid="workflow-inspector-status-label" className={`mt-1 text-xs ${visual?.textClass ?? 'text-gray-300'}`}>
            {workflow?.status?.replaceAll('_', ' ') ?? 'unknown'}
          </div>
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
              <div>task id: n/a</div>
              <div>target branch: {workflow?.featureBranch ?? 'n/a'}</div>
              <div>base branch: {workflow?.baseBranch ?? 'n/a'}</div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
