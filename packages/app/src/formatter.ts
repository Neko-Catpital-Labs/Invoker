/**
 * Formatter — Terminal output helpers with ANSI color codes.
 *
 * No external dependencies. Uses raw ANSI escape codes for coloring.
 */

import type { TaskState, TaskStatus } from '@invoker/workflow-core';
import type { TaskEvent, Workflow } from '@invoker/data-store';

// ── ANSI Color Codes ─────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const DIM = '\x1b[2m';

// ── Status Colors ────────────────────────────────────────────

const STATUS_COLORS: Record<TaskStatus, string> = {
  pending: DIM,
  running: YELLOW,
  fixing_with_ai: MAGENTA,
  completed: GREEN,
  failed: RED,
  needs_input: BLUE,
  review_ready: CYAN,
  blocked: DIM,
  awaiting_approval: CYAN,
  stale: DIM,
};

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '○',
  running: '●',
  fixing_with_ai: '🔧',
  completed: '✓',
  failed: '✗',
  needs_input: '?',
  review_ready: '👀',
  blocked: '⊘',
  awaiting_approval: '⏳',
  stale: '◌',
};

// ── Public API ───────────────────────────────────────────────

/**
 * Format a single task as a colored one-line summary.
 *
 * Example: "  ✓ greet — Say hello [completed]"
 */
export function formatTaskStatus(task: TaskState): string {
  const isFixing =
    task.status === 'fixing_with_ai' ||
    (task.status === 'running' && task.execution.isFixingWithAI);
  const isFixApproval = task.status === 'awaiting_approval' && task.execution.pendingFixError;
  const color = isFixing ? MAGENTA : isFixApproval ? YELLOW : (STATUS_COLORS[task.status] ?? RESET);
  const icon = isFixing ? '🔧' : isFixApproval ? '🔧' : (STATUS_ICONS[task.status] ?? '?');
  const label = isFixing ? 'fixing_with_ai' : isFixApproval ? 'fix_approval' : task.status;
  const phaseSuffix = task.status === 'running' && task.execution.phase
    ? ` (phase=${task.execution.phase})`
    : '';
  const conflictSuffix = task.execution.mergeConflict
    ? ` ${DIM}[conflict: ${task.execution.mergeConflict.conflictFiles.join(', ')}]${RESET}`
    : '';
  return `${color}  ${icon} ${BOLD}${task.id}${RESET}${color} — ${task.description} [${label}]${phaseSuffix}${RESET}${conflictSuffix}`;
}

/**
 * Format workflow status as a summary line.
 *
 * Example: "Workflow: 3 total | 2 completed | 0 failed | 1 running | 0 pending"
 */
export function formatWorkflowStatus(status: {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
}): string {
  const parts = [
    `${BOLD}Workflow:${RESET} ${status.total} total`,
    `${GREEN}${status.completed} completed${RESET}`,
    `${RED}${status.failed} failed${RESET}`,
    `${YELLOW}${status.running} running${RESET}`,
    `${DIM}${status.pending} pending${RESET}`,
  ];
  return parts.join(' | ');
}

/**
 * Format a list of workflows as a table-like output.
 *
 * Each workflow gets one line: "  id — name [status] (created)"
 */
export function formatWorkflowList(
  workflows: Array<{ id: string; name: string; status: string; createdAt: string; updatedAt: string }>,
): string {
  if (workflows.length === 0) {
    return `${DIM}No workflows found.${RESET}`;
  }

  const WORKFLOW_STATUS_COLORS: Record<string, string> = {
    running: YELLOW,
    completed: GREEN,
    failed: RED,
  };

  const lines = workflows.map((wf) => {
    const color = WORKFLOW_STATUS_COLORS[wf.status] ?? DIM;
    return `${color}  ${BOLD}${wf.id}${RESET}${color} — ${wf.name} [${wf.status}] ${DIM}(${wf.createdAt})${RESET}`;
  });

  return lines.join('\n');
}

/**
 * Format an event log as a table-like output.
 *
 * Each event gets one line: "[timestamp] taskId: eventType payload"
 */
export function formatEventLog(events: TaskEvent[]): string {
  if (events.length === 0) {
    return `${DIM}No events recorded.${RESET}`;
  }

  const lines = events.map((event) => {
    const timestamp = event.createdAt;
    const payload = event.payload ? ` ${event.payload}` : '';
    return `${DIM}[${timestamp}]${RESET} ${BOLD}${event.taskId}${RESET}: ${event.eventType}${payload}`;
  });

  return lines.join('\n');
}

/**
 * Format queue status showing concurrency and running/queued tasks.
 *
 * Example output:
 * ```
 * Concurrency: 2 / 3 running
 *
 * Running (2):
 *   ● task-a — Run tests
 *   ● task-b — Build frontend
 *
 * Queued (1):
 *   ○ task-c — Deploy staging [pri: 0]
 * ```
 */
