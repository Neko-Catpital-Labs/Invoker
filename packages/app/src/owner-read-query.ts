import type { Orchestrator } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import { buildReviewGateQueryResponse } from './review-gate-query.js';

/**
 * Shared dispatcher for the owner's `headless.query` IPC channel.
 *
 * Non-owner processes read database-derived state by sending a
 * `{ kind }`-discriminated request over IpcBus; the writable owner answers it.
 * The GUI owner and the standalone headless owner share this single mapping so
 * every read kind (the sole-owner rearchitecture routes every read through here)
 * is defined once and answered the same way by both owners.
 *
 * Per-owner differences (owner label, task-delta stream sequence, the standalone
 * keep-alive ping, the ui-perf source) are injected via `buildOwnerReadQueryHandlers`.
 * Param-bearing read kinds take their argument from the request body.
 *
 * Each handler returns a JSON object; scalar/array reads are wrapped (e.g.
 * `{ events }`, `{ output }`) so the wire response is always a record and the
 * client unwraps the named field.
 */
export interface OwnerReadQueryHandlers {
  ownerModeLabel: string;
  onActivity?: () => void;
  getUiPerfStats: () => Record<string, unknown>;
  resetUiPerfStats: () => void;
  getQueueStatus: () => Record<string, unknown>;
  getWorkflowStatus: () => Record<string, unknown>;
  getTasksSnapshot: (opts: { refresh: boolean }) => Record<string, unknown>;
  getActionGraphSnapshot: () => Record<string, unknown>;
  listWorkflows: () => unknown[];
  loadWorkflowBundle: (workflowId: string) => Record<string, unknown>;
  getReviewGate: (workflowId: string) => unknown;
  getEvents: (taskId: string) => unknown[];
  getTaskById: (taskId: string) => unknown;
  getTaskOutput: (taskId: string) => string;
  getOutputChunks: (taskId: string) => unknown[];
  getOutputTail: (taskId: string) => unknown;
  replayOutput: (taskId: string, fromOffset: number) => unknown;
  getAllCompletedTasks: () => unknown[];
}

