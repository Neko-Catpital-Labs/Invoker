/**
 * Friendly display labels for the raw `event_type` values written to the SQLite
 * `events` table. Used by the History timeline to render human-readable rows
 * while keeping the raw name available on hover.
 */

const RAW_TO_FRIENDLY: Record<string, string> = {
  'task.created': 'Task created',
  'task.pending': 'Pending',
  'task.running': 'Running',
  'task.completed': 'Completed',
  'task.failed': 'Failed',
  'task.cancelled': 'Cancelled',
  'task.blocked': 'Blocked',
  'task.stale': 'Marked stale',
  'task.deferred': 'Deferred',
  'task.needs_input': 'Needs input',
  'task.awaiting_approval': 'Awaiting approval',
  'task.fixing_with_ai': 'Submitted for autofix',
  'task.updated': 'Task updated',
  'task.prepared_for_new_attempt': 'Prepared for retry',
  'task.forked_from': 'Forked from another task',
  'task.experiment_results_recorded': 'Experiment results recorded',
  'task.external_dependency_policy_updated': 'External dependency policy updated',
  'task.external_dependency_detached': 'External dependency detached',
  'task.workflow_detached': 'Workflow detached',
  'task.executor.routed': 'Executor routed',
  'task.executor.selected': 'Executor selected',
  'task.executor.deferred': 'Executor deferred',
  'task.launch_dispatch_enqueued': 'Launch dispatch enqueued',
  'task.launch_dispatch_claimed': 'Launch dispatch claimed',
  'task.launch_claimed': 'Launch claimed',
  'task.metadata.updated': 'Metadata updated',
  'task.log': 'Log',
  'workflow.mutation.timing': 'Workflow mutation timing',
  'debug.auto-fix': 'Autofix debug',
  // Legacy short names (pre-2025-01 event vocabulary):
  started: 'Started',
  completed: 'Completed',
};

const TERMINAL_STATUS_LIKE = new Set<string>([
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.stale',
  'completed',
]);

const RUNNING_STATUS_LIKE = new Set<string>([
  'task.running',
  'started',
]);

const AUTOFIX_LIKE = new Set<string>([
  'task.fixing_with_ai',
  'debug.auto-fix',
]);

const ATTENTION_LIKE = new Set<string>([
  'task.awaiting_approval',
  'task.needs_input',
  'task.blocked',
  'task.deferred',
]);

export function friendlyEventLabel(eventType: string): string {
  if (RAW_TO_FRIENDLY[eventType]) return RAW_TO_FRIENDLY[eventType];
  // Fall back to a title-cased version of the last segment.
  const last = eventType.split(/[.:_-]/).pop() ?? eventType;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export type EventCategory = 'terminal-success' | 'terminal-failure' | 'running' | 'autofix' | 'attention' | 'info';

export function categorizeEvent(eventType: string): EventCategory {
  if (eventType === 'task.completed' || eventType === 'completed') return 'terminal-success';
  if (eventType === 'task.failed' || eventType === 'task.cancelled' || eventType === 'task.stale') return 'terminal-failure';
  if (RUNNING_STATUS_LIKE.has(eventType)) return 'running';
  if (AUTOFIX_LIKE.has(eventType)) return 'autofix';
  if (ATTENTION_LIKE.has(eventType)) return 'attention';
  if (TERMINAL_STATUS_LIKE.has(eventType)) return 'terminal-success';
  return 'info';
}

/**
 * When the payload carries a discriminating `phase` field (as `debug.auto-fix`
 * events do), surface it after the friendly label. Returns undefined when the
 * payload has no useful discriminator.
 */
export function payloadDetail(payload: string | undefined): string | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (typeof parsed.phase === 'string') return parsed.phase;
    if (typeof parsed.reason === 'string') return parsed.reason;
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Extract a short error message from an event payload, if any. Used to display
 * exit code / error text next to failure entries in the timeline.
 */
export function payloadErrorSummary(payload: string | undefined): { exitCode?: number; error?: string } | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const exitCode =
      typeof parsed.exitCode === 'number'
        ? parsed.exitCode
        : typeof (parsed.execution as Record<string, unknown> | undefined)?.exitCode === 'number'
          ? (parsed.execution as Record<string, unknown>).exitCode as number
          : undefined;
    const error =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof (parsed.execution as Record<string, unknown> | undefined)?.error === 'string'
          ? (parsed.execution as Record<string, unknown>).error as string
          : undefined;
    if (exitCode === undefined && !error) return undefined;
    return { exitCode, error };
  } catch {
    return undefined;
  }
}
