import { useEffect, useMemo, useState } from 'react';
import type { ReviewGateArtifact, ReviewGateQueryResponse, TaskState, WorkflowMeta } from '../types.js';
import { getEffectiveVisualStatus, getStatusColor } from '../lib/colors.js';
import { workflowStatusVisual } from '../lib/workflow-status.js';
import { subscribeVisibilityAwarePoll } from '../hooks/visibilityAwarePoll.js';
import { mutationFailureTitle } from '../lib/mutation-failure-display.js';
import { WorkerDecisionsSection } from './WorkerDecisionsSection.js';
import type { ActionGraphNode, ExecutionDefaults, ExecutionHarnessOption, WorkflowMutationFailedEvent } from '@invoker/contracts';

type MergeMode = 'manual' | 'automatic' | 'external_review';
type TaskLogLevel = 'debug' | 'info' | 'warn' | 'error';

interface TaskAuditEvent {
  id?: number;
  eventType: string;
  payload?: string;
  createdAt?: string;
}

interface TaskLogEntry {
  id: string;
  level: TaskLogLevel;
  message: string;
  detail?: string;
  createdAt?: string;
}

const SAFE_LOG_DETAIL_KEYS = new Set([
  'actionType',
  'agentCount',
  'agentName',
  'artifactCount',
  'attempt',
  'attemptCount',
  'baseBranch',
  'branch',
  'featureBranch',
  'reviewId',
  'reviewUrl',
  'status',
  'reason',
  'route',
  'workerKind',
  'workflowId',
]);

const LOG_LEVELS: readonly TaskLogLevel[] = ['debug', 'info', 'warn', 'error'];
const LOG_LEVEL_RANK: Record<TaskLogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isTaskLogLevel(value: unknown): value is TaskLogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

function parseEventPayload(payload: string | undefined): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function inferLogLevel(event: TaskAuditEvent, payload: Record<string, unknown> | undefined): TaskLogLevel {
  if (isTaskLogLevel(payload?.level)) return payload.level;
  if (event.eventType.includes('failed') || event.eventType.includes('error')) return 'error';
  if (event.eventType.includes('warn')) return 'warn';
  if (event.eventType.startsWith('debug.')) return 'debug';
  return 'info';
}

function formatLogDetail(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!SAFE_LOG_DETAIL_KEYS.has(key)) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    detail[key] = value;
  }
  return Object.keys(detail).length > 0 ? JSON.stringify(detail) : undefined;
}

function formatWorkerActionMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const workerKind = typeof payload.workerKind === 'string' && payload.workerKind.trim()
    ? payload.workerKind
    : 'worker';
  const actionType = typeof payload.actionType === 'string' && payload.actionType.trim()
    ? payload.actionType
    : 'action';
  const status = typeof payload.status === 'string' && payload.status.trim()
    ? payload.status
    : 'recorded';
  const summary = typeof payload.summary === 'string' && payload.summary.trim()
    ? payload.summary
    : undefined;
  return summary
    ? `${workerKind}/${actionType} ${status}: ${summary}`
    : `${workerKind}/${actionType} ${status}`;
}

function taskEventToLogEntry(event: TaskAuditEvent, index: number): TaskLogEntry {
  const payload = parseEventPayload(event.payload);
  const payloadMessage = payload?.message;
  const workerActionMessage = event.eventType === 'task.worker_action'
    ? formatWorkerActionMessage(payload)
    : undefined;
  const message = workerActionMessage
    ?? (typeof payloadMessage === 'string' && payloadMessage.trim()
      ? payloadMessage
      : event.eventType);
  return {
    id: String(event.id ?? `${event.eventType}-${event.createdAt ?? index}`),
    level: inferLogLevel(event, payload),
    message,
    detail: formatLogDetail(payload),
    createdAt: event.createdAt,
  };
}

interface WorkspaceRecreateNotice {
  message: string;
  workflowId?: string;
}

function workspaceRecreateNoticeFromEvent(event: TaskAuditEvent): WorkspaceRecreateNotice | undefined {
  if (event.eventType !== 'task.workflow_recreated') return undefined;
  const payload = parseEventPayload(event.payload);
  const payloadMessage = payload?.message;
  const workflowId = typeof payload?.workflowId === 'string' ? payload.workflowId : undefined;
  return {
    message: typeof payloadMessage === 'string' && payloadMessage.trim()
      ? payloadMessage
      : 'Invoker recreated this workflow from a fresh workspace because the old workspace was missing.',
    workflowId,
  };
}

