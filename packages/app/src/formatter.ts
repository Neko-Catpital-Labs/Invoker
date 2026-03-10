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
};

const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: '○',
  running: '●',
  completed: '✓',
  failed: '✗',
  needs_input: '?',
  blocked: '⊘',
  awaiting_approval: '⏳',
};

// ── Public API ───────────────────────────────────────────────

/**
 * Format a single task as a colored one-line summary.
 *
 * Example: "  ✓ greet — Say hello [completed]"
 */
export function formatTaskStatus(task: TaskState): string {
  const color = STATUS_COLORS[task.status] ?? RESET;
  const icon = STATUS_ICONS[task.status] ?? '?';
  return `${color}  ${icon} ${BOLD}${task.id}${RESET}${color} — ${task.description} [${task.status}]${RESET}`;
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
