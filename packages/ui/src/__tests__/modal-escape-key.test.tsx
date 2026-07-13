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

describe('Modal Escape-to-close', () => {
  it('ApprovalModal closes on Escape', () => {
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

  it('InputModal closes on Escape', () => {
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

  it('ExperimentModal closes on Escape', () => {
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

  it('ReplaceTaskModal closes on Escape', () => {
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