function logLevelClass(level: TaskLogLevel): string {
  switch (level) {
    case 'error':
      return 'text-red-300';
    case 'warn':
      return 'text-amber-300';
    case 'debug':
      return 'text-slate-300';
    case 'info':
    default:
      return 'text-muted-foreground';
  }
}

function formatEventTime(value: string | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString();
}

interface WorkflowInspectorProps {
  workflow: WorkflowMeta | null;
  task: TaskState | null;
  workflowTasks?: Map<string, TaskState>;
  reviewGate?: ReviewGateQueryResponse | null;
  remoteTargets?: string[];
  executionPools?: string[];
  executionHarnesses?: ExecutionHarnessOption[];
  executionDefaults?: ExecutionDefaults | null;
  actionNode?: ActionGraphNode | null;
  mutationFailure?: WorkflowMutationFailedEvent | null;
  collapsed: boolean;
  advancedExpanded: boolean;
  onEditType?: (taskId: string, runnerKind: string, poolMemberId?: string) => void;
  onEditPool?: (taskId: string, poolId: string) => void;
  onEditAgent?: (taskId: string, agentName: string) => void;
  onEditModel?: (taskId: string, executionModel: string | null) => void;
  onEditPrompt?: (taskId: string, newPrompt: string) => void;
  onEditCommand?: (taskId: string, newCommand: string) => void;
  onApprove?: (task: TaskState) => void;
  onReject?: (task: TaskState) => void;
  onSetMergeBranch?: (workflowId: string, baseBranch: string) => Promise<void>;
  onSetMergeMode?: (workflowId: string, mergeMode: MergeMode) => Promise<void>;
  onToggleCollapsed: () => void;
  onToggleAdvanced: () => void;
}

