import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalModal } from '../components/ApprovalModal.js';
import { InputModal } from '../components/InputModal.js';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'Run unit tests',
    status: 'awaiting_approval',
    dependencies: [],
    createdAt: new Date(),
    config: {},
    execution: {},
    ...overrides,
  };
}

beforeEach(() => {
  (window as any).invoker = {
    getClaudeSession: vi.fn().mockResolvedValue(null),
    getAgentSession: vi.fn().mockResolvedValue(null),
    getEvents: vi.fn().mockResolvedValue([]),
  };
});

afterEach(() => {
  delete (window as any).invoker;
});

/*
 * Bug 4 repro: modal primary-action handlers do not guard against
 * back-to-back clicks. `handleApprove` synchronously calls the parent
 * callback and then `onClose`, but the button is still mounted for the
 * millisecond between the two synchronous events, so a shaky click
 * dispatches the callback twice. In production this queues two IPC
 * approvals against the same task id.
 */
describe('Modal double-click guard (regression)', () => {
  it('ApprovalModal approve button fires onApprove once on rapid double-click', () => {
    const onApprove = vi.fn();
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={onApprove}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('InputModal submit button fires onSubmit once on rapid double-click', () => {
    const onSubmit = vi.fn();
    render(
      <InputModal
        task={makeTask({ execution: { inputPrompt: 'Give input' } })}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: 'ready' } });
    const btn = screen.getByRole('button', { name: 'Submit' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
