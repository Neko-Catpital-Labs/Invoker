/**
 * Formatter — Terminal output helpers with ANSI color codes.
 *
 * No external dependencies. Uses raw ANSI escape codes for coloring.
 */

import type { TaskState, TaskStatus } from '@invoker/core';
import type { TaskEvent } from '@invoker/persistence';

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
  completed: GREEN,
  failed: RED,
  needs_input: BLUE,
  blocked: DIM,
  awaiting_approval: CYAN,
  stale: DIM,
};

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
  needs_input: '?',
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
  const isFixing = task.status === 'running' && task.execution.isFixingWithAI;
  const isFixApproval = task.status === 'awaiting_approval' && task.execution.pendingFixError;
  const color = isFixing ? MAGENTA : isFixApproval ? YELLOW : (STATUS_COLORS[task.status] ?? RESET);
  const icon = isFixing ? '🔧' : isFixApproval ? '🔧' : (STATUS_ICONS[task.status] ?? '?');
  const label = isFixing ? 'fixing_with_ai' : isFixApproval ? 'fix_approval' : task.status;
  return `${color}  ${icon} ${BOLD}${task.id}${RESET}${color} — ${task.description} [${label}]${RESET}`;
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
 * Format queue status showing utilization and running/queued tasks.
 *
 * Example output:
 * ```
 * Utilization: 75/100 (75%)
 *
 * Running (2):
 *   ● task-a — Run tests [util: 50]
 *   ● task-b — Build frontend [util: 25]
 *
 * Queued (1):
 *   ○ task-c — Deploy staging [util: 50, pri: 0]
 * ```
 */
export function formatQueueStatus(status: {
  maxUtilization: number;
  runningUtilization: number;
  running: Array<{ taskId: string; utilization: number; description: string }>;
  queued: Array<{ taskId: string; priority: number; utilization: number; description: string }>;
}): string {
  const utilizationPct = status.maxUtilization > 0
    ? Math.round((status.runningUtilization / status.maxUtilization) * 100)
    : 0;

  const lines: string[] = [];

  // Utilization header
  lines.push(
    `${BOLD}Utilization:${RESET} ${status.runningUtilization}/${status.maxUtilization} (${utilizationPct}%)`,
  );
  lines.push('');

  // Running section
  lines.push(`${BOLD}${YELLOW}Running (${status.running.length}):${RESET}`);
  if (status.running.length === 0) {
    lines.push(`${DIM}  (none)${RESET}`);
  } else {
    for (const task of status.running) {
      lines.push(
        `${YELLOW}  ● ${BOLD}${task.taskId}${RESET}${YELLOW} — ${task.description} ${DIM}[util: ${task.utilization}]${RESET}`,
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
        `${CYAN}  ○ ${BOLD}${task.taskId}${RESET}${CYAN} — ${task.description} ${DIM}[util: ${task.utilization}, pri: ${task.priority}]${RESET}`,
      );
    }
  }
  lines.push('');

  return lines.join('\n');
}
