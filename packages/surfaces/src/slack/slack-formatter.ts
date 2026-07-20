/**
 * Slack Formatter — Converts SurfaceEvents into Slack Block Kit JSON.
 *
 * Pure functions. No Slack SDK dependency. Easy to test.
 */

import type { TaskDelta } from '@invoker/workflow-core';
import type { SurfaceEvent, WorkflowStatus, WorkflowProgress } from '../surface.js';

// ── Status Display ──────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  pending: ':white_circle:',
  running: ':large_blue_circle:',
  fixing_with_ai: ':hammer_and_wrench:',
  completed: ':white_check_mark:',
  failed: ':x:',
  closed: ':black_circle:',
  blocked: ':no_entry_sign:',
  needs_input: ':question:',
  awaiting_approval: ':raised_hand:',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  fixing_with_ai: 'Fixing with AI',
  completed: 'Completed',
  failed: 'Failed',
  closed: 'Closed',
  blocked: 'Blocked',
  needs_input: 'Needs Input',
  awaiting_approval: 'Awaiting Approval',
};

function statusEmoji(status: string): string {
  return STATUS_EMOJI[status] ?? ':grey_question:';
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}
function clampMrkdwnText(text: string, max = 3000): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}


// ── Block Kit Types (subset) ────────────────────────────────

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: Array<{ type: string; text?: { type: string; text: string; emoji?: boolean }; action_id?: string; value?: string; style?: string }>;
  block_id?: string;
}

export interface SlackMessage {
  text: string; // Fallback text for notifications
  blocks: SlackBlock[];
}

// ── Task Delta Formatting ───────────────────────────────────

export function formatTaskCreated(taskId: string, description: string): SlackMessage {
  return {
    text: clampMrkdwnText(`Task ${taskId}: ${description}`),
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: clampMrkdwnText(`${statusEmoji('pending')} *${taskId}*: ${description}\n_Status: ${statusLabel('pending')}_`),
        },
      },
    ],
  };
}

export function formatTaskUpdated(
  taskId: string,
  status: string,
  extra?: { error?: string; summary?: string; inputPrompt?: string; phase?: string },
): SlackMessage {
  const emoji = statusEmoji(status);
  const label = statusLabel(status);
  const phaseSuffix = status === 'running' && extra?.phase ? ` (${extra.phase})` : '';
  let text = `${emoji} *${taskId}*\n_Status: ${label}${phaseSuffix}_`;

  if (extra?.error) {
    text += `\n> :warning: ${extra.error}`;
  }
  if (extra?.summary) {
    text += `\n> ${extra.summary}`;
  }
  if (extra?.inputPrompt) {
    text += `\n> _${extra.inputPrompt}_`;
  }

  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: clampMrkdwnText(text) } },
  ];

  // Add action buttons for interactive states
  const actions = buildActionButtons(taskId, status);
  if (actions) {
    blocks.push(actions);
  }

  return { text: `Task ${taskId}: ${label}`, blocks };
}

function buildActionButtons(taskId: string, status: string): SlackBlock | null {
  if (status === 'awaiting_approval') {
    return {
      type: 'actions',
      block_id: `actions-${taskId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          action_id: `approve:${taskId}`,
          value: taskId,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: true },
          action_id: `reject:${taskId}`,
          value: taskId,
          style: 'danger',
        },
      ],
    };
  }

  if (status === 'needs_input') {
    return {
      type: 'actions',
      block_id: `actions-${taskId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Provide Input', emoji: true },
          action_id: `input:${taskId}`,
          value: taskId,
        },
      ],
    };
  }

  return null;
}

// ── Workflow Status Formatting ──────────────────────────────

export function formatWorkflowStatus(status: WorkflowStatus): SlackMessage {
  const lines = [
    '*Workflow Status*',
    `Total: ${status.total}`,
    `:white_check_mark: Completed: ${status.completed}`,
    `:x: Failed: ${status.failed}`,
    `:black_circle: Closed: ${status.closed}`,
    `:large_blue_circle: Running: ${status.running}`,
    `:white_circle: Pending: ${status.pending}`,
  ];

  return {
    text: clampMrkdwnText(`Workflow: ${status.completed}/${status.total} completed`),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: clampMrkdwnText(lines.join('\n')) } },
    ],
  };
}

// ── Workflow Progress Card ──────────────────────────────────