export function answerOwnerReadQuery(
  req: unknown,
  handlers: OwnerReadQueryHandlers,
): Record<string, unknown> {
  const body = (req ?? {}) as {
    kind?: string;
    reset?: boolean;
    workflowId?: string;
    taskId?: string;
    fromOffset?: number;
  };
  const { kind, reset } = body;
  handlers.onActivity?.();
  const requiredString = (value: unknown, name: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Missing headless query parameter: ${name}`);
    }
    return value;
  };
  const replayOffset = (value: unknown): number => {
    const offset = Number(value ?? 0);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error('Invalid headless query parameter: fromOffset');
    }
    return offset;
  };

  switch (kind) {
    case 'ui-perf':
      if (reset) handlers.resetUiPerfStats();
      return { ownerMode: handlers.ownerModeLabel, ...handlers.getUiPerfStats() };
    case 'queue':
      return handlers.getQueueStatus();
    case 'workflow-status':
      return handlers.getWorkflowStatus();
    case 'tasks':
      return handlers.getTasksSnapshot({ refresh: false });
    case 'task-graph-refresh':
      return handlers.getTasksSnapshot({ refresh: true });
    case 'action-graph':
      return handlers.getActionGraphSnapshot();
    case 'workflows':
      return { workflows: handlers.listWorkflows() };
    case 'workflow':
      return handlers.loadWorkflowBundle(requiredString(body.workflowId, 'workflowId'));
    case 'review-gate':
      return { reviewGate: handlers.getReviewGate(requiredString(body.workflowId, 'workflowId')) ?? null };
    case 'events':
      return { events: handlers.getEvents(requiredString(body.taskId, 'taskId')) };
    case 'task-by-id':
      return { task: handlers.getTaskById(requiredString(body.taskId, 'taskId')) ?? null };
    case 'task-output':
      return { output: handlers.getTaskOutput(requiredString(body.taskId, 'taskId')) };
    case 'output-chunks':
      return { chunks: handlers.getOutputChunks(requiredString(body.taskId, 'taskId')) };
    case 'output-tail':
      return { tail: handlers.getOutputTail(requiredString(body.taskId, 'taskId')) ?? null };
    case 'replay-output':
      return { chunks: handlers.replayOutput(requiredString(body.taskId, 'taskId'), replayOffset(body.fromOffset)) };
    case 'all-completed-tasks':
      return { tasks: handlers.getAllCompletedTasks() };
    default:
      throw new Error(`Unsupported headless query: ${String(kind)}`);
  }
}

type ReadOrchestrator = Pick<
  Orchestrator,
  'getQueueStatus' | 'getWorkflowStatus' | 'getAllTasks' | 'syncAllFromDb' | 'syncFromDb'
>;
type ReadPersistence = Pick<
  SQLiteAdapter,
  | 'listWorkflows'
  | 'loadWorkflow'
  | 'loadTasks'
  | 'loadTask'
  | 'getEvents'
  | 'getTaskOutput'
  | 'getOutputChunks'
  | 'getOutputTail'
  | 'replayOutputFrom'
  | 'loadAllCompletedTasks'
>;

export interface OwnerReadQueryDeps {
  ownerModeLabel: string;
  onActivity?: () => void;
  getUiPerfStats: () => Record<string, unknown>;
  resetUiPerfStats: () => void;
  getStreamSequence: () => number;
  resolveInvokerHomeRoot: () => string;
  orchestrator: ReadOrchestrator;
  persistence: ReadPersistence;
  /** App-level action-graph projection (needs invokerConfig, which lives in the app). */
  getActionGraphSnapshot: () => Record<string, unknown>;
}

/** Build the handler set both owners pass to {@link answerOwnerReadQuery}. */
export function buildOwnerReadQueryHandlers(deps: OwnerReadQueryDeps): OwnerReadQueryHandlers {
  const { orchestrator, persistence } = deps;
  return {
    ownerModeLabel: deps.ownerModeLabel,
    onActivity: deps.onActivity,
    getUiPerfStats: deps.getUiPerfStats,
    resetUiPerfStats: deps.resetUiPerfStats,
    getQueueStatus: () => orchestrator.getQueueStatus() as unknown as Record<string, unknown>,
    getWorkflowStatus: () => orchestrator.getWorkflowStatus() as unknown as Record<string, unknown>,
    getTasksSnapshot: ({ refresh }) => {
      if (refresh) orchestrator.syncAllFromDb();
      return {
        tasks: orchestrator.getAllTasks(),
        workflows: persistence.listWorkflows(),
        streamSequence: deps.getStreamSequence(),
        invokerHomeRoot: deps.resolveInvokerHomeRoot(),
      };
    },
    getActionGraphSnapshot: deps.getActionGraphSnapshot,
    listWorkflows: () => persistence.listWorkflows(),
    loadWorkflowBundle: (workflowId: string) => {
      orchestrator.syncFromDb(workflowId);
      return {
        workflow: persistence.loadWorkflow(workflowId),
        tasks: persistence.loadTasks(workflowId),
      };
    },
    getReviewGate: (workflowId: string) => {
      const workflow = persistence.loadWorkflow(workflowId);
      if (!workflow) return null;
      return buildReviewGateQueryResponse({ workflowId, workflow, tasks: persistence.loadTasks(workflowId) });
    },
    getEvents: (taskId: string) => persistence.getEvents(taskId),
    getTaskById: (taskId: string) => persistence.loadTask(taskId),
    getTaskOutput: (taskId: string) => persistence.getTaskOutput(taskId),
    getOutputChunks: (taskId: string) => persistence.getOutputChunks(taskId),
    getOutputTail: (taskId: string) => persistence.getOutputTail(taskId),
    replayOutput: (taskId: string, fromOffset: number) => persistence.replayOutputFrom(taskId, fromOffset),
    getAllCompletedTasks: () => persistence.loadAllCompletedTasks(),
  };
}