export function formatQueueStatus(status: {
  maxConcurrency: number;
  runningCount: number;
  running: Array<{ taskId: string; description: string }>;
  queued: Array<{ taskId: string; priority: number; description: string }>;
}): string {
  const lines: string[] = [];

  // Concurrency header
  lines.push(
    `${BOLD}Concurrency:${RESET} ${status.runningCount} / ${status.maxConcurrency} running`,
  );
  lines.push('');

  // Running section
  lines.push(`${BOLD}${YELLOW}Running (${status.running.length}):${RESET}`);
  if (status.running.length === 0) {
    lines.push(`${DIM}  (none)${RESET}`);
  } else {
    for (const task of status.running) {
      lines.push(
        `${YELLOW}  ● ${BOLD}${task.taskId}${RESET}${YELLOW} — ${task.description}${RESET}`,
      );
    }
  }
  lines.push('');

  // Queued section
  lines.push(`${BOLD}${CYAN}Queued (${status.queued.length}):${RESET}`);
  if (status.queued.length === 0) {
    lines.push(`${DIM}  (none)${RESET}`);
  } else {
    for (const task of status.queued) {
      lines.push(
        `${CYAN}  ○ ${BOLD}${task.taskId}${RESET}${CYAN} — ${task.description} ${DIM}[pri: ${task.priority}]${RESET}`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}

// ── Output Format Type ──────────────────────────────────────

export type OutputFormat = 'text' | 'label' | 'json' | 'jsonl';

// ── Serializers ─────────────────────────────────────────────

/**
 * Convert a Workflow to a plain JSON-safe object.
 * All Date-like fields are kept as ISO strings (already strings from DB).
 */
export function serializeWorkflow(wf: Workflow): Record<string, unknown> {
  return {
    id: wf.id,
    name: wf.name,
    status: wf.status,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
    ...(wf.description != null && { description: wf.description }),
    ...(wf.visualProof != null && { visualProof: wf.visualProof }),
    ...(wf.planFile != null && { planFile: wf.planFile }),
    ...(wf.repoUrl != null && { repoUrl: wf.repoUrl }),
    ...(wf.branch != null && { branch: wf.branch }),
    ...(wf.onFinish != null && { onFinish: wf.onFinish }),
    ...(wf.baseBranch != null && { baseBranch: wf.baseBranch }),
    ...(wf.featureBranch != null && { featureBranch: wf.featureBranch }),
    ...(wf.mergeMode != null && { mergeMode: wf.mergeMode }),
    ...(wf.reviewProvider != null && { reviewProvider: wf.reviewProvider }),
    ...(wf.generation != null && { generation: wf.generation }),
  };
}

/**
 * Convert a TaskState to a plain JSON-safe object with config/execution subsets.
 * Dates are converted to ISO strings.
 */
export function serializeTask(task: TaskState): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (task.config.workflowId != null) config.workflowId = task.config.workflowId;
  if (task.config.command != null) config.command = task.config.command;
  if (task.config.prompt != null) config.prompt = task.config.prompt;
  if (task.config.executorType != null) config.executorType = task.config.executorType;
  if (task.config.isMergeNode != null) config.isMergeNode = task.config.isMergeNode;
  if (task.config.executionAgent != null) config.executionAgent = task.config.executionAgent;
  if (task.config.featureBranch != null) config.featureBranch = task.config.featureBranch;

  const execution: Record<string, unknown> = {};
  if (task.execution.branch != null) execution.branch = task.execution.branch;
  if (task.execution.commit != null) execution.commit = task.execution.commit;
  if (task.execution.error != null) execution.error = task.execution.error;
  if (task.execution.exitCode != null) execution.exitCode = task.execution.exitCode;
  if (task.execution.reviewUrl != null) execution.reviewUrl = task.execution.reviewUrl;
  if (task.execution.agentSessionId != null) execution.agentSessionId = task.execution.agentSessionId;
  if (task.execution.lastAgentSessionId != null) execution.lastAgentSessionId = task.execution.lastAgentSessionId;
  if (task.execution.agentName != null) execution.agentName = task.execution.agentName;
  if (task.execution.lastAgentName != null) execution.lastAgentName = task.execution.lastAgentName;
  if (task.execution.phase != null) execution.phase = task.execution.phase;
  if (task.execution.startedAt != null) execution.startedAt = task.execution.startedAt instanceof Date ? task.execution.startedAt.toISOString() : task.execution.startedAt;
  if (task.execution.completedAt != null) execution.completedAt = task.execution.completedAt instanceof Date ? task.execution.completedAt.toISOString() : task.execution.completedAt;
  if (task.execution.launchStartedAt != null) execution.launchStartedAt = task.execution.launchStartedAt instanceof Date ? task.execution.launchStartedAt.toISOString() : task.execution.launchStartedAt;
  if (task.execution.launchCompletedAt != null) execution.launchCompletedAt = task.execution.launchCompletedAt instanceof Date ? task.execution.launchCompletedAt.toISOString() : task.execution.launchCompletedAt;
  if (task.execution.lastHeartbeatAt != null) execution.lastHeartbeatAt = task.execution.lastHeartbeatAt instanceof Date ? task.execution.lastHeartbeatAt.toISOString() : task.execution.lastHeartbeatAt;
  if (task.execution.mergeConflict != null) {
    execution.mergeConflict = {
      failedBranch: task.execution.mergeConflict.failedBranch,
      conflictFiles: [...task.execution.mergeConflict.conflictFiles],
    };
  }

  return {
    id: task.id,
    description: task.description,
    status: task.status,
    dependencies: [...task.dependencies],
    createdAt: task.createdAt instanceof Date ? task.createdAt.toISOString() : task.createdAt,
    config,
    execution,
  };
}

/**
 * Convert a TaskEvent to a plain JSON-safe object.
 */
export function serializeEvent(event: TaskEvent): Record<string, unknown> {
  return {
    id: event.id,
    taskId: event.taskId,
    eventType: event.eventType,
    ...(event.payload != null && { payload: event.payload }),
    createdAt: event.createdAt,
  };
}

// ── Format Emitters ─────────────────────────────────────────

/**
 * One ID per line, no decoration. For piping to xargs/while-read.
 */
export function formatAsLabel(items: Array<{ id: string }>): string {
  return items.map(item => item.id).join('\n');
}

/**
 * Compact JSON array.
 */
export function formatAsJson(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * One JSON object per line (NDJSON). For streaming and large result sets.
 */
export function formatAsJsonl(items: unknown[]): string {
  return items.map(item => JSON.stringify(item)).join('\n');
}
