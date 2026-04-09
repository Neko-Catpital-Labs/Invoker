import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskPanel } from '../components/TaskPanel.js';
import type { TaskState } from '../types.js';

function makeTask(
  overrides: Partial<TaskState> & {
    command?: string;
    prompt?: string;
  } = {},
): TaskState {
  const { command, prompt, ...rest } = overrides;
  return {
    id: 'error-test',
    description: 'Test task',
    status: 'failed',
    dependencies: [],
    createdAt: new Date(),
    config: { command, prompt },
    execution: {},
    ...rest,
  } as TaskState;
}

const noop = vi.fn();

describe('TaskPanel error display', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows error message and exit code when both present', () => {
    const task = makeTask({
      execution: { error: 'SSH key not found', exitCode: 1 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Error' }),
    ).toBeInTheDocument();
    expect(screen.getByText('SSH key not found')).toBeInTheDocument();
    expect(screen.getByText('Exit code: 1')).toBeInTheDocument();
  });

  it('shows only exit code when error is undefined', () => {
    const task = makeTask({
      execution: { exitCode: 1 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(screen.getByText('Exit code: 1')).toBeInTheDocument();
    expect(
      screen.queryByText('SSH key not found'),
    ).not.toBeInTheDocument();
  });

  it('shows multiline error with stack trace', () => {
    const errorMsg =
      'Familiar startup failed (ssh): bad key\n    at SshExecutor.start (ssh-executor.ts:42)';
    const task = makeTask({
      execution: { error: errorMsg, exitCode: 1 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(screen.getByText((_content, element) => {
      return element?.textContent === errorMsg;
    })).toBeInTheDocument();
  });

  it('does not show error panel for successful task', () => {
    const task = makeTask({
      status: 'completed',
      execution: { exitCode: 0 },
    });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: 'Error' }),
    ).not.toBeInTheDocument();
  });

  it('does not show error panel when exitCode is undefined', () => {
    const task = makeTask({ status: 'pending', execution: {} });
    render(
      <TaskPanel
        task={task}
        onProvideInput={noop}
        onApprove={noop}
        onReject={noop}
        onSelectExperiment={noop}
      />,
    );
    expect(
      screen.queryByRole('heading', { name: 'Error' }),
    ).not.toBeInTheDocument();
  });
});
