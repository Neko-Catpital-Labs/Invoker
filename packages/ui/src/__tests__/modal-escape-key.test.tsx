import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ApprovalModal } from '../components/ApprovalModal.js';
import { InputModal } from '../components/InputModal.js';
import { ExperimentModal } from '../components/ExperimentModal.js';
import { ReplaceTaskModal } from '../components/ReplaceTaskModal.js';
import type { TaskState } from '../types.js';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    description: 'Test task',
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

// Repro: when a modal is open, pressing Escape should close it — this is
// standard keyboard-accessibility behavior. On master the modals do not have
// their own Escape handlers, and App.tsx's global keyboard handler explicitly
// short-circuits when a modal is active, so Escape is a dead key. Each test
// is marked `.fails` so the failing assertion documents the current behavior
// without turning CI red. The fix slice removes the `.fails` marker after
// adding the local keydown handler.

describe('Modal Escape-to-close (regression)', () => {
  it.fails('ApprovalModal closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ApprovalModal
        task={makeTask()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.fails('InputModal closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <InputModal
        task={makeTask({ status: 'awaiting_input', execution: { inputRequest: { taskId: 'task-1', prompt: 'p' } } })}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.fails('ExperimentModal closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ExperimentModal
        task={makeTask({
          status: 'awaiting_experiment_selection',
          execution: {
            experimentResults: [
              { id: 'exp-1', status: 'succeeded', summary: 'ok' } as any,
            ],
          },
        })}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.fails('ReplaceTaskModal closes on Escape', () => {
    const onClose = vi.fn();
    render(
      <ReplaceTaskModal
        task={makeTask()}
        onSubmit={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