export function formatWorkflowProgress(p: WorkflowProgress): SlackMessage {
  const header = clampMrkdwnText(`*${p.name}*  ${p.percentComplete}%  ·  ${STATUS_EMOJI.completed}${p.counts.completed} ${STATUS_EMOJI.running}${p.counts.running} ${STATUS_EMOJI.pending}${p.counts.pending} ${STATUS_EMOJI.failed}${p.counts.failed}`);

  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: header } },
    { type: 'divider' },
  ];

  const MAX_ROWS = 40;
  const shown = p.tasks.slice(0, MAX_ROWS);
  const lines = shown.map((t) => {
    let line = `${statusEmoji(t.status)} *${t.id}* ${statusLabel(t.status)}`;
    if (t.status === 'running' && t.phase) line += ` (${t.phase})`;
    if (t.reviewUrl) line += ` <${t.reviewUrl}|PR>`;
    return line;
  });
  if (p.tasks.length > MAX_ROWS) {
    lines.push(`…and ${p.tasks.length - MAX_ROWS} more`);
  }
  if (lines.length > 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: clampMrkdwnText(lines.join('\n')) } });
  }

  if (p.prUrl || p.reviewState) {
    const footer = clampMrkdwnText(`${p.reviewState ?? ''}${p.prUrl ? ` · <${p.prUrl}|PR>` : ''}`.trim());
    // Context elements are text objects whose `text` is a plain string, which is
    // narrower than the shared SlackBlock element shape; cast at this boundary.
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footer }] } as unknown as SlackBlock);
  }

  return {
    text: clampMrkdwnText(`${p.name}: ${p.percentComplete}% (${p.counts.completed}/${p.counts.total})`),
    blocks,
  };
}

// ── Experiment Selection Formatting ─────────────────────────

export function formatExperimentSelection(
  reconTaskId: string,
  experiments: Array<{ id: string; description?: string; summary?: string; status?: string }>,
): SlackMessage {
  let text = ':microscope: *Experiment Selection Required*\n\n';
  for (const exp of experiments) {
    const emoji = statusEmoji(exp.status ?? 'completed');
    text += `${emoji} *${exp.id}*`;
    if (exp.description) text += `: ${exp.description}`;
    if (exp.summary) text += `\n> ${exp.summary}`;
    text += '\n';
  }

  const blocks: SlackBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: clampMrkdwnText(text) } },
    {
      type: 'actions',
      block_id: `select-${reconTaskId}`,
      elements: experiments
        .filter((e) => e.status === 'completed')
        .slice(0, 4) // Slack limits to 5 elements per actions block
        .map((exp) => ({
          type: 'button' as const,
          text: { type: 'plain_text' as const, text: exp.id },
          action_id: `select:${reconTaskId}:${exp.id}`,
          value: `${reconTaskId}:${exp.id}`,
        })),
    },
  ];

  return { text: `Select experiment for ${reconTaskId}`, blocks };
}

// ── Error Formatting ────────────────────────────────────────

export function formatError(message: string): SlackMessage {
  return {
    text: clampMrkdwnText(`Error: ${message}`),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: clampMrkdwnText(`:warning: *Error*: ${message}`) },
      },
    ],
  };
}

// ── Top-Level Event Router ──────────────────────────────────

export function formatSurfaceEvent(event: SurfaceEvent): SlackMessage | null {
  switch (event.type) {
    case 'task_delta': {
      const delta = event.delta;
      if (delta.type === 'created') {
        return formatTaskCreated(delta.task.id, delta.task.description);
      }
      if (delta.type === 'updated') {
        const status =
          (delta.changes.status as string | undefined)
          ?? (delta.changes.execution?.phase ? 'running' : undefined);
        if (!status) {
          return null;
        }
        return formatTaskUpdated(delta.taskId, status, {
          error: delta.changes.execution?.error as string | undefined,
          summary: delta.changes.config?.summary as string | undefined,
          inputPrompt: delta.changes.execution?.inputPrompt as string | undefined,
          phase: delta.changes.execution?.phase as string | undefined,
        });
      }
      return null;
    }
    case 'workflow_status':
      return formatWorkflowStatus(event.status);
    case 'workflow_progress':
      return formatWorkflowProgress(event.progress);
    case 'workflow_created':
      return null;
    case 'error':
      return formatError(event.message);
  }
}