function formatStatus(value: string | undefined): string {
  return value?.replaceAll('_', ' ') ?? 'unknown';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function mergeModeValue(value: string | undefined): MergeMode {
  return value === 'automatic' || value === 'external_review' ? value : 'manual';
}

function hasReviewUrlStatus(status: string | undefined): boolean {
  return status === 'review_ready' || status === 'completed';
}

function getMergeNodeReviewUrl(
  tasks: Map<string, TaskState> | undefined,
): string | undefined {
  if (!tasks) return undefined;
  for (const candidate of tasks.values()) {
    if (
      candidate.config.isMergeNode &&
      hasReviewUrlStatus(candidate.status) &&
      candidate.execution.reviewUrl
    ) {
      return candidate.execution.reviewUrl;
    }
  }
  return undefined;
}


function artifactLabel(artifact: ReviewGateArtifact): string {
  return artifact.title || artifact.url || (artifact.providerId ? `#${artifact.providerId}` : artifact.id);
}

function ReviewGateStackSection({ reviewGate }: { reviewGate: ReviewGateQueryResponse }): JSX.Element {
  const artifacts = reviewGate.artifacts;
  const hasConnectors = artifacts.length > 1;
  return (
    <section className="rounded border border-border bg-secondary/70 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pull Request Stack</div>
      {artifacts.length === 0 ? (
        <div className="mt-2 text-xs text-muted-foreground">No pull requests yet</div>
      ) : (
        <ol className="mt-2 space-y-2">
          {artifacts.map((artifact, index) => (
            <li key={artifact.id} className="relative pl-5 text-xs">
              {hasConnectors && (
                <span
                  aria-hidden="true"
                  data-testid="review-gate-connector"
                  className="absolute left-1 top-0 h-full border-l border-border-strong before:absolute before:left-0 before:top-3 before:w-3 before:border-t before:border-border-strong"
                />
              )}
              <div className="rounded border border-border bg-card/80 px-2 py-1">
                {artifact.url ? (
                  <a
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="inspector-pr-link"
                    data-sidebar-nav-item
                    data-sidebar-nav-order={String(30 + index)}
                    className="text-foreground underline break-words"
                  >
                    {artifactLabel(artifact)}
                  </a>
                ) : (
                  <div className="text-foreground">{artifactLabel(artifact)}</div>
                )}
                <div className="mt-1 text-[11px] text-muted-foreground">{formatStatus(artifact.status)}</div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function WorkflowInspector({
  workflow,
  task,
  workflowTasks,
  reviewGate,
  executionPools,
  executionHarnesses,
  executionDefaults,
  actionNode,
  mutationFailure,
  collapsed,
  advancedExpanded,
  onEditPool,
  onEditAgent,
  onEditModel,
  onEditPrompt,
  onEditCommand,
  onApprove,
  onReject,
  onSetMergeBranch,
  onSetMergeMode,
  onToggleCollapsed,
  onToggleAdvanced,
}: WorkflowInspectorProps): JSX.Element {
  const [isEditingPrompt, setIsEditingPrompt] = useState(false);
  const [editPromptValue, setEditPromptValue] = useState('');
  const [isEditingCommand, setIsEditingCommand] = useState(false);
  const [editCommandValue, setEditCommandValue] = useState('');
  const [branchValue, setBranchValue] = useState('');
  const [taskLogEvents, setTaskLogEvents] = useState<TaskAuditEvent[]>([]);
  const [taskLogError, setTaskLogError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(true);
  const [logLevelFilter, setLogLevelFilter] = useState<TaskLogLevel>('info');

  useEffect(() => {
    setIsEditingPrompt(false);
    setEditPromptValue(task?.config.prompt ?? '');
    setIsEditingCommand(false);
    setEditCommandValue(task?.config.command ?? '');
  }, [task?.id, task?.config.prompt, task?.config.command]);

  useEffect(() => {
    setBranchValue(workflow?.baseBranch ?? task?.config.featureBranch ?? '');
  }, [workflow?.baseBranch, task?.config.featureBranch, task?.id]);

  useEffect(() => {
    if (!task) {
      setTaskLogEvents([]);
      setTaskLogError(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;
    const refreshEvents = () => {
      if (inFlight) return;
      const eventsPromise = window.invoker?.getEvents(task.id, { limit: 50, sortBy: 'desc' });
      if (!eventsPromise) return;

      inFlight = true;
      eventsPromise
        .then((events) => {
          if (cancelled) return;
          setTaskLogEvents(events);
          setTaskLogError(null);
        })
        .catch(() => {
          if (!cancelled) setTaskLogError('Could not load logs. Retrying…');
        })
        .finally(() => {
          inFlight = false;
        });
    };

    setTaskLogEvents([]);
    setTaskLogError(null);

    const shouldPoll = task.status === 'running' || task.status === 'fixing_with_ai';
    if (!shouldPoll) {
      refreshEvents();
      return () => {
        cancelled = true;
      };
    }
    // Visibility-gated so the 2.5s log poll pauses while backgrounded and cannot
    // land in the refocus turn; subscribe fires the initial load immediately.
    const unsubscribe = subscribeVisibilityAwarePoll(refreshEvents, 2_500, { restoreDelayMs: 350 });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [task?.id, task?.status]);

  const taskVisualStatus = task ? getEffectiveVisualStatus(task.status, task.execution) : null;
  const taskColors = taskVisualStatus ? getStatusColor(taskVisualStatus) : null;
  const workflowVisual = workflow ? workflowStatusVisual(workflow.status) : null;
  const reviewUrl =
    hasReviewUrlStatus(workflow?.status)
      ? task
        ? task.config.isMergeNode && hasReviewUrlStatus(task.status)
          ? task.execution.reviewUrl
          : undefined
        : getMergeNodeReviewUrl(workflowTasks)
      : undefined;
  const workflowTitle = workflow ? workflow.name || workflow.id : null;
  const nodeTitle = task?.description ?? workflowTitle ?? 'No node selected';
  const showsWorkflowMergeDetails = Boolean(!task && workflow?.id && workflow.onFinish === 'pull_request');
  const isMergeNode = Boolean((task?.config.isMergeNode || showsWorkflowMergeDetails) && workflow?.id);
  const currentAgent = task?.config.executionAgent ?? task?.execution.agentName ?? executionDefaults?.executionAgent ?? 'codex';
  const selectedHarness = useMemo(
    () => executionHarnesses?.find((harness) => harness.name === currentAgent) ?? null,
    [currentAgent, executionHarnesses],
  );
  const currentModel = task?.config.executionModel ?? '';
  const agentOptions = useMemo(() => {
    const names = new Set((executionHarnesses ?? []).map((harness) => harness.name));
    names.add(currentAgent);
    return [...names].filter(Boolean);
  }, [currentAgent, executionHarnesses]);
  const modelOptions = useMemo(() => {
    const models = new Map((selectedHarness?.supportedModels ?? []).map((model) => [model.id, model]));
    if (currentModel && !models.has(currentModel)) {
      models.set(currentModel, { id: currentModel, label: currentModel });
    }
    return [...models.values()];
  }, [currentModel, selectedHarness]);
  const defaultModelLabel = useMemo(() => {
    if (currentAgent !== executionDefaults?.executionAgent || !executionDefaults.executionModel) return 'Default';
    const label = selectedHarness?.supportedModels.find((model) => model.id === executionDefaults.executionModel)?.label
      ?? executionDefaults.executionModel;
    return `Default (${label})`;
  }, [currentAgent, executionDefaults, selectedHarness]);
  const poolOptions = useMemo(() => {
    const ids = new Set(executionPools ?? []);
    if (task?.config.poolId) ids.add(task.config.poolId);
    return [...ids].filter(Boolean);
  }, [executionPools, task?.config.poolId]);
  const isTaskBusy = task?.status === 'running' || task?.status === 'fixing_with_ai';
  const hasPrompt = task?.config.prompt !== undefined;
  const hasCommand = task?.config.command !== undefined;
  const hasExecutableContent = Boolean(hasPrompt || hasCommand);
  const canEditPrompt = Boolean(task?.config.prompt !== undefined && onEditPrompt && !isTaskBusy);
  const canEditCommand = Boolean(task?.config.command !== undefined && onEditCommand && !isTaskBusy);
  const statusBorder = taskColors?.border ?? workflowVisual?.borderClass ?? 'border-border';
  const statusText = taskColors?.text ?? workflowVisual?.textClass ?? 'text-muted-foreground';
  const statusDot = taskColors?.dot ?? '';
  const isFixApproval = Boolean(task?.execution.pendingFixError);
  const showApprovalActions = Boolean(
    task
    && (task.status === 'awaiting_approval' || task.status === 'review_ready')
    && onApprove
    && onReject,
  );
  const statusHeading = task ? 'Task Status' : 'Status';
  const workspaceRecreateNotice = taskLogEvents
    .map(workspaceRecreateNoticeFromEvent)
    .find((notice): notice is WorkspaceRecreateNotice => Boolean(notice));
  const logEntries = taskLogEvents.map(taskEventToLogEntry);
  const visibleLogEntries = logEntries
    .filter((entry) => LOG_LEVEL_RANK[entry.level] >= LOG_LEVEL_RANK[logLevelFilter]);
  const selectedWorkflowId = workflow?.id ?? task?.config.workflowId;
  const timelineDecisionTitle = task ? 'Worker decisions' : 'Workflow decisions';
  const timelineDecisionEmptyText = task
    ? 'No worker decisions for this task yet.'
    : 'No workflow-level worker decisions recorded yet.';
  const savePrompt = () => {
    if (task && onEditPrompt && editPromptValue !== (task.config.prompt ?? '')) {
      onEditPrompt(task.id, editPromptValue);
    }
    setIsEditingPrompt(false);
  };

  const saveCommand = () => {
    if (task && onEditCommand && editCommandValue !== (task.config.command ?? '')) {
      onEditCommand(task.id, editCommandValue);
    }
    setIsEditingCommand(false);
  };

  const startEditingPromptOrCommand = () => {
    if (task?.config.prompt !== undefined && canEditPrompt) {
      setEditPromptValue(task.config.prompt);
      setIsEditingPrompt(true);
    } else if (task?.config.command !== undefined && canEditCommand) {
      setEditCommandValue(task.config.command);
      setIsEditingCommand(true);
    }
  };

  const saveBranch = () => {
    const trimmed = branchValue.trim();
    if (workflow?.id && trimmed && trimmed !== (workflow.baseBranch ?? '')) {
      void onSetMergeBranch?.(workflow.id, trimmed);
    }
  };

  if (collapsed) {
    return (
      <aside className="h-full w-full border-l border-border bg-background flex items-start justify-center pt-3">
        <button
          onClick={onToggleCollapsed}
          aria-label="Maximize inspector"
          data-sidebar-nav-item
          data-sidebar-nav-order="10"
          className="rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-secondary"
        >
          Show
        </button>
      </aside>
    );
  }

  return (
    <aside className="h-full w-full border-l border-border bg-background flex flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="min-w-0">
          <h2 data-testid="workflow-inspector-title" className="text-sm font-medium text-foreground truncate max-w-[270px]">{nodeTitle}</h2>
          {workflow && task && (
            <div className="text-[11px] text-muted-foreground truncate max-w-[270px]">{workflow.name}</div>
          )}
        </div>
        <button
          onClick={onToggleCollapsed}
          aria-label="Minimize inspector"
          data-sidebar-nav-item
          data-sidebar-nav-order="10"
          className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary"
        >
          Minimize
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-3 text-sm">
        <section className={`rounded border p-3 ${statusBorder} bg-secondary/70`}>
          <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">{statusHeading}</h3>
          <div data-testid="workflow-inspector-status-label" className={`mt-1 inline-flex items-center gap-2 text-xs ${statusText}`}>
            {taskColors && (
              <span className={`h-2 w-2 rounded-full ${statusDot} ${task?.status === 'running' ? 'animate-pulse' : ''}`} />
            )}
            {formatStatus(task?.status ?? workflow?.status)}
          </div>
          {task?.execution.error && (
            <div className="mt-3 border-t border-red-500/30 pt-2">
              <h3 className="text-[11px] uppercase tracking-wide text-red-300">Error</h3>
              <p className="mt-1 text-xs text-red-300 break-words">{task.execution.error}</p>
              {task.execution.exitCode !== undefined && task.execution.exitCode !== 0 && (
                <p className="mt-2 text-xs text-red-300">Exit code: {task.execution.exitCode}</p>
              )}
            </div>
          )}
          {!task?.execution.error && task?.execution.exitCode !== undefined && task.execution.exitCode !== 0 && (
            <p className="mt-2 text-xs text-red-300">Exit code: {task.execution.exitCode}</p>
          )}
          {task?.execution.pendingFixError && (
            <div
              data-testid="inspector-pending-fix-error"
              className="mt-3 rounded border border-amber-500/40 bg-amber-950/40 p-2"
            >
              <h3 className="text-[11px] uppercase tracking-wide text-amber-200">Fix Error</h3>
              <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-amber-100">
                {task.execution.pendingFixError}
              </pre>
            </div>
          )}
          {showApprovalActions && task && (
            <div className="mt-3 flex gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => onApprove?.(task)}
                data-testid="inspector-approve-button"
                data-sidebar-nav-item
                data-sidebar-nav-order="15"
                className="flex-1 rounded bg-green-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-green-500"
              >
                {isFixApproval ? 'Approve Fix' : task.config.isMergeNode ? 'Approve Merge' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => onReject?.(task)}
                data-testid="inspector-reject-button"
                data-sidebar-nav-item
                data-sidebar-nav-order="16"
                className="flex-1 rounded bg-red-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-red-500"
              >
                {isFixApproval ? 'Reject Fix' : task.config.isMergeNode ? 'Reject Merge' : 'Reject'}
              </button>
            </div>
          )}
        </section>

        {mutationFailure && (
          <section data-testid="task-mutation-failure-detail" className="rounded border border-amber-700 bg-amber-950/40 p-3">
            <h3 className="text-[11px] uppercase tracking-wide text-amber-200">
              {mutationFailureTitle(mutationFailure)}
            </h3>
            <p className="mt-1 text-xs text-amber-100 break-words">{mutationFailure.message}</p>
            <p className="mt-2 text-[11px] text-amber-300">Channel: {mutationFailure.channel}</p>
            {mutationFailure.headlessCommand && (
              <p className="mt-1 text-[11px] text-amber-300">Command: {mutationFailure.headlessCommand}</p>
            )}
          </section>
        )}

        {workspaceRecreateNotice && (
          <section data-testid="workspace-recreate-notice" className="rounded border border-amber-700 bg-amber-950/40 p-3">
            <h3 className="text-[11px] uppercase tracking-wide text-amber-200">Workspace recreated</h3>
            <p className="mt-1 text-xs text-amber-100 break-words">{workspaceRecreateNotice.message}</p>
            {workspaceRecreateNotice.workflowId && (
              <p className="mt-2 text-[11px] text-amber-300">Workflow: {workspaceRecreateNotice.workflowId}</p>
            )}
          </section>
        )}

        {actionNode && (
          <section data-testid="workflow-inspector-action-node" className="rounded border border-border-strong bg-card p-3">
            <h3 className="text-[11px] uppercase tracking-wide text-muted-foreground">Action Graph Detail</h3>
            <div className="mt-1 text-sm font-medium text-foreground break-words">{actionNode.label}</div>
            <div data-testid="workflow-inspector-action-node-status" className="mt-2 inline-flex rounded border border-border-strong px-2 py-1 text-[10px] font-semibold uppercase text-foreground">
              {actionNode.status.toUpperCase()}
            </div>
            <dl className="mt-3 space-y-1 text-xs">
              {[
                ['type', actionNode.type],
                ['status', actionNode.status],
                ['taskId', actionNode.taskId],
                ['attemptId', actionNode.attemptId],
                ['intentId', actionNode.intentId],
                ['ownerId', actionNode.ownerId],
                ['createdAt', actionNode.createdAt],
                ['startedAt', actionNode.startedAt],
                ['completedAt', actionNode.completedAt],
                ['heartbeatAt', actionNode.heartbeatAt],
                ['leaseExpiresAt', actionNode.leaseExpiresAt],
              ].filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => (
                <div key={String(key)} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-all text-right text-foreground">{String(value)}</dd>
                </div>
              ))}
              {actionNode.durations && Object.entries(actionNode.durations).map(([key, value]) => (
                <div key={`duration-${key}`} className="flex justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-all text-right text-foreground">{String(value)}</dd>
                </div>
              ))}
            </dl>
            {actionNode.latestError && (
              <div className="mt-3 text-xs text-red-300 break-words">{actionNode.latestError}</div>
            )}
            {actionNode.suggestedNextAction && (
              <div className="mt-3 text-xs text-foreground break-words">{actionNode.suggestedNextAction}</div>
            )}
            {actionNode.history && actionNode.history.length > 0 && (
              <div className="mt-3 space-y-1 border-t border-border pt-2">
                {[...actionNode.history].reverse().map((entry) => (
                  <div key={entry.id} className="text-[11px] text-muted-foreground">
                    <span className="text-muted-foreground">{entry.timestamp}</span> {entry.source}: {entry.message}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {task && !task.config.isMergeNode && onEditPool && (
          <section className="rounded border border-border bg-secondary/70 p-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Executor Pool</span>
              <select
                value={task.config.poolId ?? ''}
                onChange={(event) => {
                  if (event.target.value) onEditPool(task.id, event.target.value);
                }}
                disabled={isTaskBusy || poolOptions.length === 0}
                className="min-w-0 max-w-[190px] rounded border border-border-strong bg-muted px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
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

        {task?.config.prompt && onEditAgent && (
          <section className="rounded border border-border bg-secondary/70 p-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">AI Agent</span>
              <select
                value={currentAgent}
                onChange={(event) => onEditAgent(task.id, event.target.value)}
                disabled={isTaskBusy || agentOptions.length === 0}
                className="min-w-0 max-w-[190px] rounded border border-border-strong bg-muted px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="execution-agent-select"
              >
                {agentOptions.map((agentName) => (
                  <option key={agentName} value={agentName}>{capitalize(agentName)}</option>
                ))}
              </select>
            </label>
          </section>
        )}
        {task?.config.prompt && onEditModel && modelOptions.length > 0 && (
          <section className="rounded border border-border bg-secondary/70 p-3">
            <label className="flex items-center justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">AI Model</span>
              <select
                value={currentModel}
                onChange={(event) => onEditModel(task.id, event.target.value || null)}
                disabled={isTaskBusy}
                className="min-w-0 max-w-[190px] rounded border border-border-strong bg-muted px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                data-testid="execution-model-select"
              >
                <option value="">{defaultModelLabel}</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.label}</option>
                ))}
              </select>
            </label>
          </section>
        )}

        {isMergeNode && (onSetMergeBranch || onSetMergeMode) && (
          <section className="rounded border border-border bg-secondary/70 p-3 space-y-3">
            {onSetMergeBranch && (
              <label className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Target Branch</span>
                <input
                  data-testid="target-branch-input"
                  value={branchValue}
                  onChange={(event) => setBranchValue(event.target.value)}
                  onBlur={saveBranch}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      (event.target as HTMLInputElement).blur();
                    }
                    if (event.key === 'Escape') {
                      setBranchValue(workflow?.baseBranch ?? '');
                    }
                  }}
                  className="min-w-0 max-w-[190px] rounded border border-border-strong bg-muted px-2 py-1 text-right font-mono text-xs text-foreground focus:border-border-strong focus:outline-none"
                />
              </label>
            )}
            {onSetMergeMode && workflow?.id && (
              <label className="flex items-center justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Merge mode</span>
                <select
                  value={mergeModeValue(workflow.mergeMode)}
                  onChange={(event) => void onSetMergeMode(workflow.id, event.target.value as MergeMode)}
                  disabled={isTaskBusy}
                  className="min-w-0 max-w-[190px] rounded border border-border-strong bg-muted px-2 py-1 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="merge-mode-select"
                >
                  <option value="manual">Manual</option>
                  <option value="automatic">Automatic</option>
                  <option value="external_review">External review (GitHub)</option>
                </select>
              </label>
            )}
            {workflow?.repoUrl && (
              <div className="flex items-start justify-between gap-3">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">PR target repo</span>
                <span className="max-w-[210px] break-all text-right text-xs text-foreground">
                  {workflow.repoUrl.replace(/^https?:\/\//, '')}
                </span>
              </div>
            )}
          </section>
        )}

        {hasExecutableContent && (
          <section className="rounded border border-border bg-secondary/70 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              {hasPrompt ? 'Prompt' : 'Command'}
            </div>
            {isEditingPrompt && task?.config.prompt !== undefined ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={editPromptValue}
                  onChange={(event) => setEditPromptValue(event.target.value)}
                  rows={5}
                  className="w-full resize-y rounded border border-border-strong bg-card p-2 text-xs text-foreground focus:outline-none"
                  data-testid="edit-prompt-input"
                />
                <div className="flex gap-2">
                  <button data-testid="save-prompt-btn" onClick={savePrompt} className="flex-1 rounded bg-primary text-primary-foreground px-2 py-1 text-xs text-white hover:bg-primary/90">
                    Save & Re-run
                  </button>
                  <button onClick={() => setIsEditingPrompt(false)} className="flex-1 rounded bg-muted px-2 py-1 text-xs text-foreground hover:bg-accent">
                    Cancel
                  </button>
                </div>
              </div>
            ) : isEditingCommand && task?.config.command !== undefined ? (
              <div className="mt-2 space-y-2">
                <textarea
                  value={editCommandValue}
                  onChange={(event) => setEditCommandValue(event.target.value)}
                  rows={4}
                  className="w-full resize-y rounded border border-border-strong bg-card p-2 font-mono text-xs text-green-300 focus:outline-none"
                  data-testid="edit-command-input"
                />
                <div className="flex gap-2">
                  <button data-testid="save-command-btn" onClick={saveCommand} className="flex-1 rounded bg-primary text-primary-foreground px-2 py-1 text-xs text-white hover:bg-primary/90">
                    Save & Re-run
                  </button>
                  <button onClick={() => setIsEditingCommand(false)} className="flex-1 rounded bg-muted px-2 py-1 text-xs text-foreground hover:bg-accent">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={`mt-2 rounded border p-2 text-xs leading-relaxed ${
                  canEditPrompt || canEditCommand
                    ? 'cursor-pointer border-border-strong bg-card hover:border-border-strong'
                    : 'cursor-text border-border bg-card'
                }`}
                onClick={startEditingPromptOrCommand}
                onDoubleClick={startEditingPromptOrCommand}
                onDoubleClickCapture={startEditingPromptOrCommand}
                data-testid="command-display"
                data-sidebar-nav-item
                data-sidebar-nav-order="20"
                tabIndex={0}
              >
                <div data-testid="prompt-command-display" onClick={startEditingPromptOrCommand} onDoubleClick={startEditingPromptOrCommand}>
                  {hasPrompt ? (
                    <p className="whitespace-pre-wrap break-words text-foreground">{task?.config.prompt}</p>
                  ) : (
                    <code className="whitespace-pre-wrap break-words font-mono text-green-300">{task?.config.command}</code>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {reviewGate ? (
          <ReviewGateStackSection reviewGate={reviewGate} />
        ) : reviewUrl && (
          <section className="rounded border border-border bg-secondary/70 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Pull Request</div>
            <a
              href={reviewUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="inspector-pr-link"
              data-sidebar-nav-item
              data-sidebar-nav-order="30"
              className="mt-1 block text-xs text-foreground underline break-all"
            >
              {reviewUrl}
            </a>
          </section>
        )}

        {(task || selectedWorkflowId) && (
          <section className="rounded border border-border bg-secondary/70" data-testid="task-logs-section">
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <button
                onClick={() => setShowLogs(!showLogs)}
                className="text-left text-[11px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
                data-testid="task-logs-toggle"
                aria-expanded={showLogs}
              >
                Timeline {showLogs ? '▲' : '▼'}
              </button>
              {task ? (
                <label className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  Level
                  <select
                    value={logLevelFilter}
                    onChange={(event) => setLogLevelFilter(event.target.value as TaskLogLevel)}
                    className="rounded border border-border-strong bg-muted px-2 py-1 text-xs normal-case text-foreground focus:border-border-strong focus:outline-none"
                    data-testid="task-log-level-select"
                  >
                    <option value="debug">Debug+</option>
                    <option value="info">Info+</option>
                    <option value="warn">Warn+</option>
                    <option value="error">Error</option>
                  </select>
                </label>
              ) : null}
            </div>
            {showLogs && (
              <div className="space-y-3 border-t border-border px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {task
                    ? 'Task events first. Worker decisions below. This is the fastest way to see retries, skips, and AI fix attempts.'
                    : 'Workflow-level worker decisions. Select a task for the event-by-event task timeline.'}
                </p>
                {task ? (
                  <div>
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">Task events</div>
                    {taskLogError && (
                      <p className="mb-2 rounded border border-amber-800 bg-amber-950/30 px-2 py-1 text-xs text-amber-300" data-testid="task-log-error">
                        {taskLogError}
                      </p>
                    )}
                    {visibleLogEntries.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No timeline entries at this level.</p>
                    ) : (
                      <div className="space-y-0">
                        {visibleLogEntries.slice(0, 20).map((entry, index) => (
                          <div
                            key={entry.id}
                            className={`${index === 0 ? '' : 'border-t border-border/40'} py-2`}
                            data-testid="task-log-entry"
                          >
                            <div className="flex items-start gap-2">
                              <span className={`shrink-0 pt-0.5 text-[10px] font-medium uppercase ${logLevelClass(entry.level)}`}>
                                {entry.level}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-baseline justify-between gap-2">
                                  <p className="break-words text-xs text-foreground">{entry.message}</p>
                                  {entry.createdAt && (
                                    <span className="shrink-0 text-[10px] text-muted-foreground">{formatEventTime(entry.createdAt)}</span>
                                  )}
                                </div>
                                {entry.detail && (
                                  <code className="mt-1 block break-all text-[10px] text-muted-foreground">{entry.detail}</code>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : null}
                {selectedWorkflowId ? (
                  <WorkerDecisionsSection
                    workflowId={selectedWorkflowId}
                    taskId={task?.id}
                    title={timelineDecisionTitle}
                    emptyText={timelineDecisionEmptyText}
                  />
                ) : null}
              </div>
            )}
          </section>
        )}

        <section className="rounded border border-border bg-secondary/70">
          <button
            onClick={onToggleAdvanced}
            data-testid="inspector-advanced-disclosure"
            data-sidebar-nav-item
            data-sidebar-nav-order="90"
            data-sidebar-expandable="true"
            aria-expanded={advancedExpanded}
            className="w-full px-3 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground hover:bg-secondary"
          >
            Advanced metadata {advancedExpanded ? '▲' : '▼'}
          </button>
          {advancedExpanded && (
            <div className="border-t border-border px-3 py-2 space-y-1 text-xs text-muted-foreground">
              <div>workflow id: {workflow?.id ?? 'n/a'}</div>
              <div>task id: {task?.id ?? 'n/a'}</div>
              <div>target branch: {workflow?.featureBranch ?? task?.config.featureBranch ?? 'n/a'}</div>
              <div>base branch: {workflow?.baseBranch ?? 'n/a'}</div>
              <div>heartbeat: {String(task?.execution.lastHeartbeatAt ?? 'n/a')}</div>
              <div>pool id: {task?.config.poolId ?? 'n/a'}</div>
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
