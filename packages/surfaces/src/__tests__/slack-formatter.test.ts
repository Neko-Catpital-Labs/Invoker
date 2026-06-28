import { describe, it, expect } from 'vitest';
import {
  formatTaskCreated,
  formatTaskUpdated,
  formatWorkflowStatus,
  formatWorkflowProgress,
  formatExperimentSelection,
  formatError,
  formatSurfaceEvent,
} from '../slack/slack-formatter.js';
import type { SurfaceEvent } from '../surface.js';

describe('formatTaskCreated', () => {
  it('returns message with pending status', () => {
    const msg = formatTaskCreated('build', 'Build the project');
    expect(msg.text).toContain('build');
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].text!.text).toContain('build');
    expect(msg.blocks[0].text!.text).toContain('Build the project');
    expect(msg.blocks[0].text!.text).toContain('Pending');
  });
});

describe('formatTaskUpdated', () => {
  it('formats running status', () => {
    const msg = formatTaskUpdated('t1', 'running');
    expect(msg.text).toContain('Running');
    expect(msg.blocks[0].text!.text).toContain(':large_blue_circle:');
  });

  it('formats running status with phase context', () => {
    const msg = formatTaskUpdated('t1', 'running', { phase: 'launching' });
    expect(msg.blocks[0].text!.text).toContain('Running (launching)');
  });

  it('formats completed status', () => {
    const msg = formatTaskUpdated('t1', 'completed', { summary: 'All tests pass' });
    expect(msg.text).toContain('Completed');
    expect(msg.blocks[0].text!.text).toContain('All tests pass');
  });

  it('formats failed status with error', () => {
    const msg = formatTaskUpdated('t1', 'failed', { error: 'Build failed' });
    expect(msg.blocks[0].text!.text).toContain('Build failed');
    expect(msg.blocks[0].text!.text).toContain(':x:');
  });

  it('includes Approve/Reject buttons for awaiting_approval', () => {
    const msg = formatTaskUpdated('t1', 'awaiting_approval');
    expect(msg.blocks).toHaveLength(2); // section + actions
    const actions = msg.blocks[1];
    expect(actions.type).toBe('actions');
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements![0].action_id).toBe('approve:t1');
    expect(actions.elements![0].style).toBe('primary');
    expect(actions.elements![1].action_id).toBe('reject:t1');
    expect(actions.elements![1].style).toBe('danger');
  });

  it('includes Provide Input button for needs_input', () => {
    const msg = formatTaskUpdated('t1', 'needs_input', { inputPrompt: 'Which branch?' });
    expect(msg.blocks).toHaveLength(2);
    const actions = msg.blocks[1];
    expect(actions.elements).toHaveLength(1);
    expect(actions.elements![0].action_id).toBe('input:t1');
  });

  it('no action buttons for pending/running/completed/failed/blocked', () => {
    for (const status of ['pending', 'running', 'completed', 'failed', 'blocked']) {
      const msg = formatTaskUpdated('t1', status);
      expect(msg.blocks).toHaveLength(1); // section only, no actions
    }
  });

  it('handles unknown status gracefully', () => {
    const msg = formatTaskUpdated('t1', 'unknown_state');
    expect(msg.blocks).toHaveLength(1);
    expect(msg.blocks[0].text!.text).toContain('unknown_state');
  });
});

describe('formatWorkflowStatus', () => {
  it('formats all counts', () => {
    const msg = formatWorkflowStatus({
      total: 10,
      completed: 5,
      failed: 1,
      closed: 0,
      running: 2,
      pending: 2,
    });
    expect(msg.text).toContain('5/10');
    expect(msg.blocks[0].text!.text).toContain('Completed: 5');
    expect(msg.blocks[0].text!.text).toContain('Failed: 1');
    expect(msg.blocks[0].text!.text).toContain('Closed: 0');
    expect(msg.blocks[0].text!.text).toContain('Running: 2');
    expect(msg.blocks[0].text!.text).toContain('Pending: 2');
  });

  it('formats zero counts', () => {
    const msg = formatWorkflowStatus({
      total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0,
    });
    expect(msg.text).toContain('0/0');
  });
});

describe('formatWorkflowProgress', () => {
  it('renders header with percent and counts plus one row per task including the review link', () => {
    const msg = formatWorkflowProgress({
      workflowId: 'wf-1',
      name: 'My Workflow',
      percentComplete: 50,
      counts: { total: 4, completed: 2, failed: 0, closed: 0, running: 1, pending: 1 },
      tasks: [
        { id: 'build', name: 'Build', status: 'completed', reviewUrl: 'https://x/pr' },
        { id: 'test', name: 'Test', status: 'running', phase: 'executing' },
      ],
    });

    // Header section: name, percent, and the count emoji line.
    const header = msg.blocks[0];
    expect(header.type).toBe('section');
    expect(header.text!.text).toContain('My Workflow');
    expect(header.text!.text).toContain('50%');
    expect(header.text!.text).toContain(':white_check_mark:2');
    expect(header.text!.text).toContain(':large_blue_circle:1');

    // Divider then the single task-rows section.
    expect(msg.blocks[1].type).toBe('divider');
    const rows = msg.blocks[2].text!.text;
    expect(rows).toContain('*build*');
    expect(rows).toContain('<https://x/pr|PR>');
    expect(rows).toContain('*test* Running (executing)');

    expect(msg.text).toContain('50%');
    expect(msg.text).toContain('(2/4)');
  });

  it('collapses task lists longer than 40 rows', () => {
    const tasks = Array.from({ length: 45 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, status: 'pending' }));
    const msg = formatWorkflowProgress({
      workflowId: 'wf-2',
      name: 'Big',
      percentComplete: 0,
      counts: { total: 45, completed: 0, failed: 0, closed: 0, running: 0, pending: 45 },
      tasks,
    });
    const rows = msg.blocks[2].text!.text;
    expect(rows).toContain('…and 5 more');
  });

  it('appends a footer context block when prUrl/reviewState are set', () => {
    const msg = formatWorkflowProgress({
      workflowId: 'wf-3',
      name: 'WithReview',
      percentComplete: 100,
      counts: { total: 1, completed: 1, failed: 0, closed: 0, running: 0, pending: 0 },
      tasks: [{ id: 'a', name: 'A', status: 'completed' }],
      prUrl: 'https://x/pr',
      reviewState: 'approved',
    });
    const footer = msg.blocks[msg.blocks.length - 1];
    expect(footer.type).toBe('context');
    expect((footer as any).elements[0].text).toContain('approved');
    expect((footer as any).elements[0].text).toContain('<https://x/pr|PR>');
  });
});

describe('formatExperimentSelection', () => {
  it('shows experiment buttons for completed experiments', () => {
    const msg = formatExperimentSelection('recon-1', [
      { id: 'exp-a', description: 'Approach A', status: 'completed', summary: 'Works well' },
      { id: 'exp-b', description: 'Approach B', status: 'failed' },
      { id: 'exp-c', description: 'Approach C', status: 'completed' },
    ]);

    expect(msg.blocks).toHaveLength(2); // section + actions
    const actions = msg.blocks[1];
    // Only completed experiments get buttons
    expect(actions.elements).toHaveLength(2);
    expect(actions.elements![0].action_id).toBe('select:recon-1:exp-a');
    expect(actions.elements![1].action_id).toBe('select:recon-1:exp-c');
  });

  it('limits to 4 buttons', () => {
    const experiments = Array.from({ length: 6 }, (_, i) => ({
      id: `exp-${i}`, status: 'completed',
    }));
    const msg = formatExperimentSelection('recon-1', experiments);
    const actions = msg.blocks[1];
    expect(actions.elements!.length).toBeLessThanOrEqual(4);
  });
});

describe('formatError', () => {
  it('formats error message', () => {
    const msg = formatError('Something went wrong');
    expect(msg.text).toContain('Something went wrong');
    expect(msg.blocks[0].text!.text).toContain(':warning:');
  });
});

describe('formatSurfaceEvent', () => {
  it('routes task_delta created events', () => {
    const event: SurfaceEvent = {
      type: 'task_delta',
      delta: {
        type: 'created',
        task: { id: 't1', description: 'Test', status: 'pending', dependencies: [], createdAt: new Date(), config: {}, execution: {} },
      },
    };
    const msg = formatSurfaceEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('t1');
  });

  it('routes task_delta updated events', () => {
    const event: SurfaceEvent = {
      type: 'task_delta',
      delta: { type: 'updated', taskId: 't1', changes: { status: 'completed' } },
    };
    const msg = formatSurfaceEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('Completed');
  });

  it('routes execution-only phase updates as running status updates', () => {
    const event: SurfaceEvent = {
      type: 'task_delta',
      delta: { type: 'updated', taskId: 't1', changes: { execution: { phase: 'executing' } } as any },
    };
    const msg = formatSurfaceEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.blocks[0].text!.text).toContain('Running (executing)');
  });

  it('routes workflow_status events', () => {
    const event: SurfaceEvent = {
      type: 'workflow_status',
      status: { total: 3, completed: 1, failed: 0, closed: 0, running: 1, pending: 1 },
    };
    const msg = formatSurfaceEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('1/3');
  });

  it('routes error events', () => {
    const event: SurfaceEvent = { type: 'error', message: 'oops' };
    const msg = formatSurfaceEvent(event);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('oops');
  });

  it('returns null for unhandled delta types', () => {
    const event: SurfaceEvent = {
      type: 'task_delta',
      delta: { type: 'removed', taskId: 't1' } as any,
    };
    const msg = formatSurfaceEvent(event);
    expect(msg).toBeNull();
  });
});
